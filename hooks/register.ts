// blackhole: pi-blackhole's mechanism for Claude Code.
//   - session.compact: a deterministic VCC summary (no model call) plus the
//     observational memory replaces the conversation; the raw messages are
//     archived first, so nothing is lost to recall.
//   - turn.complete: observer → reflector → dropper run in the background on
//     the worker model once enough conversation is unobserved.
//   - mcp__blackhole__recall and /blackhole* commands search and show it all.
import type { EngineInterface, PluginOptions, Register, SessionMessage } from 'claude-code'

import type { Ledger } from './memory'
import type { Io } from './store'
import {
  DROPPER_SYSTEM,
  OBSERVER_SYSTEM,
  REFLECTOR_SYSTEM,
  activeObservations,
  activeReflections,
  addObservations,
  applyDrops,
  applyReflection,
  dropToBudget,
  dropperPrompt,
  needsReflection,
  observerPrompt,
  parseDrops,
  parseObservations,
  poolTokens,
  reflectorPrompt,
  renderMemory,
  renderObservation,
  renderReflection,
  takeChunk,
} from './memory'
import { RECALL_DESCRIPTION, recall } from './recall'
import { archiveEntries, corpus, loadLedger, loadSections, saveLedger, saveSections, serial } from './store'
import { clip, estimateTokens, hashId } from './text'
import { buildSections, formatSummary, isEmptySections, isSummaryText, mergeSections, toEntries } from './vcc'

type Mode = 'auto' | 'manual' | 'off'

const REFLECT_EVERY = 30
const OBSERVER_CHUNK_MAX_TOKENS = 20000
const RETRY_COOLDOWN_MS = 30_000
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

const configOf = (options: PluginOptions) => ({
  mode: (options.compaction === 'manual' || options.compaction === 'off' ? options.compaction : 'auto') as Mode,
  workerModel: typeof options.workerModel === 'string' && options.workerModel ? options.workerModel : DEFAULT_MODEL,
  observeAfter: typeof options.observeAfterTokens === 'number' ? options.observeAfterTokens : 8000,
  poolMax: typeof options.observationsPoolMaxTokens === 'number' ? options.observationsPoolMaxTokens : 6000,
})

// Set by register; module state starts over on a hot reload, which is what a
// lock and a toggle want.
let cfg = configOf({})
const run = { memoryOn: true, running: false, lastFailureAt: 0 }

/** The store's view of the engine, over a hook's own `$`. */
async function ioOf($: EngineInterface): Promise<Io> {
  const home = (await $.env.get('HOME')) ?? '.'
  return {
    dir: `${home}/.claude/blackhole/${await $.session.id()}`,
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    exists: path => $.fs.exists(path),
    now: () => $.clock.now(),
    messages: () => $.session.messages(),
  }
}

// ── workers ──────────────────────────────────────────────────────────────

async function complete($: EngineInterface, ledger: Ledger, system: string, prompt: string): Promise<string | undefined> {
  const r = await $.model.complete({ model: cfg.workerModel, system, prompt, maxTokens: 8000, effort: 'low', timeoutMs: 180_000 })
  ledger.usage.calls++
  ledger.usage.input += r.usage.input_tokens
  ledger.usage.output += r.usage.output_tokens
  if (r.isAnswered) return r.text
  ledger.usage.failures++
  ledger.lastError = r.reason === 'api-error' ? `api-error ${r.status ?? ''} ${r.error}` : r.reason
  return undefined
}

/** One observer → reflector → dropper cycle; `force` observes below the threshold. */
async function cycle($: EngineInterface, force: boolean): Promise<string> {
  const io = await ioOf($)
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  let ledger = await serial(() => loadLedger(io))
  const observed = new Set(ledger.observed)
  const pending = (await serial(() => corpus(io))).filter(e => !observed.has(e.id))
  const pendingTokens = pending.reduce((n, e) => n + estimateTokens(e.text) + e.tools.reduce((m, t) => m + estimateTokens(t.text) / 4, 0), 0)
  const notes: string[] = []
  const failuresBefore = ledger.usage.failures
  let isFailed = false

  if (pending.length > 0 && (force || pendingTokens >= cfg.observeAfter)) {
    let rest = pending
    while (rest.length > 0) {
      const { chunk, text } = takeChunk(rest, OBSERVER_CHUNK_MAX_TOKENS, cwd)
      $.ui.status(`blackhole: observing ${chunk.length} entries…`)
      const reply = await complete($, ledger, OBSERVER_SYSTEM, observerPrompt(ledger, text))
      const obs = reply === undefined ? undefined : parseObservations(reply, chunk, now)
      if (obs === undefined) {
        ledger.lastError = reply === undefined ? ledger.lastError : 'observer reply was not valid JSON'
        run.lastFailureAt = now
        isFailed = true
        notes.push(`observer failed: ${ledger.lastError ?? 'unknown'}`)
        break
      }
      ledger = addObservations(ledger, obs, chunk)
      notes.push(`+${obs.length} observations`)
      rest = rest.slice(chunk.length)
    }
  }

  if (needsReflection(ledger, REFLECT_EVERY) || (force && activeObservations(ledger).some(o => !o.reflected))) {
    $.ui.status('blackhole: reflecting…')
    const reply = await complete($, ledger, REFLECTOR_SYSTEM, reflectorPrompt(ledger))
    const next = reply === undefined ? undefined : applyReflection(ledger, reply, now)
    if (next) {
      notes.push(`+${activeReflections(next).length - activeReflections(ledger).length} reflections`)
      ledger = next
    } else {
      isFailed = true
      notes.push('reflector failed')
    }
  }

  const over = poolTokens(ledger) - cfg.poolMax
  if (over > 0) {
    $.ui.status('blackhole: pruning memory…')
    const before = activeObservations(ledger).length
    const reply = await complete($, ledger, DROPPER_SYSTEM, dropperPrompt(ledger, over))
    const ids = reply === undefined ? undefined : parseDrops(ledger, reply)
    if (ids) ledger = applyDrops(ledger, ids)
    ledger = dropToBudget(ledger, cfg.poolMax)
    notes.push(`-${before - activeObservations(ledger).length} observations dropped`)
  }

  // A clean cycle clears the error a past one left for /blackhole-memory.
  if (!isFailed && ledger.usage.failures === failuresBefore) ledger = { ...ledger, lastError: undefined }
  await serial(() => saveLedger(io, ledger))
  $.ui.status(undefined)
  return notes.join(', ') || 'nothing to observe'
}

/** Start a cycle on a timer, outside the dispatch that asked for it. */
function runInBackground($: EngineInterface, force: boolean): void {
  if (run.running || !run.memoryOn) return
  run.running = true
  $.clock.after(0, () => {
    cycle($, force)
      .then(note => {
        if (force) $.ui.toast(`blackhole: ${note}`)
      })
      .catch(async err => {
        run.lastFailureAt = await $.clock.now()
        $.ui.log(`blackhole: memory pipeline failed: ${String(err)}`)
      })
      .finally(() => {
        run.running = false
        $.ui.status(undefined)
      })
  })
}

// ── compaction ───────────────────────────────────────────────────────────

async function compile($: EngineInterface, messages: readonly SessionMessage[], instructions?: string) {
  const io = await ioOf($)
  const cwd = await $.session.cwd()
  return serial(async () => {
    const all = await corpus(io, messages)
    const windowKeys = new Set(toEntries(messages).map(e => e.key))
    const window = all.filter(e => windowKeys.has(e.key))
    const prevSummary = messages.find(m => isSummaryText(m.text))
    const stored = await loadSections(io)
    const prev = prevSummary && stored?.hash === hashId(prevSummary.text) ? stored.sections : undefined
    let sections = mergeSections(prev, buildSections(window, cwd))
    if (prevSummary && !prev) {
      // A summary blackhole holds no sections for (another session's): keep its gist.
      sections = { ...sections, briefTranscript: `[previous summary] ${clip(prevSummary.text, 3000)}\n${sections.briefTranscript}` }
    }
    const memory = run.memoryOn ? renderMemory(await loadLedger(io)) : ''
    return { io, sections, memory, text: formatSummary({ sections, memory, instructions }) }
  })
}

const messageTokens = (messages: readonly SessionMessage[]): number =>
  messages.reduce((n, m) => n + estimateTokens(m.text) + m.toolUses.reduce((k, u) => k + estimateTokens(u.text ?? ''), 0), 0)

async function recallFor($: EngineInterface, query: string): Promise<string> {
  const io = await ioOf($)
  const cwd = await $.session.cwd()
  return serial(async () => recall(query, { corpus: await corpus(io), ledger: await loadLedger(io), cwd }))
}

async function memoryStatus($: EngineInterface, arg: string): Promise<string> {
  const io = await ioOf($)
  const ledger = await serial(() => loadLedger(io))
  if (arg === 'view' || arg === 'full') {
    const refl = arg === 'full' ? ledger.reflections : activeReflections(ledger)
    const obs = arg === 'full' ? ledger.observations : activeObservations(ledger)
    const mark = (d?: boolean) => (d ? ' (dropped)' : '')
    return [
      `Reflections (${refl.length})`,
      ...refl.map(r => `- ${renderReflection(r)}${mark(r.dropped)}`),
      '',
      `Observations (${obs.length})`,
      ...obs.map(o => `- ${renderObservation(o)}${mark(o.dropped)}`),
    ].join('\n')
  }
  const all = await serial(() => corpus(io))
  const observed = new Set(ledger.observed)
  const pending = all.filter(x => !observed.has(x.id))
  return [
    `memory: ${run.memoryOn ? 'on' : 'off'}${run.running ? ' (running)' : ''}, worker ${cfg.workerModel}`,
    `observations: ${activeObservations(ledger).length} active / ${ledger.observations.length} total`,
    `reflections: ${activeReflections(ledger).length} active / ${ledger.reflections.length} total`,
    `pool: ~${poolTokens(ledger)} / ${cfg.poolMax} tokens`,
    `history: ${all.length} entries, ${pending.length} unobserved (~${pending.reduce((n, x) => n + estimateTokens(x.text), 0)} tokens; observes at ${cfg.observeAfter})`,
    `worker calls: ${ledger.usage.calls} (${ledger.usage.failures} failed), tokens in ${ledger.usage.input} / out ${ledger.usage.output}`,
    ledger.lastError ? `last error: ${ledger.lastError}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

async function exportMemory($: EngineInterface): Promise<string> {
  const io = await ioOf($)
  const ledger = await serial(() => loadLedger(io))
  const path = `${io.dir}/memory.md`
  await $.fs.write(path, [`# blackhole memory: session ${await $.session.id()}`, '', renderMemory(ledger) || '_(empty)_', ''].join('\n'))
  return path
}

async function settingsText($: EngineInterface): Promise<string> {
  const io = await ioOf($)
  return [
    `compaction: ${cfg.mode}`,
    `memory: ${run.memoryOn ? 'on' : 'off'}`,
    `workerModel: ${cfg.workerModel}`,
    `observeAfterTokens: ${cfg.observeAfter}`,
    `observationsPoolMaxTokens: ${cfg.poolMax}`,
    `data: ${io.dir}`,
    'Change them under /config (blackhole).',
  ].join('\n')
}

// ── hooks ────────────────────────────────────────────────────────────────

// `/blackhole preview:` and `/blackhole Preview` mean the keyword, not compaction instructions.
const keyword = (args: string): string => args.trim().replace(/[\s:：.。!！?？]+$/, '').toLowerCase()

export const register: Register = (on, options) => {
  cfg = configOf(options)
  run.memoryOn = options.memory !== false

  on('session.compact', async ($, e, next) => {
    if (cfg.mode === 'off' || e.agentId !== undefined) return next(e)
    // Precompute only serves core's own summarizer; blackhole needs no model at compaction time.
    if (e.trigger === 'precompute') return cfg.mode === 'auto' ? { skip: 'blackhole compacts without a model' } : next(e)
    if (cfg.mode === 'manual' && e.trigger === 'auto') return next(e)

    const now = await $.clock.now()
    const io = await ioOf($)
    await serial(() => archiveEntries(io, toEntries(e.messages), now))
    const { sections, memory, text } = await compile($, e.messages, e.instructions)
    if (isEmptySections(sections) && !memory) return next(e)
    await serial(() => saveSections(io, { hash: hashId(text), sections }))
    const tokensBefore = messageTokens(e.messages)
    $.ui.toast(`blackhole: compacted ~${tokensBefore} → ~${estimateTokens(text)} tokens`)
    return { messages: [{ role: 'user', text, toolUses: [] }], tokensBefore }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !run.memoryOn || run.running) return result
    if ((await $.clock.now()) - run.lastFailureAt < RETRY_COOLDOWN_MS) return result
    runInBackground($, false)
    return result
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'recall',
      description: RECALL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search text, #N, #N:<text>, a 12-hex id, /regex/, or mode:file <path>; optional page:N scope:all|history|memory',
          },
        },
        required: ['query'],
      },
    })
    await $.command.register({
      name: 'blackhole',
      description: 'Compact now with blackhole (or: preview | settings | om-on | om-off)',
      argumentHint: '[preview|settings|om-on|om-off|<instructions>]',
    })
    await $.command.register({ name: 'blackhole-memory', description: 'blackhole memory status (or: view | full | run)', argumentHint: '[view|full|run]' })
    await $.command.register({ name: 'blackhole-recall', description: 'Search the session history and memory', argumentHint: '<query>' })
    await $.command.register({ name: 'blackhole-export', description: 'Export blackhole memory to a Markdown file' })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__blackhole__recall' }, async ($, e) => {
    const input = e as { query?: unknown }
    return { result: await recallFor($, typeof input.query === 'string' ? input.query : '') }
  })

  on('command.run', { command: 'blackhole' }, async ($, e) => {
    const arg = keyword(e.args)
    if (arg === 'om-on' || arg === 'om-off') {
      run.memoryOn = arg === 'om-on'
      return { text: `observational memory ${run.memoryOn ? 'on' : 'off'} for this session.` }
    }
    if (arg === 'settings') return { text: await settingsText($) }
    if (arg === 'preview') return { text: (await compile($, await $.session.messages())).text }
    // $.session.compact rejects inside a dispatch the turn waits on: run it from a timer.
    $.clock.after(0, () => {
      $.session
        .compact(e.args.trim() ? { instructions: e.args.trim() } : undefined)
        .then(r => {
          if (r.skip !== undefined) $.ui.toast(`blackhole: compaction skipped: ${r.skip}`)
        })
        .catch(err => $.ui.toast(`blackhole: could not compact now (${String(err)}); run /compact instead`))
    })
    return { text: 'compacting (deterministic summary + memory)…' }
  })

  on('command.run', { command: 'blackhole-memory' }, async ($, e) => {
    const arg = keyword(e.args)
    if (arg !== 'run') return { text: await memoryStatus($, arg) }
    if (run.running) return { text: 'the memory pipeline is already running.' }
    if (!run.memoryOn) return { text: 'memory is off (/blackhole om-on).' }
    runInBackground($, true)
    return { text: 'memory pipeline started.' }
  })

  on('command.run', { command: 'blackhole-recall' }, async ($, e) => ({ text: await recallFor($, e.args) }))

  on('command.run', { command: 'blackhole-export' }, async $ => ({ text: `memory exported to ${await exportMemory($)}` }))
}
