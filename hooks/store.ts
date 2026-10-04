// Disk state, per session, under ~/.claude/blackhole/<session id>/:
//   meta.json      archive bookkeeping (entry keys, counts, segments)
//   seg-NNNN.json  archived entries, in segments well under $.fs.read's 4 MiB
//   ledger.json    observational memory
//   sections.json  the last compaction's sections, for merging the next one
import type { SessionMessage } from 'claude-code'

import type { Ledger } from './memory'
import type { Entry, Sections } from './vcc'
import { migrateLedger } from './memory'
import { toEntries } from './vcc'

/** `ids` are the archived entries' ids (hashes of their keys), kept short for the read limit. */
type Meta = { count: number; segments: number; ids: string[] }
type StoredSections = { hash: string; sections: Sections }

// $.fs.read refuses files over 4 MiB; Japanese text is ~3 bytes a char, so cap by bytes.
const SEGMENT_MAX_BYTES = 1_000_000
const bytes = (text: string): number => new TextEncoder().encode(text).length

/** What the store needs from the engine; register.ts builds it over `$`. */
export type Io = {
  dir: string
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  now: () => Promise<number>
  messages: () => Promise<readonly SessionMessage[]>
}

/** One entry past this is clipped harder, so no segment nears $.fs.read's limit. */
const ENTRY_MAX_BYTES = 2_000_000
const ENTRY_FALLBACK_CHARS = 8000

const fitEntry = (e: Entry): Entry => {
  if (bytes(JSON.stringify(e)) <= ENTRY_MAX_BYTES) return e
  const cut = (v: unknown) => (typeof v === 'string' && v.length > ENTRY_FALLBACK_CHARS ? `${v.slice(0, ENTRY_FALLBACK_CHARS - 1)}…` : v)
  return {
    ...e,
    text: cut(e.text) as string,
    tools: e.tools.map(t => ({ ...t, text: cut(t.text) as string, input: Object.fromEntries(Object.entries(t.input).map(([k, v]) => [k, cut(v)])) })),
  }
}

const segName = (n: number): string => `seg-${String(n).padStart(4, '0')}.json`

let queue: Promise<unknown> = Promise.resolve()
/** Run disk work one at a time, so the observer and a compaction never interleave writes. */
export const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * A missing file is the fallback; an unreadable one throws, so no write
 * builds on a state that was not read (a compaction hook that throws is
 * skipped and core compacts instead).
 */
const readJson = async <T>(io: Io, path: string, fallback: T): Promise<T> => {
  if (!(await io.exists(path))) return fallback
  const text = await io.read(path)
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`blackhole: ${path} is not valid JSON (${String(err)})`)
  }
}

const loadMeta = async (io: Io, dir: string): Promise<Meta> =>
  readJson<Meta>(io, `${dir}/meta.json`, { count: 0, segments: 0, ids: [] })

export const loadArchive = async (io: Io): Promise<Entry[]> => {
  const dir = io.dir
  const meta = await loadMeta(io, dir)
  const out: Entry[] = []
  for (let n = 1; n <= meta.segments; n++) out.push(...(await readJson<Entry[]>(io, `${dir}/${segName(n)}`, [])))
  return out
}

/** Append entries not archived yet; resolves the number newly archived. */
export const archiveEntries = async (io: Io, entries: Entry[], now: number): Promise<number> => {
  const dir = io.dir
  const meta = await loadMeta(io, dir)
  const known = new Set(meta.ids)
  const fresh = entries.filter(e => !known.has(e.id))
  if (fresh.length === 0) return 0
  let seg = meta.segments === 0 ? [] : await readJson<Entry[]>(io, `${dir}/${segName(meta.segments)}`, [])
  let segments = Math.max(1, meta.segments)
  let size = bytes(JSON.stringify(seg))
  let count = meta.count
  for (const e of fresh) {
    const stored: Entry = fitEntry({ ...e, index: count++, at: e.at ?? now })
    const len = bytes(JSON.stringify(stored))
    if (seg.length > 0 && size + len > SEGMENT_MAX_BYTES) {
      await io.write(`${dir}/${segName(segments)}`, JSON.stringify(seg))
      segments++
      seg = []
      size = 2
    }
    seg.push(stored)
    size += len + 1
    known.add(e.id)
  }
  await io.write(`${dir}/${segName(segments)}`, JSON.stringify(seg))
  await io.write(`${dir}/meta.json`, JSON.stringify({ count, segments, ids: [...known] } satisfies Meta))
  return fresh.length
}

/**
 * The whole history: archived entries, then live entries not archived yet,
 * indexed on after the archive.
 */
export const corpus = async (io: Io, live?: readonly SessionMessage[]): Promise<Entry[]> => {
  const archived = await loadArchive(io)
  const known = new Set(archived.map(e => e.key))
  const messages = live ?? (await io.messages())
  const now = await io.now()
  let next = archived.length > 0 ? Math.max(...archived.map(e => e.index ?? 0)) + 1 : 0
  const rest = toEntries(messages)
    .filter(e => !known.has(e.key))
    .map(e => ({ ...e, index: next++, at: now }))
  return [...archived, ...rest]
}

export const loadLedger = async (io: Io): Promise<Ledger> =>
  migrateLedger(await readJson<Record<string, unknown>>(io, `${io.dir}/ledger.json`, {}))

export const saveLedger = async (io: Io, ledger: Ledger): Promise<void> =>
  io.write(`${io.dir}/ledger.json`, JSON.stringify(ledger))

export const loadSections = async (io: Io): Promise<StoredSections | undefined> =>
  readJson<StoredSections | undefined>(io, `${io.dir}/sections.json`, undefined)

export const saveSections = async (io: Io, stored: StoredSections): Promise<void> =>
  io.write(`${io.dir}/sections.json`, JSON.stringify(stored))
