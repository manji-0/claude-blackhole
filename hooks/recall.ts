// Recall: search and expand the whole session history (archived entries
// plus the live transcript) and the memory ledger.
import type { Ledger } from './memory'
import type { Entry } from './vcc'
import { renderObservation } from './memory'
import { clip, searchTokens } from './text'
import { relativize, toolOneLiner } from './vcc'

export const RECALL_MAX_CHARS = 48000
const PAGE_SIZE = 8
const HIT_SNIPPET = 360
const EXPAND_TOOL_TEXT = 4000

export type RecallQuery =
  | { kind: 'id'; id: string }
  | { kind: 'index'; index: number; drill?: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'file'; path: string }
  | { kind: 'text'; text: string }

export type ParsedQuery = { query: RecallQuery; page: number; scope: 'all' | 'history' | 'memory' }

export const parseQuery = (raw: string): ParsedQuery | { error: string } => {
  let text = raw.trim()
  let page = 1
  let scope: ParsedQuery['scope'] = 'all'
  let mode: string | undefined
  text = text
    .replace(/(?:^|\s)page:(\d+)\b/g, (_, n: string) => {
      page = Math.max(1, Number(n))
      return ' '
    })
    .replace(/(?:^|\s)scope:(all|history|memory)\b/g, (_, s: ParsedQuery['scope']) => {
      scope = s
      return ' '
    })
    .replace(/(?:^|\s)mode:(file|text|regex)\b/g, (_, m: string) => {
      mode = m
      return ' '
    })
    .trim()
  if (!text) return { error: 'empty query' }
  if (mode === 'file') return { query: { kind: 'file', path: text }, page, scope }
  const index = text.match(/^#(\d+)(?::(.+))?$/s)
  if (index?.[1]) return { query: { kind: 'index', index: Number(index[1]), drill: index[2]?.trim() }, page, scope }
  if (/^[0-9a-f]{12}$/.test(text)) return { query: { kind: 'id', id: text }, page, scope }
  const slashed = text.match(/^\/(.+)\/([imsu]*)$/s)
  if (slashed?.[1] || mode === 'regex') {
    try {
      return { query: { kind: 'regex', re: new RegExp(slashed?.[1] ?? text, slashed?.[2] || 'i') }, page, scope }
    } catch (err) {
      return { error: `bad regex: ${String(err)}` }
    }
  }
  return { query: { kind: 'text', text }, page, scope }
}

/** An entry as searchable lines: string inputs (commands, scripts, file contents) keep their own lines. */
const entryHaystack = (e: Entry): string =>
  [
    e.text,
    ...e.tools.map(t =>
      [t.name, ...Object.entries(t.input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`), t.text].join('\n'),
    ),
  ].join('\n')

const label = (e: Entry): string => `#${e.index ?? '?'} [${e.id}] ${e.role}`

const snippetAround = (hay: string, at: number): string => {
  const start = Math.max(0, at - HIT_SNIPPET / 2)
  const s = hay.slice(start, start + HIT_SNIPPET).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${s}${start + HIT_SNIPPET < hay.length ? '…' : ''}`
}

/** An entry in full: its text and each tool call with its result. */
export const expandEntry = (e: Entry, cwd?: string): string => {
  const lines = [`${label(e)}`]
  if (e.text) lines.push(e.text)
  for (const t of e.tools) {
    lines.push(`\n• ${toolOneLiner(t, cwd)}${t.isError ? ' (error)' : ''}`)
    const input = JSON.stringify(t.input)
    if (input.length > 2) lines.push(`  input: ${clip(input, EXPAND_TOOL_TEXT)}`)
    if (t.text) lines.push(clip(t.text, EXPAND_TOOL_TEXT))
  }
  return lines.join('\n')
}

const drillDown = (e: Entry, needle: string, page: number): string => {
  const hay = entryHaystack(e).split('\n')
  const lower = needle.toLowerCase()
  const hits = hay.map((l, i) => ({ l, i })).filter(({ l }) => l.toLowerCase().includes(lower))
  if (hits.length === 0) return `${label(e)}: no line matches "${needle}".`
  const slice = hits.slice((page - 1) * 40, page * 40)
  const out = slice.map(({ l, i }) => `${i + 1}: ${clip(l, 400)}`)
  const more = hits.length > page * 40 ? `\n(more: "#${e.index}:${needle} page:${page + 1}")` : ''
  return `${label(e)} lines matching "${needle}" (${hits.length}):\n${out.join('\n')}${more}`
}

// ── BM25 ─────────────────────────────────────────────────────────────────

type Doc = { ref: string; text: string; tokens: string[] }

export const bm25 = (docs: Doc[], query: string): { ref: string; score: number }[] => {
  const q = [...new Set(searchTokens(query))]
  if (q.length === 0 || docs.length === 0) return []
  const k1 = 1.2
  const b = 0.75
  const avg = docs.reduce((n, d) => n + d.tokens.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  const scored: { ref: string; score: number }[] = []
  for (const d of docs) {
    const tf = new Map<string, number>()
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const t of q) {
      const f = tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avg))
    }
    if (score > 0) scored.push({ ref: d.ref, score })
  }
  return scored.sort((a, z) => z.score - a.score)
}

const firstHitOffset = (hay: string, query: string): number => {
  const lower = hay.toLowerCase()
  for (const t of searchTokens(query)) {
    const at = lower.indexOf(t)
    if (at >= 0) return at
  }
  return 0
}

// ── the recall call ──────────────────────────────────────────────────────

export type RecallInput = { corpus: Entry[]; ledger: Ledger; cwd?: string }

const cap = (text: string): string =>
  text.length <= RECALL_MAX_CHARS
    ? text
    : `${text.slice(0, RECALL_MAX_CHARS)}\n…(truncated at ${RECALL_MAX_CHARS} chars; narrow the query or use page:N / #N:<text>)`

const paged = <T>(items: T[], page: number): { slice: T[]; footer: string } => {
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  return { slice, footer: pages > 1 ? `\n(page ${page}/${pages}; add page:${page + 1} for more)` : '' }
}

export const recall = (raw: string, { corpus, ledger, cwd }: RecallInput): string => {
  const parsed = parseQuery(raw)
  if ('error' in parsed) return `recall: ${parsed.error}`
  const { query, page, scope } = parsed
  const byId = new Map(corpus.map(e => [e.id, e]))

  if (query.kind === 'index') {
    const e = corpus.find(x => x.index === query.index)
    if (!e) return `recall: no entry #${query.index} (history has #0..#${corpus.length - 1}).`
    if (query.drill) return cap(drillDown(e, query.drill, page))
    const related = ledger.observations.filter(o => o.sources.includes(e.id) && !o.dropped)
    const rel = related.length > 0 ? `\n\nRelated memory:\n${related.map(o => `- ${renderObservation(o)}`).join('\n')}` : ''
    return cap(expandEntry(e, cwd) + rel)
  }

  if (query.kind === 'id') {
    const obs = ledger.observations.find(o => o.id === query.id)
    if (obs) {
      const src = obs.sources.map(id => byId.get(id)).filter((e): e is Entry => e !== undefined)
      const status = obs.supersededBy ? ` (superseded by ${obs.supersededBy})` : obs.dropped ? ' (dropped)' : ''
      const replaced = (obs.supersedes ?? [])
        .map(id => ledger.observations.find(o => o.id === id))
        .filter(o => o !== undefined)
        .map(o => `- ${renderObservation(o)}`)
      return cap(
        [
          `Memory item (${obs.kind}) ${renderObservation(obs)}${status}`,
          ...(replaced.length > 0 ? [`Replaces:\n${replaced.join('\n')}`] : []),
          'Source entries:',
          ...src.map(e => expandEntry(e, cwd)),
        ].join('\n\n'),
      )
    }
    const e = byId.get(query.id)
    return e ? cap(expandEntry(e, cwd)) : `recall: no memory item or entry has id ${query.id}.`
  }

  if (query.kind === 'file') {
    const needle = query.path.toLowerCase()
    const hits = corpus.filter(e =>
      e.tools.some(t => {
        const p = t.input.file_path ?? t.input.notebook_path ?? t.input.path ?? t.input.command
        return typeof p === 'string' && relativize(p, cwd).toLowerCase().includes(needle)
      }),
    )
    if (hits.length === 0) return `recall: no tool call touched "${query.path}".`
    const { slice, footer } = paged([...hits].reverse(), page)
    return cap(
      `${hits.length} entries touched "${query.path}" (newest first):\n` +
        slice.map(e => `- ${label(e)}: ${e.tools.map(t => toolOneLiner(t, cwd)).join('; ')}`).join('\n') +
        footer,
    )
  }

  const memoryDocs: Doc[] =
    scope === 'history'
      ? []
      : [
          ...ledger.observations.filter(o => !o.dropped).map(o => ({ ref: `o:${o.id}`, text: o.content, tokens: searchTokens(o.content) })),
        ]
  const entryDocs: Doc[] =
    scope === 'memory' ? [] : corpus.map(e => ({ ref: `e:${e.id}`, text: entryHaystack(e), tokens: [] }))

  const render = (ref: string, at: number): string => {
    const [kind, id] = [ref.slice(0, 1), ref.slice(2)]
    if (kind === 'o') {
      const o = ledger.observations.find(x => x.id === id)
      return o ? `- memory (${o.kind}) ${renderObservation(o)}` : ''
    }
    const e = byId.get(id)
    return e ? `- ${label(e)}: ${snippetAround(entryHaystack(e), at)}` : ''
  }

  if (query.kind === 'regex') {
    const hits: { ref: string; at: number }[] = []
    for (const d of [...memoryDocs, ...entryDocs]) {
      const m = query.re.exec(d.text)
      if (m) hits.push({ ref: d.ref, at: m.index })
    }
    if (hits.length === 0) return `recall: nothing matches ${String(query.re)}.`
    const { slice, footer } = paged(hits.reverse(), page)
    return cap(`${hits.length} matches for ${String(query.re)} (newest first):\n${slice.map(h => render(h.ref, h.at)).join('\n')}${footer}`)
  }

  for (const d of entryDocs) d.tokens = searchTokens(d.text)
  const ranked = bm25([...memoryDocs, ...entryDocs], query.text)
  if (ranked.length === 0) return `recall: nothing matches "${query.text}". Try a regex (/.../), a file (mode:file <path>) or #N.`
  const texts = new Map([...memoryDocs, ...entryDocs].map(d => [d.ref, d.text]))
  const { slice, footer } = paged(ranked, page)
  return cap(
    `${ranked.length} results for "${query.text}" (best first; expand with #N or an id):\n` +
      slice.map(h => render(h.ref, firstHitOffset(texts.get(h.ref) ?? '', query.text))).join('\n') +
      footer,
  )
}

export const RECALL_DESCRIPTION = `Search this session's full history, including everything compacted away, and its observational memory.

query forms:
- free text: BM25-ranked search over past messages, tool calls, results and memory (English or Japanese)
- #N: expand entry N in full (indices appear as #N in the compaction summary)
- #N:<text>: lines of entry N containing <text>
- <12-hex id>: a memory item with its source evidence and what it replaced, or an entry
- /regex/flags: regex search
- mode:file <path>: entries whose tool calls touched a path
- filters: scope:all|history|memory, page:N

Use it before redoing work or guessing at exact code, errors, paths or decisions from before a compaction.`
