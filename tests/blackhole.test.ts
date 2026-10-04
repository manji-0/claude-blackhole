import type { On, SessionMessage } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Ledger, Observation } from '../hooks/memory'
import { DEFAULT_RETENTION_DAYS, retentionDays, staleSessions } from '../hooks/cleanup'
import { activeObservations, emptyLedger, fitBudgets, kindBudget, kindTokens, migrateLedger, parseJson, parseObservations } from '../hooks/memory'
import { bm25 } from '../hooks/recall'
import { searchTokens } from '../hooks/text'
import { SUMMARY_SENTINEL, buildCurrentState, buildSections, toolOneLiner, extractGoals, extractPreferences, toEntries } from '../hooks/vcc'

const CWD = '/work/app'

const use = (id: string, tool: string, input: Record<string, unknown>, text: string, isError = false) => ({
  tool_use_id: id,
  tool,
  input,
  text,
  ...(isError ? { isError: true as const } : {}),
})

/** A Japanese coding session: a goal, an edit, a failing then passing test, a commit. */
const SESSION: SessionMessage[] = [
  { role: 'user', text: 'ログイン画面のバリデーションを修正して\nメールアドレスの形式チェックを追加したい', toolUses: [] },
  {
    role: 'assistant',
    text: 'まずフォームのコードを読みます。',
    toolUses: [use('t1', 'Read', { file_path: `${CWD}/src/login.ts` }, 'export function validate() {}')],
  },
  {
    role: 'assistant',
    text: 'メールの検証を追加しました。',
    toolUses: [
      use('t2', 'Edit', { file_path: `${CWD}/src/login.ts`, old_string: 'a', new_string: 'b' }, 'The file has been updated.'),
      use('t3', 'Bash', { command: 'pnpm test' }, 'FAIL src/login.test.ts: expected true', true),
    ],
  },
  { role: 'user', text: '今後は必ず pnpm を使ってください', toolUses: [] },
  {
    role: 'assistant',
    text: 'テストを直してコミットしました。',
    toolUses: [
      use('t4', 'Bash', { command: 'pnpm test' }, 'PASS 3 tests'),
      use('t5', 'Bash', { command: 'git commit -m "fix: validate email on login"' }, '[main 1a2b3c4] fix: validate email on login\n 1 file changed'),
    ],
  },
]

type World = { files: Map<string, string>; prompts: string[]; toasts: string[]; clock: MockClock }

/** The engine beneath the plugin: files in memory, one session, a scripted worker model. */
const world = (on: On, messages: readonly SessionMessage[], reply: (prompt: string) => string, latencyMs = 0): World => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 3, 12, 0) })
  const w: World = { files: new Map(), prompts: [], toasts: [], clock }
  mock.env(on, { HOME: '/home/u' })
  on('fs.read', (_$, e) => {
    const text = w.files.get(e.path)
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) }))
  on('session.id', () => ({ value: 'sess1' }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [...messages] }))
  on('model.complete', async (_$, e) => {
    w.prompts.push(e.prompt)
    if (latencyMs > 0) await clock.sleep(latencyMs)
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true as const, text: reply(e.prompt), usage } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  return w
}

const DIR = '/home/u/.claude/blackhole/sess1'

describe('VCC extraction', () => {
  test('takes the first Japanese request as the session goal', () => {
    const goals = extractGoals(toEntries(SESSION))
    expect(goals[0]).toContain('ログイン画面のバリデーションを修正して')
  })

  test('finds a Japanese standing instruction as a preference', () => {
    expect(extractPreferences(toEntries(SESSION))).toEqual(['今後は必ず pnpm を使ってください'])
  })

  test('lists edited files relative to the working directory', () => {
    expect(buildSections(toEntries(SESSION), CWD).filesAndChanges).toEqual(['Modified: src/login.ts'])
  })

  test('reads the commit hash and message from git output', () => {
    expect(buildSections(toEntries(SESSION), CWD).commits).toEqual(['1a2b3c4 fix: validate email on login'])
  })

  test('treats a failure fixed by the same command later as resolved', () => {
    const outstanding = buildSections(toEntries(SESSION), CWD).outstandingContext
    expect(outstanding.some(l => l.includes('FAIL src/login.test.ts'))).toBe(false)
  })

  test('a request that starts with a URL becomes the new scope', () => {
    const goals = extractGoals(
      toEntries([
        { role: 'user', text: 'Claude Modって何ができるの?', toolUses: [] },
        { role: 'user', text: 'https://pi.dev/packages/pi-blackhole の仕組みを実装したい', toolUses: [] },
      ]),
    )
    expect(goals.some(g => g.startsWith('[Scope change] https://pi.dev/packages/pi-blackhole の仕組みを実装したい'))).toBe(true)
    expect(goals.every(g => g.replace(/\s*\(#\d+\)$/, '') !== '[Scope change]')).toBe(true)
  })

  test('a failed lookup followed by a working command is not outstanding', () => {
    const lookup: SessionMessage[] = [
      { role: 'user', text: '型定義を調べて', toolUses: [] },
      {
        role: 'assistant',
        text: '探します。',
        toolUses: [
          use('l1', 'Bash', { command: 'cd /x; T=types.d.ts; sed -n 1,60p $T; grep -n "store: {" $T' }, 'Exit code 2\nrg: regex parse error', true),
          use('l2', 'Bash', { command: 'grep -n store types.d.ts' }, '12: store'),
        ],
      },
    ]
    expect(buildSections(toEntries(lookup), CWD).outstandingContext).toEqual([])
  })

  test('an unfixed failure shows its message, not the exit code', () => {
    const failing: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [use('f1', 'Bash', { command: 'pnpm build' }, 'Exit code 1\nerror TS2304: Cannot find name', true)] },
    ]
    expect(buildSections(toEntries(failing), CWD).outstandingContext).toEqual(['[Bash] error TS2304: Cannot find name'])
  })

  test('a Bash call reads as its description, not its cd prefix', () => {
    const t = use('d1', 'Bash', { command: 'cd /very/long/path; T=types.d.ts; sed -n 1,60p $T', description: '型定義の先頭を読む' }, 'ok')
    expect(toolOneLiner(toEntries([{ role: 'assistant', text: '', toolUses: [t] }])[0]!.tools[0]!)).toBe('Bash: 型定義の先頭を読む — `sed -n 1,60p $T`')
  })

  test('the current state keeps the last request and reply whole', () => {
    const long = 'テストを直しました。'.repeat(40)
    const state = buildCurrentState(
      toEntries([
        ...SESSION,
        { role: 'user', text: '次はビルドも確認して', toolUses: [] },
        { role: 'assistant', text: long, toolUses: [use('s1', 'Bash', { command: 'pnpm build', description: 'ビルドする' }, 'Exit code 1\nerror TS2304', true)] },
      ]),
      CWD,
    )
    const line = (label: string) => state.find(l => l.startsWith(label))
    expect(line('Last user request')).toContain('次はビルドも確認して')
    expect(line('Last assistant reply')).toContain(long)
    expect(line('Then:')).toBe('Then: Bash: ビルドする — `pnpm build` → [tool_error] error TS2304')
    expect(buildSections(toEntries(SESSION), CWD).currentState?.[0]).toContain('今後は必ず pnpm を使ってください')
  })

  test('a short request comes with the proposal it answers and the last real request', () => {
    const state = buildCurrentState(
      toEntries([
        { role: 'user', text: 'ログイン画面のバリデーションを直して、メールアドレスの形式チェックも追加してほしい', toolUses: [] },
        { role: 'assistant', text: '案A: 正規表現で検証する。案B: ライブラリを使う。どちらにしますか？', toolUses: [] },
        { role: 'user', text: 'go', toolUses: [] },
      ]),
      CWD,
    )
    expect(state[0]).toBe('Last user request: go')
    expect(state[1]).toContain('案A: 正規表現で検証する')
    expect(state[2]).toContain('メールアドレスの形式チェック')
  })

  test('a task notification reads as an event, not a request', () => {
    const state = buildCurrentState(
      toEntries([
        { role: 'user', text: 'CI を待ってから結果を教えて。失敗していたら原因も調べてください。', toolUses: [] },
        { role: 'assistant', text: 'CI を待ちます。', toolUses: [] },
        { role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n<summary>CI watcher finished</summary>\n</task-notification>', toolUses: [] },
      ]),
      CWD,
    )
    expect(state[0]).toBe('Last event: task notification: CI watcher finished')
    expect(state.some(l => l.startsWith('Last substantive request') && l.includes('CI を待ってから'))).toBe(true)
  })

  test('reads a commit from its heredoc and leaves the hash out when git printed none', () => {
    const commits = buildSections(
      toEntries([
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('c1', 'Bash', { command: "git add -A && git commit -q -F - <<'EOF'\nfeat: add the recall tool\n\nBody.\nEOF\ngit push -q" }, 'Incremental: 2 files updated'),
            use('c2', 'Bash', { command: 'git commit -q --amend --no-edit && echo ok' }, 'ok'),
            use('c3', 'Bash', { command: 'git add crates && git commit -qm "feat(cli): standalone build\n\nBody line."' }, ''),
          ],
        },
      ]),
      CWD,
    ).commits
    expect(commits).toEqual(['feat: add the recall tool', 'feat(cli): standalone build'])
  })

  test('a retry of the same command settles a failure, and assistant prose is not scanned', () => {
    const outstanding = buildSections(
      toEntries([
        {
          role: 'assistant',
          text: 'The build failed because a type was missing.',
          toolUses: [
            use('o1', 'Bash', { command: 'cargo test -p core' }, 'Exit code 101\ntest result: FAILED', true),
            use('o2', 'Bash', { command: '/usr/bin/grep -n foo src/lib.rs' }, 'Exit code 1\n', true),
            use('o3', 'Bash', { command: 'cargo test -p core --lib' }, 'test result: ok'),
          ],
        },
      ]),
      CWD,
    ).outstandingContext
    expect(outstanding).toEqual([])
  })

  test('the brief folds tool calls into counts with their entry range', () => {
    const brief = buildSections(
      toEntries(SESSION).map((e, index) => ({ ...e, index })),
      CWD,
    ).briefTranscript
    expect(brief).toContain('[assistant #2] メールの検証を追加しました。')
    expect(brief).toContain('  (2 tool calls #2: Edit, Bash; 1 failed)')
    expect(brief).not.toContain('* ')
  })

  test('a non-zero exit with no error in its output is not outstanding', () => {
    const outstanding = buildSections(
      toEntries([
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('z1', 'Bash', { command: 'cargo test -p cli it::one 2>&1 | tail -3; grep -c TODO src/a.rs' }, 'Exit code 1\ntest result: ok. 1 passed; 0 failed; 0 ignored', true),
            use('z2', 'Bash', { command: 'rg -n search_edges crates/' }, 'Exit code 2\ncrates/graph/src/edge_lookups.rs:157:    pub fn search_edges_by_target_name(', true),
          ],
        },
      ]),
      CWD,
    ).outstandingContext
    expect(outstanding).toEqual([])
  })

  test('lists files written through Bash and leaves out task output files', () => {
    const files = buildSections(
      toEntries([
        {
          role: 'assistant',
          text: '',
          toolUses: [
            use('w1', 'Bash', { command: `cat > ${CWD}/scripts/parity.sh <<'EOF'\necho hi\nEOF` }, ''),
            use('w2', 'Bash', { command: "python3 - <<'EOF'\nimport pathlib\np=pathlib.Path(\"src/lib.rs\")\np.write_text(p.read_text().replace('a','b'))\nEOF" }, ''),
            use('w3', 'Bash', { command: "sed -i '' 's/old/new/' src/main.rs && cargo build 2>/dev/null" }, ''),
            use('w4', 'Read', { file_path: '/private/tmp/claude-501/x/tasks/b1uoocbtd.output' }, 'done'),
            use('w5', 'Bash', { command: "cd /tmp/fx && cat > a.ts <<'EOF'\nlet a = 1\nEOF" }, ''),
            use('w6', 'Write', { file_path: '/Users/u/.claude/projects/p/memory/MEMORY.md', content: 'x' }, 'File created successfully'),
          ],
        },
      ]),
      CWD,
    ).filesAndChanges
    expect(files).toEqual(['Modified: scripts/parity.sh, src/lib.rs, src/main.rs, /tmp/fx/a.ts'])
  })

  test('the current state shows results only for calls whose result tells an outcome', () => {
    const state = buildCurrentState(
      toEntries([
        { role: 'user', text: 'ビルドが通るか確認してから結果を教えてください', toolUses: [] },
        {
          role: 'assistant',
          text: '確認します。',
          toolUses: [
            use('r1', 'Bash', { command: '/usr/bin/wc -l src/lib.rs', description: '行数を数える' }, '64 src/lib.rs'),
            use('r2', 'Bash', { command: 'cargo build', description: 'ビルドする' }, 'Finished dev profile'),
          ],
        },
      ]),
      CWD,
    )
    expect(state).toContain('Then: Bash: 行数を数える — `/usr/bin/wc -l src/lib.rs`')
    expect(state).toContain('Then: Bash: ビルドする — `cargo build` → Finished dev profile')
  })

  test('keeps a failure that was never fixed', () => {
    const broken = SESSION.slice(0, 3)
    expect(buildSections(toEntries(broken), CWD).outstandingContext).toContain('[Bash] FAIL src/login.test.ts: expected true')
  })
})

describe('worker replies', () => {
  test('parses JSON inside a code fence', () => {
    expect(parseJson('ok:\n```json\n{"drop":["a"]}\n```')).toEqual({ drop: ['a'] })
  })

  test('drops observations citing ids outside the chunk', () => {
    const chunk = toEntries(SESSION).slice(0, 1)
    const id = chunk[0]?.id ?? ''
    const reply = JSON.stringify({
      observations: [
        { content: 'User asked to fix login validation.', relevance: 'high', sourceEntryIds: [id] },
        { content: 'Invented.', relevance: 'high', sourceEntryIds: ['ffffffffffff'] },
      ],
    })
    expect(parseObservations(reply, chunk, 0)?.map(o => o.content)).toEqual(['User asked to fix login validation.'])
  })

  test('ranks a Japanese query with CJK bigrams', () => {
    const docs = ['メールアドレスの検証', 'データベースの移行'].map((text, i) => ({ ref: String(i), text, tokens: searchTokens(text) }))
    expect(bm25(docs, 'メール検証')[0]?.ref).toBe('0')
  })
})

describe('compaction', () => {
  test('replaces the conversation with a deterministic summary', async ($, on) => {
    world(on, SESSION, () => '{}')
    const r = await $.session.compact({ trigger: 'manual', messages: SESSION })
    expect(r.messages?.[0]?.text.startsWith(SUMMARY_SENTINEL)).toBe(true)
  })

  test('carries goals, files and commits into the summary', async ($, on) => {
    world(on, SESSION, () => '{}')
    const r = await $.session.compact({ trigger: 'manual', messages: SESSION })
    const text = r.messages?.[0]?.text ?? ''
    expect([text.includes('[Session Goal]'), text.includes('Modified: src/login.ts'), text.includes('1a2b3c4')]).toEqual([true, true, true])
  })

  test('archives every entry before compacting', async ($, on) => {
    const w = world(on, SESSION, () => '{}')
    await $.session.compact({ trigger: 'manual', messages: SESSION })
    expect(JSON.parse(w.files.get(`${DIR}/seg-0001.json`) ?? '[]').length).toBe(5)
  })

  test('makes no model call to compact', async ($, on) => {
    const w = world(on, SESSION, () => '{}')
    await $.session.compact({ trigger: 'auto', messages: SESSION })
    expect(w.prompts.length).toBe(0)
  })

  test('skips the precompute ahead of an auto compaction', async ($, on) => {
    world(on, SESSION, () => '{}')
    const r = await $.session.compact({ trigger: 'precompute', messages: SESSION })
    expect(r.skip).toBe('blackhole compacts without a model')
  })

  test('hands auto compaction to core in manual mode', { options: { compaction: 'manual' } }, async ($, on) => {
    world(on, SESSION, () => '{}')
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }))
    const r = await $.session.compact({ trigger: 'auto', messages: SESSION })
    expect(r.messages?.[0]?.text).toBe('core summary')
  })

  test('hands an empty conversation to core', async ($, on) => {
    world(on, [], () => '{}')
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'core summary', toolUses: [] }] }))
    const r = await $.session.compact({ trigger: 'manual', messages: [] })
    expect(r.messages?.[0]?.text).toBe('core summary')
  })

  test('puts /compact instructions in the summary', async ($, on) => {
    world(on, SESSION, () => '{}')
    const r = await $.session.compact({ trigger: 'manual', messages: SESSION, instructions: 'API設計の議論を残す' })
    expect(r.messages?.[0]?.text).toContain('[Compaction Instructions]\nAPI設計の議論を残す')
  })

  test('merges the previous summary on the next compaction', async ($, on) => {
    world(on, SESSION, () => '{}')
    const first = await $.session.compact({ trigger: 'manual', messages: SESSION.slice(0, 3) })
    const summary = first.messages?.[0]
    const later: SessionMessage[] = [...(summary ? [summary] : []), ...SESSION.slice(3)]
    const second = await $.session.compact({ trigger: 'manual', messages: later })
    expect(second.messages?.[0]?.text).toContain('ログイン画面のバリデーションを修正して')
  })
})

describe('recall', () => {
  test('finds compacted history by text', async ($, on) => {
    world(on, [], () => '{}')
    await $.session.compact({ trigger: 'manual', messages: SESSION })
    const r = await $.tool.call({ tool: 'mcp__blackhole__recall', query: 'メールアドレス' } as never)
    expect(String(r.result)).toContain('#0')
  })

  test('expands an entry by index', async ($, on) => {
    world(on, [], () => '{}')
    await $.session.compact({ trigger: 'manual', messages: SESSION })
    const r = await $.tool.call({ tool: 'mcp__blackhole__recall', query: '#2' } as never)
    expect(String(r.result)).toContain('FAIL src/login.test.ts')
  })

  test('lists entries that touched a file', async ($, on) => {
    world(on, [], () => '{}')
    await $.session.compact({ trigger: 'manual', messages: SESSION })
    const r = await $.tool.call({ tool: 'mcp__blackhole__recall', query: 'mode:file login.ts' } as never)
    expect(String(r.result)).toContain('2 entries touched')
  })
})

describe('observational memory', () => {
  const observe = (prompt: string): string => {
    const ids = [...prompt.matchAll(/\[Source entry id: ([0-9a-f]{12})\]/g)].map(m => m[1])
    return JSON.stringify({ observations: [{ kind: 'constraint', content: 'User requires pnpm for all commands.', relevance: 'critical', sourceEntryIds: ids.slice(0, 1) }] })
  }

  test('observes in the background after a turn once over the threshold', { options: { observeAfterTokens: 10 } }, async ($, on) => {
    const w = world(on, SESSION, observe)
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.settle()
    expect(JSON.parse(w.files.get(`${DIR}/ledger.json`) ?? '{"observations":[]}').observations[0]?.content).toBe('User requires pnpm for all commands.')
  })

  test('stays idle below the threshold', async ($, on) => {
    const w = world(on, SESSION, observe)
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.settle()
    expect(w.prompts.length).toBe(0)
  })

  test('puts observations into the next compaction summary', { options: { observeAfterTokens: 10 } }, async ($, on) => {
    const w = world(on, SESSION, observe)
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.settle()
    const r = await $.session.compact({ trigger: 'manual', messages: SESSION })
    expect(r.messages?.[0]?.text).toContain('[critical] User requires pnpm for all commands.')
  })

  test('records how long the workers took', { options: { observeAfterTokens: 10 } }, async ($, on) => {
    const w = world(on, SESSION, observe, 1500)
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.advance(1500)
    const ledger = JSON.parse(w.files.get(`${DIR}/ledger.json`) ?? '{}') as Ledger
    expect(ledger.usage.ms).toBe(1500)
    expect(ledger.lastCycle).toEqual({ at: Date.UTC(2026, 9, 3, 12, 0), ms: 1500, calls: 1 })
  })

  const item = (id: string, kind: Observation['kind'], at: number, relevance: Observation['relevance'] = 'medium'): Observation => ({
    id,
    kind,
    content: `Item ${id} about the project, long enough to count.`,
    relevance,
    sources: [],
    at,
  })
  const ledgerOf = (...items: Observation[]): Ledger => ({ ...emptyLedger(), observations: items })
  const seed = (w: World, l: Ledger) => w.files.set(`${DIR}/ledger.json`, JSON.stringify(l))
  const stored = (w: World) => JSON.parse(w.files.get(`${DIR}/ledger.json`) ?? '{}') as Ledger

  test('turns a ledger with reflections into one layer of items', () => {
    const l = migrateLedger({
      observations: [
        { id: 'o1', content: 'lesson: tsc is not installed → use npx -p typescript tsc', relevance: 'high', sources: ['e1'], at: 1, reflected: true },
        { id: 'o2', content: 'Tests pass.', relevance: 'low', sources: ['e2'], at: 2 },
      ],
      reflections: [{ id: 'r1', content: 'lesson: type-check with npx -p typescript tsc', sources: ['o1'], at: 3 }],
      observed: ['e1', 'e2'],
      usage: { calls: 4, input: 1, output: 1, failures: 0 },
    })
    expect(l.version).toBe(2)
    expect(l.usage.ms).toBe(0)
    expect(l.observations.find(o => o.id === 'o1')).toMatchObject({ kind: 'lesson', dropped: true, supersededBy: 'r1' })
    expect(l.observations.find(o => o.id === 'o2')).toMatchObject({ kind: 'fact' })
    expect(l.observations.find(o => o.id === 'r1')).toMatchObject({ kind: 'lesson', sources: ['e1'], supersedes: ['o1'] })
    expect(activeObservations(l).map(o => o.id)).toEqual(['o2', 'r1'])
    expect(activeObservations(l).every(o => o.unclassified)).toBe(true)
  })

  test('settles a migrated ledger\'s kinds before any budget applies', { options: { observationsPoolMaxTokens: 200 } }, async ($, on) => {
    const legacy = Array.from({ length: 12 }, (_, n) => ({ id: `r${n}`, content: `Reflection ${n} about the project, long enough to count.`, sources: [], at: n }))
    const kinds = Object.fromEntries(legacy.map(r => [r.id, r.id === 'r0' ? 'constraint' : 'decision']))
    const w = world(on, SESSION, prompt => (prompt.includes('[r0]') ? JSON.stringify({ kinds }) : '{"observations":[]}'))
    w.files.set(`${DIR}/ledger.json`, JSON.stringify({ observations: [], reflections: legacy, observed: [], usage: { calls: 0, input: 0, output: 0, failures: 0 } }))
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.settle()
    const l = stored(w)
    // The classifier, then the consolidator for decisions now over their share.
    expect(w.prompts).toHaveLength(2)
    expect(w.prompts[1]).toContain('## Decisions (about')
    expect(l.version).toBe(2)
    expect(l.observations.some(o => o.unclassified)).toBe(false)
    expect(l.observations.find(o => o.id === 'r0')?.kind).toBe('constraint')
    // Decisions past their share are trimmed now that their kind is known; the constraint fits.
    expect(kindTokens(l, 'decision')).toBeLessThanOrEqual(kindBudget(200, 'decision'))
    expect(activeObservations(l).map(o => o.id)).toContain('r0')
  })

  test('an item the observer marks as superseding retires the old one', { options: { observeAfterTokens: 10 } }, async ($, on) => {
    const w = world(on, SESSION, prompt => {
      const ids = [...prompt.matchAll(/\[Source entry id: ([0-9a-f]{12})\]/g)].map(m => m[1])
      return JSON.stringify({ observations: [{ kind: 'state', content: 'Login validation is fixed.', sourceEntryIds: ids.slice(0, 1), supersedes: ['s1'] }] })
    })
    seed(w, ledgerOf(item('s1', 'state', 1)))
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.settle()
    const l = stored(w)
    const fresh = activeObservations(l).find(o => o.content === 'Login validation is fixed.')
    expect(l.observations.find(o => o.id === 's1')).toMatchObject({ dropped: true, supersededBy: fresh?.id })
    expect(fresh?.supersedes).toEqual(['s1'])
  })

  test('trims each kind to its share, lowest relevance and oldest first', () => {
    const l = ledgerOf(item('f1', 'fact', 1, 'high'), item('f2', 'fact', 2, 'low'), item('f3', 'fact', 3), item('c1', 'constraint', 0, 'low'))
    const budget = kindTokens(ledgerOf(item('x', 'fact', 0)), 'fact') * 2
    const poolMax = Math.ceil(budget / 0.15)
    expect(kindBudget(poolMax, 'fact')).toBeGreaterThanOrEqual(budget)
    const fitted = fitBudgets(l, poolMax)
    expect(activeObservations(fitted).map(o => o.id)).toEqual(['f1', 'f3', 'c1'])
    expect(fitBudgets(ledgerOf(item('c1', 'constraint', 0)), poolMax)).toEqual(ledgerOf(item('c1', 'constraint', 0)))
  })

  test('consolidates a lasting kind over its share with one worker call', { options: { observationsPoolMaxTokens: 200 } }, async ($, on) => {
    const lessons = ['l1', 'l2', 'l3', 'l4'].map((id, n) => item(id, 'lesson', n, 'high'))
    const w = world(on, SESSION, prompt =>
      prompt.includes('## Lessons (about')
        ? JSON.stringify({ merged: [{ content: 'lesson: one rule covers l1 to l3', replaces: ['l1', 'l2', 'l3'] }], retire: [] })
        : '{"observations":[]}',
    )
    // Below the observe threshold: the only call is the consolidator's.
    seed(w, ledgerOf(...lessons, item('f1', 'fact', 9)))
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
    await w.clock.settle()
    const l = stored(w)
    expect(w.prompts).toHaveLength(1)
    const merged = activeObservations(l).find(o => o.content === 'lesson: one rule covers l1 to l3')
    expect(merged).toMatchObject({ kind: 'lesson', relevance: 'high', supersedes: ['l1', 'l2', 'l3'], at: 2 })
    expect(l.observations.find(o => o.id === 'l2')?.supersededBy).toBe(merged?.id)
    expect(kindTokens(l, 'lesson')).toBeLessThanOrEqual(kindBudget(200, 'lesson'))
  })
})

describe('cleanup', () => {
  const ROOT = '/home/u/.claude/blackhole'
  const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}`
  const NOW = Date.UTC(2026, 9, 5)
  const DAY = 86_400_000

  /** Session directories as `{ id: newest file's age in days }`, plus what was removed. */
  const engine = (on: On, ages: Record<string, number>, settings: Record<string, unknown> = {}) => {
    const removed: string[] = []
    const clock = mock.clock(on, { now: NOW })
    mock.env(on, { HOME: '/home/u' })
    on('session.id', () => ({ value: ID(1) }))
    on('fs.exists', (_$, e) => ({ value: e.path === ROOT }))
    on('settings.read', () => ({ value: settings }))
    on('fs.list', (_$, e) => {
      if (e.path === ROOT)
        return { value: [...Object.keys(ages), 'notes'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
      const age = ages[e.path.slice(ROOT.length + 1)]
      return { value: age === undefined ? [] : [{ name: 'ledger.json', kind: 'file' as const, size: 2, mtimeMs: NOW - age * DAY, isLink: false }] }
    })
    on('process.run', (_$, e) => {
      removed.push(e.argv.join(' '))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
    on('fs.read', () => ({ deny: 'ENOENT' }))
    on('fs.write', () => ({ value: undefined }))
    on('session.cwd', () => ({ value: CWD }))
    on('session.messages', () => ({ value: [...SESSION] }))
    return { removed, clock }
  }

  test('retention follows cleanupPeriodDays, else 30 days', () => {
    expect(retentionDays({ cleanupPeriodDays: 7 })).toBe(7)
    expect(retentionDays({})).toBe(DEFAULT_RETENTION_DAYS)
    expect(retentionDays({ cleanupPeriodDays: 0 })).toBe(DEFAULT_RETENTION_DAYS)
  })

  test('only idle session directories are stale, never the current one', async () => {
    const io = {
      root: ROOT,
      current: ID(1),
      now: async () => NOW,
      remove: async () => {},
      list: async (path: string) =>
        path === ROOT
          ? [ID(1), ID(2), ID(3), ID(4), 'notes'].map(name => ({ name, kind: 'dir' as const, mtimeMs: 0 }))
          : path.endsWith(ID(3))
            ? [{ name: 'ledger.json', kind: 'file' as const, mtimeMs: NOW - 2 * DAY }]
            : path.endsWith(ID(4))
              ? []
              : [{ name: 'ledger.json', kind: 'file' as const, mtimeMs: NOW - 40 * DAY }],
    }
    // ID(1) is current, ID(2) idle 40 days, ID(3) written 2 days ago, ID(4) empty; oldest first.
    expect(await staleSessions(io, 30)).toEqual([`${ROOT}/${ID(4)}`, `${ROOT}/${ID(2)}`])
  })

  test('a compaction removes idle sessions after it is done', async ($, on) => {
    const { removed, clock } = engine(on, { [ID(2)]: 40, [ID(3)]: 2 }, { cleanupPeriodDays: 30 })
    await $.session.compact({ trigger: 'manual', messages: SESSION })
    expect(removed).toEqual([])
    await clock.settle()
    expect(removed).toEqual([`rm -rf -- ${ROOT}/${ID(2)}`])
  })

  test('/blackhole cleanup reports what it removed', async ($, on) => {
    const { removed } = engine(on, { [ID(2)]: 10 }, { cleanupPeriodDays: 7 })
    const r = await $.command.run({ command: 'blackhole', args: 'cleanup' } as never)
    expect(removed).toEqual([`rm -rf -- ${ROOT}/${ID(2)}`])
    expect(r.text).toContain(`removed 1 idle session(s):\n${ROOT}/${ID(2)}`)
  })
})
