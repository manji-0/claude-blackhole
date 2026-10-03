import type { On, SessionMessage } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { parseJson, parseObservations } from '../hooks/memory'
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
const world = (on: On, messages: readonly SessionMessage[], reply: (prompt: string) => string): World => {
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
  on('model.complete', (_$, e) => {
    w.prompts.push(e.prompt)
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
    expect(goals.some(g => g.startsWith('[Scope change]'))).toBe(true)
    expect(goals.some(g => g.startsWith('https://pi.dev/packages/pi-blackhole の仕組みを実装したい'))).toBe(true)
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
    expect(state[0]).toContain('次はビルドも確認して')
    expect(state[1]).toContain(long)
    expect(state[2]).toBe('Then: Bash: ビルドする — `pnpm build` → [tool_error] error TS2304')
    expect(buildSections(toEntries(SESSION), CWD).currentState?.[0]).toContain('今後は必ず pnpm を使ってください')
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
    return JSON.stringify({ observations: [{ content: 'User requires pnpm for all commands.', relevance: 'critical', sourceEntryIds: ids.slice(0, 1) }] })
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
})
