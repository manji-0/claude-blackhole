// VCC: deterministic, model-free compaction. Session messages become entries,
// entries become sections (goal, files, commits, outstanding context,
// preferences, brief transcript), sections become one summary message.
import type { SessionMessage } from 'claude-code'

import {
  clip,
  clipSentence,
  estimateTokens,
  firstLine,
  hasCjk,
  hashId,
  nonEmptyLines,
  sanitize,
  stripWrappers,
} from './text'

export type EntryTool = {
  name: string
  input: Record<string, unknown>
  text: string
  isError: boolean
}

/** One user or assistant message as blackhole keeps it: archived, searched, observed. */
export type Entry = {
  id: string
  key: string
  role: 'user' | 'assistant'
  text: string
  tools: EntryTool[]
  /** Position in the session's whole history (archive order), set on archiving. */
  index?: number
  at?: number
}

export type Sections = {
  sessionGoal: string[]
  filesAndChanges: string[]
  commits: string[]
  outstandingContext: string[]
  userPreferences: string[]
  /** Where the work stood when compacted: the last request, the last reply, the calls after it. */
  currentState?: string[]
  briefTranscript: string
}

export const SUMMARY_SENTINEL = '[blackhole compaction summary]'

export const isSummaryText = (text: string): boolean => text.startsWith(SUMMARY_SENTINEL)

// Entries are archived whole for recall; these caps only bound a runaway
// field. Every renderer (summary, observer, recall) clips on its own.
const TOOL_TEXT_MAX = 32_000
const INPUT_FIELD_MAX = 32_000

const shrinkInput = (input: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = clip(v, INPUT_FIELD_MAX)
    else if (v !== null && typeof v === 'object') out[k] = clip(JSON.stringify(v), INPUT_FIELD_MAX)
    else out[k] = v
  }
  return out
}

/**
 * Session messages to entries. Summary messages and rows that only carry
 * tool results (their outcome rides on the assistant's tool uses) are dropped.
 */
export const toEntries = (messages: readonly SessionMessage[]): Entry[] => {
  const entries: Entry[] = []
  let prevKey = ''
  for (const m of messages) {
    if (isSummaryText(m.text)) continue
    if (m.role === 'user') {
      const text = stripWrappers(sanitize(m.text))
      if (!text) continue
      const key = `u:${hashId(`${prevKey}\n${text}`)}`
      entries.push({ id: hashId(key), key, role: 'user', text, tools: [] })
      prevKey = key
      continue
    }
    const tools: EntryTool[] = m.toolUses.map(u => ({
      name: u.tool,
      input: shrinkInput(u.input),
      text: clip(sanitize(u.text ?? ''), TOOL_TEXT_MAX),
      isError: u.isError === true,
    }))
    const text = sanitize(m.text).trim()
    if (!text && tools.length === 0) continue
    const key =
      m.toolUses.length > 0
        ? `a:${m.toolUses.map(u => u.tool_use_id).join(',')}`
        : `a:${hashId(`${prevKey}\n${text}`)}`
    entries.push({ id: hashId(key), key, role: 'assistant', text, tools })
    prevKey = key
  }
  return entries
}

// ── noise ────────────────────────────────────────────────────────────────

const NOISE_TOOLS = new Set([
  'TodoWrite',
  'TodoRead',
  'ToolSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
])

const isNoiseTool = (name: string): boolean => NOISE_TOOLS.has(name) || name.endsWith('__recall')

export const filterNoise = (entries: Entry[]): Entry[] =>
  entries
    .map(e => ({ ...e, tools: e.tools.filter(t => !isNoiseTool(t.name)) }))
    .filter(e => e.text.length > 0 || e.tools.length > 0)

// ── goals ────────────────────────────────────────────────────────────────

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b|代わりに|やっぱり|方針を?変え|方針変更|ではなく|じゃなくて|切り替え|新しいタスク|今度は|次は|それより|やめて/i

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b|修正|実装|追加|作成|作って|作りたい|直して|リファクタ|調査|調べて|更新|削除|移行|デプロイ|テスト|書いて|設定|構築|導入|対応して|変更して/i

const NOISE_SHORT_RE =
  /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k|はい|いいえ|うん|ok です|お願いします|ありがとう.*|続けて|どうぞ)\s*[.!?。！？]*$/i

const NON_GOAL_RE =
  /^\s*[[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])\S*$|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/

const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i

const MAX_GOAL_CHARS = 200
const LEADING_CHARS = 200

const stripLeadingBullet = (line: string): string =>
  line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim()

const isSubstantiveGoal = (line: string): boolean => {
  const t = line.trim()
  const min = hasCjk(t) ? 3 : 6
  if (t.length < min || t.length > MAX_GOAL_CHARS) return false
  if (NOISE_SHORT_RE.test(t)) return false
  return !NON_GOAL_RE.test(t)
}

const indexSuffix = (index?: number): string => (index !== undefined ? ` (#${index})` : '')

export const extractGoals = (entries: Entry[]): string[] => {
  const goals: string[] = []
  let latest: string[] | null = null
  let latestIndex: number | undefined
  for (const e of entries) {
    if (e.role !== 'user') continue
    const raw = nonEmptyLines(e.text)
    const cut = raw.findIndex(l => TEMPLATE_SIGNAL_RE.test(l))
    const lines = (cut >= 0 ? raw.slice(0, cut) : raw)
      .filter(isSubstantiveGoal)
      .map(stripLeadingBullet)
      .filter(l => l.length >= (hasCjk(l) ? 3 : 6))
    const first = lines[0]
    if (first === undefined) continue
    if (goals.length === 0) {
      goals.push(...lines.slice(0, 6).map(l => clip(l, MAX_GOAL_CHARS) + indexSuffix(e.index)))
      continue
    }
    const leading = e.text.slice(0, LEADING_CHARS)
    if (SCOPE_CHANGE_RE.test(leading)) {
      latest = lines.slice(0, 3).map(l => clip(l, MAX_GOAL_CHARS))
      latestIndex = e.index
    } else if (TASK_RE.test(leading) && first.length > (hasCjk(first) ? 6 : 15)) {
      latest = lines.slice(0, 2).map(l => clip(l, MAX_GOAL_CHARS))
      latestIndex = e.index
    }
  }
  if (latest && latest.length > 0) for (const l of latest) goals.push(`[Scope change] ${l}${indexSuffix(latestIndex)}`)
  return goals.slice(0, 8)
}

// ── preferences ──────────────────────────────────────────────────────────

const PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
  /\bstop (?:doing|using|adding|running|writing|committing|pushing)\b/i,
  /\b(?:that's|this is) wrong\b/i,
  /\b(?:revert|undo) (?:that|this|the|it|your)\b/i,
  /不要|不用|别再|回退|错了|停止|以后|下次|必须/,
  // Japanese standing instructions and corrections.
  /必ず|常に|いつも|今後|以後|次から|これから(?:は)?|絶対に?|しないで|しないように|使わないで|避けて|禁止|やめて|ではなく|じゃなくて|違います|間違って|元に戻して|好み|優先して/,
]

const INTERROGATIVE_START_RE = /^(?:what|where|when|who|whom|whose|why|how|which)\b/i
const CJK_INTERROGATIVE_RE = /为什么|怎么|如何|什么|哪里|哪个|何|なぜ|なんで|どう|どこ|どれ|どの|いつ|誰/

export const extractPreferences = (entries: Entry[]): string[] => {
  const prefs: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (e.role !== 'user') continue
    for (const line of nonEmptyLines(e.text)) {
      if (line.length < (hasCjk(line) ? 2 : 5) || line.length > 200) continue
      const q = line.replace(/^[“‘"'「『]+/, '').replace(/[”’"'」』]+$/, '')
      const isQuestion = q.endsWith('?') || q.endsWith('？')
      if (isQuestion && (INTERROGATIVE_START_RE.test(q) || CJK_INTERROGATIVE_RE.test(q))) continue
      if (!PREF_PATTERNS.some(p => p.test(line))) continue
      const key = line.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      prefs.push(clip(line, 200) + indexSuffix(e.index))
      break
    }
  }
  return prefs.slice(-10)
}

// ── files ────────────────────────────────────────────────────────────────

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const pathOf = (input: Record<string, unknown>): string | undefined => {
  const p = input.file_path ?? input.notebook_path ?? input.path
  return typeof p === 'string' ? p : undefined
}

export const relativize = (path: string, cwd?: string): string =>
  cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path

// ── shell commands ───────────────────────────────────────────────────────

/**
 * A shell command as simple commands (split on ; && || | and newlines), each
 * a list of words with quotes respected and removed. Heredoc bodies are
 * dropped; `<<EOF` stays as a word.
 */
export const shellCommands = (command: string): string[][] => {
  const src = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, (_m, _q, tag: string, rest: string) => `<<${tag}${rest}`)
  const cmds: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: string | undefined
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) cmds.push(words)
    words = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < src.length) word += src[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < src.length) {
      word += src[++i]
      inWord = true
    } else if (c === ';' || c === '\n') endCommand()
    else if (c === '&' && src[i + 1] === '&') {
      endCommand()
      i++
    } else if (c === '|') {
      endCommand()
      if (src[i + 1] === '|') i++
    } else if (c === ' ' || c === '\t') endWord()
    else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return cmds
}

/** Words without leading `VAR=value` assignments. */
const withoutEnv = (words: string[]): string[] => {
  const i = words.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  return i < 0 ? [] : words.slice(i)
}

/** A command's program, without its directory (`/usr/bin/grep` is grep). */
const programOf = (words: string[]): string => words[0]?.split('/').pop() ?? ''

/** Output redirect targets other than stderr and /dev/null (`> out.txt`, `>>log`). */
const redirectTargets = (words: string[]): string[] => {
  const out: string[] = []
  words.forEach((w, i) => {
    const m = w.match(/^([0-9]?)(>>?|&>)(.*)$/)
    if (!m || m[1] === '2') return
    const target = m[3] || words[i + 1] || ''
    if (!target.startsWith('&') && target !== '/dev/null') out.push(target)
  })
  return out
}

/** A background task's output file: read to follow the task, not part of the work. */
const isTaskOutput = (path: string): boolean => /\/tasks\/[^/]+\.output$/.test(path)

/** Claude Code's own files (memory, task output) under ~/.claude are not the project's. */
const isHarnessPath = (p: string): boolean => /^\/(?:Users|home)\/[^/]+\/\.claude\//.test(p)

const plainPath = (p: string): boolean =>
  p.length > 1 && /[/.]/.test(p) && !/[$*?{}()<>`|\\]/.test(p) && p !== '/dev/null' && !p.startsWith('-') && !isHarnessPath(p)

/**
 * Files a Bash command writes: redirects of cat/echo/printf, tee, sed -i, and
 * Python scripts that write_text or open(.., "w") a literal path. A heuristic;
 * an edit made some other way is missed.
 */
export const bashWrites = (command: string): string[] => {
  const out = new Set<string>()
  // A relative path is relative to where an earlier `cd` in the command went.
  let dir: string | undefined
  const add = (p: string | undefined) => {
    if (!p) return
    const full = dir && !p.startsWith('/') ? `${dir.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}` : p
    if (plainPath(full)) out.add(full)
  }
  for (const raw of shellCommands(command)) {
    const words = withoutEnv(raw)
    const prog = programOf(words)
    if (prog === 'cd') {
      const to = words[1]
      dir = to?.startsWith('/') ? to : dir && to ? `${dir}/${to}` : undefined
      continue
    }
    if (prog === 'cat' || prog === 'echo' || prog === 'printf') for (const t of redirectTargets(words)) add(t)
    if (prog === 'tee') for (const w of words.slice(1)) if (!w.startsWith('-')) add(w)
    if (prog === 'sed' && words.some(w => /^-[a-zA-Z]*i/.test(w)) && words.length > 2) add(words[words.length - 1])
  }
  if (/\.write_text\(|\bopen\([^)]*['"][wa]['"]/.test(command)) {
    for (const m of command.matchAll(/\b(?:Path|open)\(\s*(['"])([^'"]+)\1/g)) add(m[2])
  }
  return [...out]
}

export const extractFiles = (entries: Entry[], cwd?: string): string[] => {
  const modified = new Set<string>()
  const created = new Set<string>()
  const read = new Set<string>()
  for (const e of entries) {
    for (const t of e.tools) {
      if (t.isError) continue
      if (t.name === 'Bash' && typeof t.input.command === 'string') {
        for (const p of bashWrites(t.input.command)) modified.add(relativize(p, cwd))
        continue
      }
      const raw = pathOf(t.input)
      if (!raw || isTaskOutput(raw) || isHarnessPath(raw)) continue
      const p = relativize(raw, cwd)
      if (WRITE_TOOLS.has(t.name)) {
        if (t.name === 'Write' && /created successfully/i.test(t.text) && !modified.has(p)) created.add(p)
        else modified.add(p)
      } else if (READ_TOOLS.has(t.name)) read.add(p)
    }
  }
  for (const p of modified) created.delete(p)
  for (const p of [...modified, ...created]) read.delete(p)
  const lines: string[] = []
  const list = (label: string, set: Set<string>, max: number) => {
    if (set.size === 0) return
    const arr = [...set]
    const more = arr.length > max ? ` (+${arr.length - max} more)` : ''
    lines.push(`${label}: ${arr.slice(0, max).join(', ')}${more}`)
  }
  list('Modified', modified, 20)
  list('Created', created, 20)
  list('Read', read, 10)
  return lines
}

// ── commits ──────────────────────────────────────────────────────────────

const COMMIT_MSG_RES = [
  // -m, or -m among short flags (-qm, -am).
  /git\s+commit\b[^\n]*?\s-[a-zA-Z]*m\s+"([^"]+)"/,
  /git\s+commit\b[^\n]*?\s-[a-zA-Z]*m\s+'([^']+)'/,
  // -F - <<'EOF' (or -m "$(cat <<'EOF'"): the heredoc's first line, on the commit's own line.
  /git\s+commit\b[^\n]*?<<-?\s*['"]?\w+['"]?\)?\s*\n\s*([^\n]+)/,
]
const COMMIT_HASH_RE = /\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,12})\]/

/**
 * Commits as their messages, read from the command; the hash only when git
 * printed it (`-q` prints nothing). A commit whose message cannot be read is
 * left out rather than guessed from output a hook may have printed.
 */
export const extractCommits = (entries: Entry[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    for (const t of e.tools) {
      if (t.name !== 'Bash' || t.isError) continue
      const command = typeof t.input.command === 'string' ? t.input.command : ''
      if (!/\bgit\s+commit\b/.test(command)) continue
      const message = COMMIT_MSG_RES.map(re => command.match(re)?.[1]?.trim().split('\n')[0]?.trim()).find(Boolean)
      if (!message) continue
      const hash = t.text.match(COMMIT_HASH_RE)?.[1]
      const line = `${hash ? `${hash} ` : ''}${clip(message, 120)}`
      if (seen.has(line)) continue
      seen.add(line)
      out.push(line)
    }
  }
  return out.slice(-8)
}

// ── outstanding context ──────────────────────────────────────────────────

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i
const BLOCKER_CJK_RE = /失败|报错|卡住|崩溃|失敗|エラーが|動かない|動きません|落ちる|落ちます|通らない|直らない|うまくいかない|未解決|ブロック/
const CJK_BENIGN_RE = /错误(?:处理|信息|消息|码)|失败(?:重试|率)|エラー(?:処理|ハンドリング|メッセージ)/g
const SENTENCE_START_RE = /^\s*["'`*_【『「]?[A-Z`぀-ヿ㐀-䶿一-鿿]/

const pathTokens = (text: string): Set<string> => {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z0-9_.$/-]*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}\b/g)) out.add(m[0].toLowerCase())
  return out
}

// A failed command that only reads (grep, sed -n, ls, ...) is a lookup that went
// wrong, not unfinished work, once a later command succeeded.
const READ_ONLY_PROGRAMS = new Set(['cat', 'head', 'tail', 'less', 'sed', 'grep', 'rg', 'ag', 'find', 'fd', 'ls', 'tree', 'wc', 'sort', 'uniq', 'cut', 'jq', 'awk', 'echo', 'printf', 'pwd', 'which', 'file', 'stat', 'diff', 'cd', 'true'])
/** What a Bash call runs, for matching a later retry: program and subcommand (`cargo test`, `git push`). */
const commandKey = (command: string): string => {
  const words = shellCommands(command)
    .map(withoutEnv)
    .find(w => w.length > 0 && w[0] !== 'cd')
  if (!words) return ''
  const sub = words[1]
  return sub && /^[a-z][\w:-]*$/.test(sub) ? `${programOf(words)} ${sub}` : programOf(words)
}

const isReadOnly = (command: string): boolean =>
  shellCommands(command)
    .map(withoutEnv)
    .filter(w => w.length > 0)
    .every(w => {
      if (programOf(w) === 'sed' && w.some(x => /^-[a-zA-Z]*i/.test(x))) return false
      if (redirectTargets(w).length > 0) return false
      return READ_ONLY_PROGRAMS.has(programOf(w))
    })

/** Errors and user reports older than this many entries are almost always settled. */
const OUTSTANDING_WINDOW = 60
const DECLINED_RE = /user (doesn't|does not) want to proceed|rejected by the user|denied by the user|user declined/i
const ERROR_LINE_RE = /error|fail|panic|exception|✘|denied|not found|cannot|can't|no such/i

/** "0 failed", "no errors": counts and denials that report success. */
const ZERO_RE = /\b(?:0|no|zero) (?:failed|failures?|errors?|warnings?)\b/gi
const looksLikeError = (line: string): boolean => ERROR_LINE_RE.test(line.replace(ZERO_RE, ''))

/**
 * The line that says what went wrong, not the exit code or a stray output
 * line; undefined when no line reads as an error (a grep that matched
 * nothing, a pipeline whose last step exited non-zero).
 */
const errorLineOf = (text: string): string | undefined => {
  const line = nonEmptyLines(text.replace(/^\s*Exit code \d+\s*\n/, '')).find(looksLikeError)
  return line === undefined ? undefined : clip(line, 200)
}
const errorLine = (text: string): string =>
  errorLineOf(text) ?? clip(nonEmptyLines(text.replace(/^\s*Exit code \d+\s*\n/, ''))[0] ?? '', 200)

/**
 * Unresolved trouble near the end: tool errors no later call settled, and
 * problems the user reported. The assistant's own prose is not scanned; it
 * mentions failures it is already fixing.
 */
export const extractOutstanding = (entries: Entry[]): string[] => {
  type Outcome = { name: string; order: number; command?: string; key?: string; paths: Set<string>; text: string }
  const errors: Outcome[] = []
  const successes: Outcome[] = []
  const pending: { order: number; text: string }[] = []
  const seen = new Set<string>()
  const push = (order: number, text: string): boolean => {
    const key = text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    pending.push({ order, text })
    return true
  }
  let order = 0
  for (const e of entries.slice(-OUTSTANDING_WINDOW)) {
    for (const t of e.tools) {
      const command = typeof t.input.command === 'string' ? t.input.command : undefined
      const o = { name: t.name, order: order++, command, key: command && commandKey(command), paths: pathTokens(t.text), text: t.text }
      if (t.isError && DECLINED_RE.test(t.text)) continue
      ;(t.isError ? errors : successes).push(o)
    }
    const n = order++
    if (e.role !== 'user') continue
    for (const line of nonEmptyLines(e.text)) {
      const scannable = line.replace(CJK_BENIGN_RE, '')
      if (!BLOCKER_RE.test(scannable) && !BLOCKER_CJK_RE.test(scannable)) continue
      if (line.length < (hasCjk(line) ? 3 : 15)) continue
      if (/^\s*[-*+>(]/.test(line) || !SENTENCE_START_RE.test(line)) continue
      if (push(n, `[user] ${clipSentence(line, 200)}`)) break
    }
  }
  const isResolved = (err: Outcome): boolean =>
    (err.name === 'Bash' && err.command !== undefined && isReadOnly(err.command) && successes.some(s => s.name === 'Bash' && s.order > err.order)) ||
    successes.some(s => {
      if (s.name !== err.name || s.order <= err.order) return false
      if (err.name === 'Bash') return s.command !== undefined && (s.command === err.command || (!!err.key && s.key === err.key))
      if (err.paths.size > 0 || s.paths.size > 0) return [...err.paths].some(p => s.paths.has(p))
      return true
    })
  for (const err of errors) {
    const line = errorLineOf(err.text)
    if (line !== undefined && !isResolved(err)) push(err.order, `[${err.name}] ${line}`)
  }
  pending.sort((a, z) => a.order - z.order)
  return pending.slice(-5).map(p => p.text)
}

// ── brief transcript ─────────────────────────────────────────────────────

const USER_BRIEF_TOKENS = 256
const ASSISTANT_BRIEF_TOKENS = 200
const BRIEF_MAX_LINES = 120

const clipTokens = (text: string, tokens: number): string => {
  if (estimateTokens(text) <= tokens) return text
  // Shrink by characters until the estimate fits.
  let hi = text.length
  let lo = 0
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(text.slice(0, mid)) <= tokens) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…`
}

const compressBash = (command: string, max = 120): string =>
  clip(
    command
      .replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '')
      .replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*(;|&&)?\s*)+/, '')
      .replace(/\s*\|\s*(head|tail|sort|wc|uniq)\b[^|]*$/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  )

/**
 * One line per tool call. A Bash call reads as its description (what it was
 * for), the command shortened beside it; `detail` keeps more of the command
 * for the observer, which learns from what exactly failed.
 */
export const toolOneLiner = (t: EntryTool, cwd?: string, detail = false): string => {
  const i = t.input
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  const path = pathOf(i)
  const command = str('command')
  if (t.name === 'Bash' && command) {
    const desc = str('description')?.replace(/\s+/g, ' ').trim()
    const cmd = compressBash(command, detail ? 400 : desc ? 60 : 120)
    return desc ? `Bash: ${clip(desc, 100)} — \`${cmd}\`` : `Bash: ${cmd}`
  }
  if (path) return `${t.name}: ${relativize(path, cwd)}`
  const arg = str('pattern') ?? str('query') ?? str('url') ?? str('description') ?? str('prompt') ?? str('skill')
  return arg ? `${t.name}: ${clip(arg.replace(/\s+/g, ' '), 100)}` : t.name
}

const NOTIFICATION_RE = /^\s*<task-notification>/
const isNotification = (e: Entry): boolean => e.role === 'user' && NOTIFICATION_RE.test(e.text)
const notificationText = (e: Entry): string =>
  `task notification: ${clip(e.text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'a background task finished', 200)}`

/** `mcp__dagayn__query_graph_tool` reads as `query_graph_tool`. */
const shortToolName = (name: string): string => name.split('__').pop() ?? name

/**
 * The conversation's flow: what the user asked and the assistant said, each
 * with its #N. The tool calls between them fold into one line of counts and
 * the #N range to expand with recall; the current state lists the last ones.
 */
export const buildBrief = (entries: Entry[], _cwd?: string): string => {
  const lines: string[] = []
  type Group = { from?: number; to?: number; counts: Map<string, number>; failed: number; total: number }
  let group: Group | undefined
  const flush = () => {
    if (group && group.total > 0) {
      const range = group.from === undefined ? '' : group.from === group.to ? ` #${group.from}` : ` #${group.from}–#${group.to}`
      const names = [...group.counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ')
      lines.push(`  (${group.total} tool call${group.total > 1 ? 's' : ''}${range}: ${names}${group.failed > 0 ? `; ${group.failed} failed` : ''})`)
    }
    group = undefined
  }
  for (const e of entries) {
    const tag = e.index !== undefined ? ` #${e.index}` : ''
    if (isNotification(e)) {
      flush()
      lines.push(`[user${tag}] ${notificationText(e)}`)
      continue
    }
    if (e.role === 'user') {
      flush()
      const text = clipTokens(e.text.replace(/<skill[^>]*name="([^"]+)"[\s\S]*?<\/skill>/g, '[skill: $1]'), USER_BRIEF_TOKENS)
      lines.push(`[user${tag}] ${text.replace(/\n+/g, ' ⏎ ')}`)
      continue
    }
    if (e.text) {
      flush()
      lines.push(`[assistant${tag}] ${clipTokens(e.text, ASSISTANT_BRIEF_TOKENS).replace(/\n+/g, ' ⏎ ')}`)
    }
    if (e.tools.length === 0) continue
    group ??= { counts: new Map(), failed: 0, total: 0 }
    if (e.index !== undefined) {
      group.from ??= e.index
      group.to = e.index
    }
    for (const t of e.tools) {
      const name = shortToolName(t.name)
      group.counts.set(name, (group.counts.get(name) ?? 0) + 1)
      group.total++
      if (t.isError) group.failed++
    }
  }
  flush()
  return lines.join('\n')
}

export const capBrief = (text: string, maxLines = BRIEF_MAX_LINES): string => {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  let kept = lines.slice(-maxLines)
  const firstTurn = kept.findIndex(l => /^\[(user|assistant)/.test(l))
  if (firstTurn > 0) kept = kept.slice(firstTurn)
  return `...(${lines.length - kept.length} earlier lines omitted)\n${kept.join('\n')}`
}

// ── current state ────────────────────────────────────────────────────────

const STATE_USER_TOKENS = 600
const STATE_ASSISTANT_TOKENS = 900
const STATE_PROPOSAL_TOKENS = 500
const STATE_TOOLS = 8
/** Tool calls at the very end that also show the first line of their result. */
const STATE_TOOL_RESULTS = 3
/** A request this short ("go", "案Aで") answers the assistant's last proposal; show that too. CJK packs more per char. */
const isThin = (text: string): boolean => text.trim().length <= (hasCjk(text) ? 20 : 40)

const oneLineState = (text: string, tokens: number): string => clipTokens(text, tokens).replace(/\n+/g, ' ⏎ ')

/**
 * The brief transcript clips every turn; the end of the conversation is what
 * the next turn continues from, so it is kept close to whole. A short request
 * or a task notification means little alone, so the proposal it answers and
 * the last request with substance come with it.
 */
export const buildCurrentState = (entries: Entry[], cwd?: string): string[] => {
  const lastUser = entries.map(e => e.role).lastIndexOf('user')
  const out: string[] = []
  const u = entries[lastUser]
  if (u) {
    if (isNotification(u)) {
      out.push(`Last event${indexSuffix(u.index)}: ${notificationText(u)}`)
    } else {
      out.push(`Last user request${indexSuffix(u.index)}: ${oneLineState(u.text, STATE_USER_TOKENS)}`)
    }
    if (isNotification(u) || isThin(u.text)) {
      const before = entries.slice(0, lastUser)
      const proposal = [...before].reverse().find(e => e.role === 'assistant' && e.text.trim())
      if (proposal) out.push(`It answers the assistant's message${indexSuffix(proposal.index)}: ${oneLineState(proposal.text, STATE_PROPOSAL_TOKENS)}`)
      const request = [...before]
        .reverse()
        .find(e => e.role === 'user' && !isNotification(e) && !isThin(e.text))
      if (request) out.push(`Last substantive request${indexSuffix(request.index)}: ${oneLineState(request.text, STATE_USER_TOKENS)}`)
    }
  }
  const after = entries.slice(lastUser + 1)
  const reply = [...after].reverse().find(e => e.role === 'assistant' && e.text.trim())
  if (reply) out.push(`Last assistant reply${indexSuffix(reply.index)}: ${oneLineState(reply.text, STATE_ASSISTANT_TOKENS)}`)
  const replyAt = reply ? after.indexOf(reply) : -1
  const tools = after.slice(Math.max(replyAt, 0)).flatMap(e => e.tools).slice(-STATE_TOOLS)
  // A read's first line (a line count, a file's first line) says nothing; a build's or test's does.
  const tellsOutcome = (t: EntryTool): boolean =>
    t.name === 'Bash' && typeof t.input.command === 'string' && !isReadOnly(t.input.command) && t.text.trim().length > 0
  tools.forEach((t, i) => {
    const result = t.isError
      ? ` → [tool_error] ${errorLine(t.text)}`
      : i >= tools.length - STATE_TOOL_RESULTS && tellsOutcome(t)
        ? ` → ${firstLine(t.text, 160)}`
        : ''
    out.push(`Then: ${toolOneLiner(t, cwd)}${result}`)
  })
  return out
}

// ── sections and summary ─────────────────────────────────────────────────

export const buildSections = (entries: Entry[], cwd?: string): Sections => {
  const clean = filterNoise(entries)
  const sessionGoal = extractGoals(clean)
  const goalSet = new Set(sessionGoal.map(g => g.toLowerCase()))
  return {
    sessionGoal,
    filesAndChanges: extractFiles(clean, cwd),
    commits: extractCommits(clean),
    outstandingContext: extractOutstanding(clean),
    userPreferences: extractPreferences(clean).filter(p => !goalSet.has(p.toLowerCase())),
    currentState: buildCurrentState(clean, cwd),
    briefTranscript: buildBrief(clean, cwd),
  }
}

const mergeList = (prev: string[], next: string[], cap: number): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...prev, ...next]) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.slice(-cap)
}

const mergeFiles = (prev: string[], next: string[]): string[] => {
  const parse = (lines: string[]) => {
    const m = new Map<string, string[]>()
    for (const l of lines) {
      const [label, rest] = l.split(/:\s(.*)/s)
      if (!label || rest === undefined) continue
      const items = rest.replace(/\s\(\+\d+ more\)$/, '').split(', ')
      m.set(label, [...(m.get(label) ?? []), ...items])
    }
    return m
  }
  const a = parse(prev)
  const b = parse(next)
  const out: string[] = []
  const modified = new Set([...(a.get('Modified') ?? []), ...(b.get('Modified') ?? [])])
  const created = new Set([...(a.get('Created') ?? []), ...(b.get('Created') ?? [])].filter(p => !modified.has(p)))
  const read = new Set([...(a.get('Read') ?? []), ...(b.get('Read') ?? [])].filter(p => !modified.has(p) && !created.has(p)))
  const list = (label: string, set: Set<string>, max: number) => {
    if (set.size === 0) return
    const arr = [...set]
    out.push(`${label}: ${arr.slice(-max).join(', ')}${arr.length > max ? ` (+${arr.length - max} more)` : ''}`)
  }
  list('Modified', modified, 20)
  list('Created', created, 20)
  list('Read', read, 10)
  return out
}

/** The previous compaction's sections, merged under this one's. */
export const mergeSections = (prev: Sections | undefined, next: Sections): Sections => {
  if (!prev) return next
  const prevGoals = prev.sessionGoal.filter(g => !g.startsWith('[Scope change]'))
  const original = prevGoals.length > 0 ? prev.sessionGoal : next.sessionGoal
  const hasNewScope = next.sessionGoal.some(g => g.startsWith('[Scope change]'))
  const sessionGoal = hasNewScope
    ? mergeList(original.filter(g => !g.startsWith('[Scope change]')).slice(0, 6), next.sessionGoal.slice(next.sessionGoal.findIndex(g => g.startsWith('[Scope change]'))), 10)
    : original
  return {
    sessionGoal,
    filesAndChanges: mergeFiles(prev.filesAndChanges, next.filesAndChanges),
    // Older summaries guessed "(unknown) <output line>" for commits they could not read.
    commits: mergeList(prev.commits.filter(c => !c.startsWith('(unknown) ')), next.commits, 8),
    outstandingContext: next.outstandingContext.length > 0 ? next.outstandingContext : prev.outstandingContext,
    userPreferences: mergeList(prev.userPreferences, next.userPreferences, 15),
    currentState: next.currentState?.length ? next.currentState : (prev.currentState ?? []),
    briefTranscript: capBrief([prev.briefTranscript, next.briefTranscript].filter(Boolean).join('\n'), 300),
  }
}

export const isEmptySections = (s: Sections): boolean =>
  s.sessionGoal.length === 0 &&
  s.filesAndChanges.length === 0 &&
  s.commits.length === 0 &&
  s.outstandingContext.length === 0 &&
  s.userPreferences.length === 0 &&
  s.briefTranscript.trim().length === 0

const section = (title: string, items: string[]): string =>
  items.length === 0 ? '' : `[${title}]\n${items.map(i => `- ${i}`).join('\n')}`

export const RECALL_NOTE =
  'The conversation before this point has been compacted into the summary above. ' +
  'Details not captured here (exact code, error messages, file paths) are only recoverable with the ' +
  '`mcp__blackhole__recall` tool: search the session history by text, regex, entry index (#N) or memory id. ' +
  'Do not redo work already completed.'

export type SummaryParts = {
  sections: Sections
  memory?: string
  instructions?: string
}

export const formatSummary = ({ sections, memory, instructions }: SummaryParts): string => {
  const head = [
    section('Session Goal', sections.sessionGoal),
    section('Files And Changes', sections.filesAndChanges),
    section('Commits', sections.commits),
    section('Outstanding Context', sections.outstandingContext),
    section('User Preferences', sections.userPreferences),
  ].filter(Boolean)
  const parts = [
    SUMMARY_SENTINEL,
    'This session is being continued from a previous conversation. The summary below was extracted ' +
      'from the conversation by blackhole (deterministic, entry indices as #N); memory sections were ' +
      'written by its observer.',
  ]
  if (instructions?.trim()) parts.push(`[Compaction Instructions]\n${instructions.trim()}`)
  if (head.length > 0) parts.push(head.join('\n\n'))
  if (sections.briefTranscript.trim()) parts.push(`[Brief Transcript]\n${capBrief(sections.briefTranscript)}`)
  if (sections.currentState?.length) parts.push(section('Current State', sections.currentState))
  if (memory?.trim()) parts.push(memory.trim())
  parts.push(RECALL_NOTE)
  return parts.join('\n\n---\n\n').replace(`${SUMMARY_SENTINEL}\n\n---\n\n`, `${SUMMARY_SENTINEL}\n`)
}
