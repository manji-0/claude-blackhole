# Changelog

## 0.2.0 — 2026-10-05

### Memory

- Memory is one layer of typed items (constraint, lesson, decision, state, fact) in
  place of observations plus reflections. Reflections were near-copies of a single
  observation that the dropper could not prune, so they crowded the pool and the dropper
  ran every cycle.
- The kind decides an item's life: constraints, lessons and decisions are kept, state
  keeps only the newest, facts go first. An item can supersede an older one.
- A consolidator call merges a lasting kind only when it outgrows its share of the pool;
  a normal cycle is one observer call.
- A 0.1 ledger is migrated on load; one worker call sorts its items into kinds. 0.1
  cannot read the migrated ledger.
- Items are asked for under 200 characters (cut at 400); a merged item keeps the time of
  what it merged.
- Worker calls record their wall-clock time, shown by `/blackhole-memory`.

### Summary

- Commits are read from the command (`-m`, `-qm`, heredoc), with the hash only when git
  printed one; no more "(unknown)" lines with hook output as the message.
- Outstanding Context keeps recent tool errors no later call settled and that read as
  errors, plus problems the user reported; the assistant's prose is no longer scanned.
- Files And Changes includes files written through Bash; task output and `~/.claude`
  files are left out.
- Current State shows the proposal a short reply such as "go" answers, the last
  substantive request, and a task notification as an event.
- The brief transcript folds tool calls into counts and `#N` ranges, covering about
  twice the turns in the same tokens.

### Archive and data

- Entries are archived whole (fields up to 32k characters, from 2000 for inputs and 8000
  for results); only rendering clips.
- After a compaction, data of sessions idle past Claude Code's `cleanupPeriodDays` is
  removed; `/blackhole cleanup` runs it now.

## 0.1.0 — 2026-10-03

- First release: deterministic compaction, observational memory with reflections, recall.
