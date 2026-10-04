// Cleanup: session directories under ~/.claude/blackhole/ that no file was
// written in for the retention go, so an archive does not outlive the
// transcript it came from. Runs after a compaction, never on the current
// session, and only on directories named by a session id.

/** What cleanup needs from the engine; register.ts builds it over `$`. */
export type CleanupIo = {
  /** `~/.claude/blackhole`. */
  root: string
  /** The running session's id, never removed. */
  current: string
  list: (path: string) => Promise<readonly { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }[]>
  remove: (path: string) => Promise<void>
  now: () => Promise<number>
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DAY_MS = 86_400_000
/** Claude Code's own default for cleanupPeriodDays. */
export const DEFAULT_RETENTION_DAYS = 30

/** Retention in days from Claude Code's cleanupPeriodDays; the default when absent or unusable. */
export const retentionDays = (settings: Record<string, unknown>): number => {
  const days = settings.cleanupPeriodDays
  return typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
}

/** Session directories with no file written within `days`, oldest first. */
export const staleSessions = async (io: CleanupIo, days: number): Promise<string[]> => {
  const cutoff = (await io.now()) - days * DAY_MS
  const stale: { path: string; newest: number }[] = []
  for (const entry of await io.list(io.root)) {
    if (entry.kind !== 'dir' || !SESSION_ID_RE.test(entry.name) || entry.name === io.current) continue
    const path = `${io.root}/${entry.name}`
    const newest = Math.max(0, ...(await io.list(path)).filter(f => f.kind === 'file').map(f => f.mtimeMs))
    if (newest < cutoff) stale.push({ path, newest })
  }
  return stale.sort((a, z) => a.newest - z.newest).map(s => s.path)
}

/** Remove the stale session directories; resolves the paths removed. */
export const cleanup = async (io: CleanupIo, days: number): Promise<string[]> => {
  const removed: string[] = []
  for (const path of await staleSessions(io, days)) {
    await io.remove(path)
    removed.push(path)
  }
  return removed
}
