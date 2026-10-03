// Text utilities shared by the compaction, recall and memory pipelines.

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/
const CJK_GLOBAL_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g

export const hasCjk = (text: string): boolean => CJK_RE.test(text)

/** Rough token estimate: ~4 chars per token for ASCII, ~1 token per CJK char. */
export const estimateTokens = (text: string): number => {
  const cjk = text.match(CJK_GLOBAL_RE)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** Clip at a sentence boundary inside `max` when there is one past the midpoint. */
export const clipSentence = (text: string, max: number): string => {
  if (text.length <= max) return text
  const window = text.slice(0, max)
  const cut = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('。'),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  )
  return cut > max / 2 ? window.slice(0, cut + 1) : clip(text, max)
}

export const nonEmptyLines = (text: string): string[] =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)

export const firstLine = (text: string, max: number): string =>
  clip(nonEmptyLines(text)[0] ?? '', max)

/** 12-hex id: two FNV-1a 32-bit passes with different seeds. */
export const hashId = (text: string): string => {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 12)
}

/** Strip ANSI escapes and control characters other than newline and tab. */
export const sanitize = (text: string): string =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

/** Wrappers the engine injects into user text that carry no user intent. */
const WRAPPER_RE =
  /<(system-reminder|ide_opened_file|ide_selection|command-message|command-name|command-args|local-command-stdout|local-command-caveat|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g

export const stripWrappers = (text: string): string => text.replace(WRAPPER_RE, '').trim()

/** Tokenize for BM25: lowercase words, plus CJK character bigrams. */
export const searchTokens = (text: string): string[] => {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9_$.\-/]{2,}/g)) {
    const t = m[0].replace(/^[.\-/]+|[.\-/]+$/g, '')
    if (t.length >= 2) out.push(t)
    for (const part of t.split(/[.\-/_]+/)) if (part.length >= 2 && part !== t) out.push(part)
  }
  for (const run of lower.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g) ?? []) {
    if (run.length === 1) out.push(run)
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}
