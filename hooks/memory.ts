// Observational memory: one layer of typed items, the worker prompts, and
// the pure steps that turn a worker's JSON reply into ledger changes.
//
// Each item has a kind, and the kind decides how long it lives: constraints,
// lessons and decisions are kept (a consolidator merges them when their share
// of the pool overflows); state keeps only the newest; facts go first, since
// recall can find them again in the archive.
import type { Entry } from './vcc'
import { clip, estimateTokens, hashId } from './text'
import { toolOneLiner } from './vcc'

export type Relevance = 'critical' | 'high' | 'medium' | 'low'
export type Kind = 'constraint' | 'lesson' | 'decision' | 'state' | 'fact'

/** In the order the summary shows them. */
export const KINDS: readonly Kind[] = ['constraint', 'lesson', 'decision', 'state', 'fact']
/** Share of the memory pool each kind may fill. */
export const KIND_SHARE: Record<Kind, number> = { constraint: 0.2, lesson: 0.3, decision: 0.25, state: 0.1, fact: 0.15 }
/** Kinds the consolidator merges when over budget; the rest are only trimmed. */
export const LASTING: ReadonlySet<Kind> = new Set<Kind>(['constraint', 'lesson', 'decision'])

const KIND_TITLE: Record<Kind, string> = {
  constraint: 'Constraints',
  lesson: 'Lessons',
  decision: 'Decisions',
  state: 'Current State',
  fact: 'Facts',
}

export type Observation = {
  id: string
  kind: Kind
  content: string
  relevance: Relevance
  /** Entry ids (12 hex) the item cites. */
  sources: string[]
  at: number
  /** Ids of the items this one replaced. */
  supersedes?: string[]
  dropped?: boolean
  /** Set when a newer item replaced this one. */
  supersededBy?: string
  /** Migrated from a ledger without kinds; the classifier settles the kind, and budgets spare it until then. */
  unclassified?: boolean
}

export type Ledger = {
  version: 2
  observations: Observation[]
  /** Ids of the entries the observer has covered. */
  observed: string[]
  /** `ms` is the workers' total wall-clock time. */
  usage: { calls: number; input: number; output: number; failures: number; ms: number }
  /** Wall-clock time of the last cycle that called a worker. */
  lastCycle?: { at: number; ms: number; calls: number }
  lastError?: string
}

export const emptyLedger = (): Ledger => ({
  version: 2,
  observations: [],
  observed: [],
  usage: { calls: 0, input: 0, output: 0, failures: 0, ms: 0 },
})

const RELEVANCE: readonly Relevance[] = ['critical', 'high', 'medium', 'low']
const RANK: Record<Relevance, number> = { critical: 3, high: 2, medium: 1, low: 0 }

const isKind = (v: unknown): v is Kind => KINDS.includes(v as Kind)
/** Kind for an item written before kinds existed. */
const inferKind = (content: string): Kind => (/^lesson\b/i.test(content) ? 'lesson' : 'fact')

export const activeObservations = (l: Ledger): Observation[] => l.observations.filter(o => !o.dropped)
const ofKind = (l: Ledger, kind: Kind): Observation[] => activeObservations(l).filter(o => o.kind === kind)

const itemTokens = (items: { content: string }[]): number => items.reduce((n, x) => n + estimateTokens(x.content) + 8, 0)

export const poolTokens = (l: Ledger): number => itemTokens(activeObservations(l))
export const kindTokens = (l: Ledger, kind: Kind): number => itemTokens(ofKind(l, kind))
export const kindBudget = (poolMax: number, kind: Kind): number => Math.floor(poolMax * KIND_SHARE[kind])

/** Lasting kinds over their share, for the consolidator. */
export const overBudgetKinds = (l: Ledger, poolMax: number): Kind[] =>
  KINDS.filter(k => LASTING.has(k) && kindTokens(l, k) > kindBudget(poolMax, k))

const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

export const renderObservation = (o: Observation): string => `[${o.id}] ${stamp(o.at)} [${o.relevance}] ${o.content}`

/** Active items under a heading per kind; the summary's memory block and the workers' view. */
export const renderMemory = (l: Ledger, level = '##'): string =>
  KINDS.map(k => {
    const items = ofKind(l, k)
    return items.length === 0 ? '' : `${level} ${KIND_TITLE[k]}\n${items.map(o => `- ${renderObservation(o)}`).join('\n')}`
  })
    .filter(Boolean)
    .join('\n\n')

// ── legacy ledgers ───────────────────────────────────────────────────────

type LegacyReflection = { id: string; content: string; sources: string[]; at: number; dropped?: boolean }
type LegacyObservation = Omit<Observation, 'kind'> & { kind?: unknown; reflected?: boolean }

/**
 * Read a stored ledger. One from before kinds (observations plus a separate
 * reflection layer) becomes one layer: a reflection turns into an item citing
 * its observations' entries, and the observations it covered give way to it.
 */
export const migrateLedger = (raw: Record<string, unknown>): Ledger => {
  const empty = emptyLedger()
  const usage = { ...empty.usage, ...(isRecord(raw.usage) ? raw.usage : {}) }
  const base: Ledger = {
    ...empty,
    observed: strings(raw.observed),
    usage,
    lastCycle: raw.lastCycle as Ledger['lastCycle'],
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
  }
  const legacy = (Array.isArray(raw.observations) ? raw.observations : []) as LegacyObservation[]
  const observations: Observation[] = legacy.map(({ reflected: _, ...o }) =>
    isKind(o.kind) ? { ...o, kind: o.kind } : { ...o, kind: inferKind(o.content), unclassified: true },
  )
  if (raw.version === 2) return { ...base, observations }

  const byId = new Map(observations.map(o => [o.id, o]))
  const reflections = (Array.isArray(raw.reflections) ? raw.reflections : []) as LegacyReflection[]
  const promoted: Observation[] = reflections.map(r => {
    const cited = r.sources.map(id => byId.get(id)).filter((o): o is Observation => o !== undefined)
    return {
      id: r.id,
      kind: inferKind(r.content),
      content: r.content,
      relevance: cited.some(o => o.relevance === 'critical') ? 'critical' : 'high',
      sources: [...new Set(cited.flatMap(o => o.sources))],
      at: r.at,
      supersedes: r.sources,
      unclassified: true,
      ...(r.dropped ? { dropped: true } : {}),
    }
  })
  const coveredBy = new Map(promoted.filter(p => !p.dropped).flatMap(p => (p.supersedes ?? []).map(id => [id, p.id] as const)))
  const kept = observations.map(o => {
    const by = coveredBy.get(o.id)
    return by && !o.dropped ? { ...o, dropped: true, supersededBy: by } : o
  })
  return { ...base, observations: [...kept, ...promoted] }
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

Your memory items are the ONLY information a future assistant session will have about this conversation once the raw transcript is compacted away, apart from a mechanical summary (goal, files changed, commits, open errors) and a search tool over the raw history. Anything you do not capture must be searched for; anything you distort is remembered wrong.

You receive the current memory, grouped by kind, and a new chunk of conversation. Each source block in the chunk starts with "[Source entry id: <id>]".

Reply with ONE JSON object and nothing else:
{"observations":[{"kind":"constraint|lesson|decision|state|fact","content":"...","relevance":"critical|high|medium|low","sourceEntryIds":["<id>", "..."],"supersedes":["<memory id>", "..."]}]}

Kinds, and how long each lives:
- constraint: what the user requires, forbids or corrected ("always use pnpm", "do not commit without asking"). Kept.
- lesson: what failed, why, and what works instead, as "lesson: <what fails> → <cause> → <what works instead>"; also how to build, test or type-check this project, and where tools and generated files live. Kept. The most valuable kind; never skip one.
- decision: a choice made, with its rationale and the alternatives rejected, so it is not reopened. Kept.
- state: where the work stands: the task in progress, what is done, what is next, open blockers. Only the newest few survive, so write it to stand alone.
- fact: anything else worth knowing about the code or results. Dropped first; the raw history stays searchable.

Rules:
- Record only NEW information from the chunk. Never restate what the memory already holds.
- When an item changes or replaces a current memory item (a newer state, a revised decision, a test count that moved, a plan that was replaced, a thing that now exists), write the new item and list the old item's id in "supersedes". The old item is retired.
- Every item cites the smallest exact set of source entry ids that support it, copied from the chunk. Never invent ids; items without valid ids are discarded.
- One item per fact, one line of plain prose, no markdown, no kind or relevance inside the content.
- Self-contained: no "option B", "the issue above", pronouns or conversation-internal labels. Keep stable identifiers verbatim: file paths with line numbers, function and package names, commit SHAs, error messages quoted exactly, numbers with units.
- Preserve user assertions as assertions and questions as questions; quote the user's unusual terms.
- Record outcomes, not requests. Skip workflow narration, routine test runs, pushes and session bookkeeping; a passing test count or a pushed commit is state at most.
- Skip what the code or git history already records (a function's signature, a file's contents); record why, not what.
- Write the content in the language the user writes in (the user's messages, not the tool output or the system prompt), keeping identifiers, paths and quoted errors verbatim.
- Relevance: critical = user identity, explicit corrections, completions that must not be redone; high = decisions with rationale, lessons, unresolved blockers; medium = task-level context (default when unsure); low = routine, re-derivable.
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
  ['## Current memory', renderMemory(l, '###') || '(none)', '## New conversation chunk', chunkText].join('\n\n')

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
    const kind = isKind(item.kind) ? item.kind : inferKind(content)
    const supersedes = strings(item.supersedes)
    const latest = Math.max(...sources.map(id => valid.get(id)?.at ?? at))
    out.push({ id: hashId(`o:${content}:${sources.join(',')}`), kind, content, relevance, sources, at: latest, ...(supersedes.length ? { supersedes } : {}) })
  }
  return out
}

const retire = (l: Ledger, by: Map<string, string | undefined>): Ledger => ({
  ...l,
  observations: l.observations.map(o =>
    by.has(o.id) && !o.dropped ? { ...o, dropped: true, ...(by.get(o.id) ? { supersededBy: by.get(o.id) } : {}) } : o,
  ),
})

/** Add items, skipping duplicates of active ones; retire the active items they supersede. */
export const addObservations = (l: Ledger, obs: Observation[], chunk: Entry[]): Ledger => {
  const active = new Set(activeObservations(l).map(o => o.id))
  const have = new Set(activeObservations(l).map(o => o.content.toLowerCase()))
  const ids = new Set(l.observations.map(o => o.id))
  const fresh = obs
    .filter(o => !have.has(o.content.toLowerCase()) && !ids.has(o.id))
    .map((o): Observation => {
      const supersedes = (o.supersedes ?? []).filter(id => active.has(id))
      const { supersedes: _, ...rest } = o
      return supersedes.length > 0 ? { ...rest, supersedes } : rest
    })
  const by = new Map(fresh.flatMap(o => (o.supersedes ?? []).map(id => [id, o.id] as const)))
  const observed = [...l.observed, ...chunk.map(e => e.id)].slice(-20000)
  const next = retire(l, by)
  return { ...next, observations: [...next.observations, ...fresh], observed }
}

// ── consolidator ─────────────────────────────────────────────────────────

export const CONSOLIDATOR_SYSTEM = `You keep a coding assistant's long-lived memory within its budget.

You receive the memory items of each kind that is over its token budget (constraints, lessons or decisions), each with an id and relevance. Make the kind fit: merge items that say the same thing, or that one rule or decision covers, into one; retire items that are stale, superseded or no longer useful. Keep unresolved blockers, user corrections and lessons that still hold. Never weaken a constraint.

Reply with ONE JSON object and nothing else:
{"merged":[{"content":"...","relevance":"critical|high|medium|low","replaces":["<id>", "..."]}],"retire":["<id>", "..."]}

Rules:
- A merged item replaces the items listed in "replaces" (ids copied exactly, all of one kind); it keeps their sources. One line of plain prose, self-contained, identifiers verbatim, in the language of the items.
- Retire only what is no longer true or useful; merging is preferred to retiring.
- Empty arrays are a valid answer.`

export const consolidatorPrompt = (l: Ledger, poolMax: number): string =>
  overBudgetKinds(l, poolMax)
    .map(k => {
      const over = kindTokens(l, k) - kindBudget(poolMax, k)
      return `## ${KIND_TITLE[k]} (about ${over} tokens over its ${kindBudget(poolMax, k)}-token budget)\n${ofKind(l, k)
        .map(o => `- ${renderObservation(o)}`)
        .join('\n')}`
    })
    .join('\n\n')

export const applyConsolidation = (l: Ledger, reply: string, at: number, poolMax: number): Ledger | undefined => {
  const json = parseJson(reply)
  if (!isRecord(json)) return undefined
  const open = new Map(overBudgetKinds(l, poolMax).flatMap(k => ofKind(l, k)).map(o => [o.id, o]))
  const by = new Map<string, string | undefined>()
  const added: Observation[] = []
  for (const item of Array.isArray(json.merged) ? json.merged : []) {
    if (!isRecord(item) || typeof item.content !== 'string') continue
    const content = oneLine(item.content)
    const replaced = strings(item.replaces)
      .map(id => open.get(id))
      .filter((o): o is Observation => o !== undefined && !by.has(o.id))
    const kind = replaced[0]?.kind
    if (!content || !kind) continue
    const same = replaced.filter(o => o.kind === kind)
    const sources = [...new Set(same.flatMap(o => o.sources))]
    const top = same.reduce<Relevance>((r, o) => (RANK[o.relevance] > RANK[r] ? o.relevance : r), 'low')
    const relevance = RELEVANCE.includes(item.relevance as Relevance) ? (item.relevance as Relevance) : top
    const id = hashId(`o:${content}:${sources.join(',')}`)
    for (const o of same) by.set(o.id, id)
    added.push({ id, kind, content, relevance, sources, at, supersedes: same.map(o => o.id) })
  }
  for (const id of strings(json.retire)) if (open.has(id) && !by.has(id)) by.set(id, undefined)
  const next = retire(l, by)
  return { ...next, observations: [...next.observations, ...added] }
}

/**
 * Deterministic finisher: trim each kind to its share, lowest relevance then
 * oldest first, critical items last.
 */
export const fitBudgets = (l: Ledger, poolMax: number): Ledger => {
  const drop = new Set<string>()
  for (const k of KINDS) {
    let over = kindTokens(l, k) - kindBudget(poolMax, k)
    const order = ofKind(l, k)
      .filter(o => !o.unclassified)
      .sort((a, z) => RANK[a.relevance] - RANK[z.relevance] || a.at - z.at)
    for (const o of order) {
      if (over <= 0) break
      drop.add(o.id)
      over -= estimateTokens(o.content) + 8
    }
  }
  return drop.size === 0 ? l : { ...l, observations: l.observations.map(o => (drop.has(o.id) ? { ...o, dropped: true } : o)) }
}

// ── classifier (migrated ledgers only) ───────────────────────────────────

export const unclassified = (l: Ledger): Observation[] => activeObservations(l).filter(o => o.unclassified)

export const CLASSIFIER_SYSTEM = `You sort a coding assistant's memory items into kinds. Each kind lives differently:
- constraint: what the user requires, forbids or corrected. Kept.
- lesson: what failed, why, and what works instead; how to build, test or type-check the project. Kept.
- decision: a choice made, with its rationale or the alternatives rejected. Kept.
- state: progress: what is done, in progress or next; test counts, pushes, releases. Only the newest survive.
- fact: anything else about the code or results, re-derivable from the code or history. Dropped first.

Reply with ONE JSON object and nothing else, giving every item id a kind: {"kinds":{"<id>":"<kind>", "...":"..."}}`

export const classifierPrompt = (l: Ledger): string => unclassified(l).map(o => `- ${renderObservation(o)}`).join('\n')

/** Settle the kinds the classifier named; an item it skipped keeps its guessed kind. */
export const applyClassification = (l: Ledger, reply: string): Ledger | undefined => {
  const json = parseJson(reply)
  const kinds = isRecord(json) && isRecord(json.kinds) ? json.kinds : undefined
  if (!kinds) return undefined
  return {
    ...l,
    observations: l.observations.map(o => {
      if (!o.unclassified) return o
      const { unclassified: _, ...rest } = o
      const kind = kinds[o.id]
      return isKind(kind) ? { ...rest, kind } : rest
    }),
  }
}
