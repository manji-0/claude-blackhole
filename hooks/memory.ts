// Observational memory: the ledger, the worker prompts, and the pure steps
// that turn a worker's JSON reply into ledger changes.
import type { Entry } from './vcc'
import { clip, estimateTokens, hashId } from './text'
import { toolOneLiner } from './vcc'

export type Relevance = 'critical' | 'high' | 'medium' | 'low'

export type Observation = {
  id: string
  content: string
  relevance: Relevance
  /** Entry ids (12 hex) the observation cites. */
  sources: string[]
  at: number
  dropped?: boolean
  /** Set once a reflection covers it. */
  reflected?: boolean
}

export type Reflection = {
  id: string
  content: string
  /** Observation ids it was distilled from. */
  sources: string[]
  at: number
  dropped?: boolean
}

export type Ledger = {
  observations: Observation[]
  reflections: Reflection[]
  /** Ids of the entries the observer has covered. */
  observed: string[]
  usage: { calls: number; input: number; output: number; failures: number }
  lastError?: string
}

export const emptyLedger = (): Ledger => ({
  observations: [],
  reflections: [],
  observed: [],
  usage: { calls: 0, input: 0, output: 0, failures: 0 },
})

const RELEVANCE: readonly Relevance[] = ['critical', 'high', 'medium', 'low']
const RANK: Record<Relevance, number> = { critical: 3, high: 2, medium: 1, low: 0 }

export const activeObservations = (l: Ledger): Observation[] => l.observations.filter(o => !o.dropped)
export const activeReflections = (l: Ledger): Reflection[] => l.reflections.filter(r => !r.dropped)

export const poolTokens = (l: Ledger): number =>
  [...activeObservations(l), ...activeReflections(l)].reduce((n, x) => n + estimateTokens(x.content) + 8, 0)

const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

export const renderObservation = (o: Observation): string => `[${o.id}] ${stamp(o.at)} [${o.relevance}] ${o.content}`
export const renderReflection = (r: Reflection): string => `[${r.id}] ${r.content}`

/** The memory block a compaction summary carries. */
export const renderMemory = (l: Ledger): string => {
  const refl = activeReflections(l)
  const obs = activeObservations(l)
  const parts: string[] = []
  if (refl.length > 0) parts.push(`## Reflections\n${refl.map(r => `- ${renderReflection(r)}`).join('\n')}`)
  if (obs.length > 0) parts.push(`## Observations\n${obs.map(o => `- ${renderObservation(o)}`).join('\n')}`)
  return parts.join('\n\n')
}

// ── JSON from a text completion ──────────────────────────────────────────

/** Parse the first JSON object or array in a reply; undefined when there is none. */
export const parseJson = (text: string): unknown => {
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
  const starts = [unfenced.indexOf('{'), unfenced.indexOf('[')].filter(i => i >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const open = unfenced[start]
  const close = open === '{' ? '}' : ']'
  for (let end = unfenced.lastIndexOf(close); end > start; end = unfenced.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1))
    } catch {
      // try a shorter span
    }
  }
  return undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

// ── observer ─────────────────────────────────────────────────────────────

export const OBSERVER_SYSTEM = `You are the observation agent for a coding assistant (Claude Code).

Your observations are the ONLY information a future assistant session will have about this conversation once the raw transcript is compacted away. Anything you do not capture is forgotten; anything you distort is remembered wrong.

You receive current reflections, current observations, and a new chunk of conversation. Each source block in the chunk starts with "[Source entry id: <id>]".

Reply with ONE JSON object and nothing else:
{"observations":[{"content":"...","relevance":"critical|high|medium|low","sourceEntryIds":["<id>", "..."]}]}

Rules:
- Record only NEW information from the chunk. Never restate or reword what reflections or current observations already hold, unless it materially changed (then frame it as a supersession: "will use X (switching from Y)").
- Every observation cites the smallest exact set of source entry ids that support it, copied from the chunk. Never invent ids; items without valid ids are discarded.
- One fact per observation, one line of plain prose, no markdown, no relevance inside the content.
- Self-contained: no "option B", "the issue above", pronouns or conversation-internal labels. Keep stable identifiers verbatim: file paths with line numbers, function and package names, commit SHAs, error messages quoted exactly, numbers with units.
- Preserve user assertions as assertions and questions as questions; quote the user's unusual terms.
- Mark completions explicitly ("completed: ...", "resolved: ...") so work is not redone.
- Group repeated similar tool calls into one observation. Skip workflow narration, routine test runs, pushes and session bookkeeping.
- Lessons learned are the most valuable observations; never skip them. When a tool call failed because of the environment or a wrong assumption and a later call worked, record the lesson as "lesson: <what fails> → <cause> → <what works instead>", rated high (for example: "lesson: grep with \\| alternation fails here because grep is aliased to rg → use rg syntax (a|b) or grep -E"). The same goes for how to build, test or type-check this project, and for where tools, scratch environments and generated files live.
- Record outcomes, not requests: do not write "the user asked X" when what was decided, answered or done can be written instead. A bare question with no outcome yet is medium at most.
- Skip state that will be stale within minutes ("X does not exist yet", "waiting for the turn to end"); record the event that changes it when it happens.
- Write the content in the language the user writes in (the user's messages, not the tool output or the system prompt): if the user writes Japanese, write Japanese, keeping identifiers, paths and quoted errors verbatim.
- Survival test: would a future assistant, seeing only this line, make a better decision, avoid redoing work, or avoid violating a user constraint? If not, omit it or rate it low.
- Relevance: critical = user identity, persistent preferences, explicit corrections, completions that must not be redone; high = decisions with rationale, architecture direction, unresolved blockers, key constraints; medium = task-level context (default when unsure); low = routine, re-derivable. Most observations are medium or low.
- An empty array is a valid answer when the chunk holds nothing new.`

const ENTRY_TEXT_MAX = 3000
const TOOL_RESULT_MAX = 600

/** One entry as the observer reads it. */
export const renderEntryForObserver = (e: Entry, cwd?: string): string => {
  const lines = [`[Source entry id: ${e.id}]`]
  if (e.text) lines.push(`[${e.role === 'user' ? 'User' : 'Assistant'}${e.at ? ` @ ${stamp(e.at)}` : ''}]: ${clip(e.text, ENTRY_TEXT_MAX)}`)
  for (const t of e.tools) {
    lines.push(`[Tool call] ${toolOneLiner(t, cwd, true)}`)
    if (t.text) lines.push(`[Tool result for ${t.name}${t.isError ? ' (error)' : ''}]: ${clip(t.text, TOOL_RESULT_MAX)}`)
  }
  return lines.join('\n')
}

/** Take the oldest unobserved entries up to a token budget (at least one). */
export const takeChunk = (entries: Entry[], maxTokens: number, cwd?: string): { chunk: Entry[]; text: string } => {
  const chunk: Entry[] = []
  const parts: string[] = []
  let tokens = 0
  for (const e of entries) {
    const rendered = renderEntryForObserver(e, cwd)
    const t = estimateTokens(rendered)
    if (chunk.length > 0 && tokens + t > maxTokens) break
    chunk.push(e)
    parts.push(rendered)
    tokens += t
  }
  return { chunk, text: parts.join('\n\n') }
}

export const observerPrompt = (l: Ledger, chunkText: string): string =>
  [
    '## Current reflections',
    activeReflections(l).map(renderReflection).join('\n') || '(none)',
    '## Current observations',
    activeObservations(l).map(renderObservation).join('\n') || '(none)',
    '## New conversation chunk',
    chunkText,
  ].join('\n\n')

/** Validate the observer's reply against the chunk; invalid items are dropped. */
export const parseObservations = (reply: string, chunk: Entry[], at: number): Observation[] | undefined => {
  const json = parseJson(reply)
  const list = isRecord(json) ? json.observations : Array.isArray(json) ? json : undefined
  if (!Array.isArray(list)) return undefined
  const valid = new Map(chunk.map(e => [e.id, e]))
  const out: Observation[] = []
  for (const item of list) {
    if (!isRecord(item) || typeof item.content !== 'string') continue
    const content = oneLine(item.content)
    if (!content) continue
    const sources = strings(item.sourceEntryIds ?? item.sources).filter(id => valid.has(id))
    if (sources.length === 0) continue
    const relevance = RELEVANCE.includes(item.relevance as Relevance) ? (item.relevance as Relevance) : 'medium'
    const latest = Math.max(...sources.map(id => valid.get(id)?.at ?? at))
    out.push({ id: hashId(`o:${content}:${sources.join(',')}`), content, relevance, sources, at: latest })
  }
  return out
}

/** Add observations, skipping exact duplicates of active ones. */
export const addObservations = (l: Ledger, obs: Observation[], chunk: Entry[]): Ledger => {
  const have = new Set(activeObservations(l).map(o => o.content.toLowerCase()))
  const ids = new Set(l.observations.map(o => o.id))
  const fresh = obs.filter(o => !have.has(o.content.toLowerCase()) && !ids.has(o.id))
  const observed = [...l.observed, ...chunk.map(e => e.id)].slice(-20000)
  return { ...l, observations: [...l.observations, ...fresh], observed }
}

// ── reflector ────────────────────────────────────────────────────────────

export const REFLECTOR_SYSTEM = `You are the reflection agent for a coding assistant's memory.

You receive the current reflections and the observations not yet reflected. Distill durable knowledge: stable user preferences and constraints, settled decisions with their rationale, the project's architecture facts, completed milestones that must not be redone, and long-running blockers. Reflections outlive observations, so each must stand alone and stay true.

Reply with ONE JSON object and nothing else:
{"reflections":[{"content":"...","sourceObservationIds":["<id>", "..."]}],"retire":["<reflection id>", "..."]}

Rules:
- New reflections only; never reword an existing reflection. Put the id of a reflection that a new one supersedes or that is now false into "retire".
- Each reflection cites the observation ids it is built from (copied exactly). Items without valid ids are discarded.
- One durable fact or pattern per reflection, one line of plain prose, self-contained, identifiers verbatim, in the user's language.
- Keep every "lesson:" observation that still holds as a reflection, worded as the rule to follow.
- Retire a reflection that a newer observation shows is out of date (a thing that "does not exist yet" and now does, a plan that was replaced).
- Transient progress is not a reflection. An empty array is a valid answer.`

export const reflectorPrompt = (l: Ledger): string =>
  [
    '## Current reflections',
    activeReflections(l).map(renderReflection).join('\n') || '(none)',
    '## Observations not yet reflected',
    activeObservations(l)
      .filter(o => !o.reflected)
      .map(renderObservation)
      .join('\n'),
  ].join('\n\n')

export const applyReflection = (l: Ledger, reply: string, at: number): Ledger | undefined => {
  const json = parseJson(reply)
  if (!isRecord(json)) return undefined
  const pending = activeObservations(l).filter(o => !o.reflected)
  const valid = new Set(pending.map(o => o.id))
  const have = new Set(activeReflections(l).map(r => r.content.toLowerCase()))
  const added: Reflection[] = []
  for (const item of Array.isArray(json.reflections) ? json.reflections : []) {
    if (!isRecord(item) || typeof item.content !== 'string') continue
    const content = oneLine(item.content)
    const sources = strings(item.sourceObservationIds ?? item.sources).filter(id => valid.has(id))
    if (!content || sources.length === 0 || have.has(content.toLowerCase())) continue
    have.add(content.toLowerCase())
    added.push({ id: hashId(`r:${content}`), content, sources, at })
  }
  const retire = new Set(strings(json.retire))
  return {
    ...l,
    reflections: [...l.reflections.map(r => (retire.has(r.id) ? { ...r, dropped: true } : r)), ...added],
    observations: l.observations.map(o => (valid.has(o.id) ? { ...o, reflected: true } : o)),
  }
}

export const needsReflection = (l: Ledger, every: number): boolean =>
  activeObservations(l).filter(o => !o.reflected).length >= every

// ── dropper ──────────────────────────────────────────────────────────────

export const DROPPER_SYSTEM = `You prune a coding assistant's memory pool, which is over its size budget.

You receive reflections and observations, each with an id and relevance. Choose observations to drop: first those already captured by a reflection, then superseded or stale ones, then low-value routine ones. Never drop a critical observation unless a reflection fully preserves it. Keep unresolved blockers and user corrections.

Reply with ONE JSON object and nothing else: {"drop":["<observation id>", "..."]}`

export const dropperPrompt = (l: Ledger, overBy: number): string =>
  [
    `The pool is about ${overBy} tokens over budget.`,
    '## Reflections',
    activeReflections(l).map(renderReflection).join('\n') || '(none)',
    '## Observations',
    activeObservations(l).map(renderObservation).join('\n'),
  ].join('\n\n')

export const applyDrops = (l: Ledger, ids: Iterable<string>): Ledger => {
  const drop = new Set(ids)
  return { ...l, observations: l.observations.map(o => (drop.has(o.id) ? { ...o, dropped: true } : o)) }
}

export const parseDrops = (l: Ledger, reply: string): string[] | undefined => {
  const json = parseJson(reply)
  if (!isRecord(json)) return undefined
  const active = new Map(activeObservations(l).map(o => [o.id, o]))
  return strings(json.drop).filter(id => active.has(id))
}

/**
 * Deterministic fallback and finisher: drop reflected, then lowest relevance,
 * then oldest observations until the pool fits. Critical ones stay.
 */
export const dropToBudget = (l: Ledger, maxTokens: number): Ledger => {
  let ledger = l
  const order = activeObservations(l)
    .filter(o => o.relevance !== 'critical')
    .sort((a, z) => Number(z.reflected ?? false) - Number(a.reflected ?? false) || RANK[a.relevance] - RANK[z.relevance] || a.at - z.at)
  for (const o of order) {
    if (poolTokens(ledger) <= maxTokens) break
    ledger = applyDrops(ledger, [o.id])
  }
  return ledger
}
