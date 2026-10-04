# claude-blackhole

A [Claude Code](https://claude.com/claude-code) mod that replaces LLM compaction with a
deterministic summary, keeps an observational memory of the session, and lets the model
recall everything that was compacted away. It is a port of
[pi-blackhole](https://github.com/k0valik/pi-blackhole) to Claude Code's plugin hooks.

> Claude Code's plugin hooks API is early access and may change between releases.
> This mod was written against Claude Code 2.1.287 and is used with 2.1.289.

## What it does

| Feature | How |
|---|---|
| Zero-cost compaction | `session.compact` builds the summary from the transcript without a model call, in well under a second (see [The summary](#the-summary)). |
| Archive | Every entry is saved before compaction, whole: commands, scripts, file contents and results up to 32k characters a field. Only what is shown (the summary, the observer's input, recall's output) is clipped. |
| Observational memory | A small worker model keeps typed memory items in the background (see [Memory](#memory)). |
| Recall | The `recall` tool (`mcp__blackhole__recall`) searches the archive and memory. |
| Cleanup | After a compaction, data of sessions idle past Claude Code's `cleanupPeriodDays` is removed (see [Data and cleanup](#data-and-cleanup)). |

The summary tells the model to use `recall` for details it no longer holds, so the
compacted context stays small without making old work unreachable.

## The summary

Each section is extracted from the conversation, and merged with the previous
compaction's when there was one:

| Section | What it holds |
|---|---|
| Session Goal | The first request, and the latest change of scope. |
| Files And Changes | Files modified, created and read, including files written through Bash (redirects of `cat`/`echo`/`printf`, `tee`, `sed -i`, Python `write_text`). Task output and `~/.claude` files are left out. |
| Commits | Commit messages read from the command (`-m`, `-qm`, a heredoc), with the hash when git printed one (`-q` prints none). |
| Outstanding Context | Recent tool errors no later call settled (a retry of the same program and subcommand settles one), and problems the user reported. A non-zero exit whose output reads as no error (a grep that matched nothing) is left out. |
| User Preferences | Standing instructions and corrections the user gave ("always use…", "never commit…", "今後は…", "…しないで"). |
| Brief Transcript | The turns with their `#N` entry indices; the tool calls between them fold into one line of counts and a `#N` range to expand with recall. |
| Current State | The last request; for a short reply such as "go", the proposal it answers and the last substantive request; a task notification as an event; the last reply and the calls after it, with the result of the last ones that tell an outcome. |
| Memory | The memory items, by kind. |

## Memory

After a turn, once unobserved conversation passes `observeAfterTokens`, the worker model
(Haiku 4.5 by default) reads it and writes memory items, each citing the entries it comes
from (an uncited item is dropped). An item is one line, asked for under 200 characters.
Its kind decides how long it lives:

| Kind | What | Lives |
|---|---|---|
| constraint | What the user requires, forbids or corrected. | Kept |
| lesson | What failed, why, and what works instead; how to build and test. | Kept |
| decision | A choice made, its rationale, the alternatives rejected. | Kept |
| state | Where the work stands: done, in progress, next, test and CI results. | Newest only |
| fact | Anything else, such as what was implemented and where. | Dropped first; recall finds it in the archive |

A new item can supersede an older one, which retires it. Each kind has a share of
`observationsPoolMaxTokens`; when a lasting kind (constraint, lesson, decision) outgrows
its share, one consolidator call merges its items, and anything still over is trimmed,
lowest relevance and oldest first. A normal cycle is one worker call; `/blackhole-memory`
shows the worker time per call and for the last cycle.

## Recall

`mcp__blackhole__recall` (and `/blackhole-recall <query>`) takes:

- free text: BM25 search over past messages, tool calls, results and memory (Japanese
  supported via CJK bigrams)
- `#N`: expand entry N; `#N:<text>`: the lines of entry N containing the text, commands
  and scripts included
- a 12-hex id: a memory item with its source entries and what it replaced
- `/regex/flags`, and `mode:file <path>` for the entries whose tool calls touched a path
- filters: `scope:all|history|memory`, `page:N`

## Commands

- `/blackhole` — compact now. `/blackhole <instructions>` passes compaction instructions.
  Also: `preview` (the summary without compacting), `settings`, `cleanup` (remove idle
  session data now), `om-on`, `om-off` (memory for this session).
- `/blackhole-memory` — memory status: items per kind against their share, and worker
  calls, tokens and time. Also: `view`, `full` (with dropped and superseded items), `run`
  (observe now).
- `/blackhole-recall <query>` — the recall tool from the prompt.
- `/blackhole-export` — write the memory to a Markdown file.

## Settings

Under `/config` (blackhole):

| Setting | Default | |
|---|---|---|
| `compaction` | `auto` | `auto`: handle `/compact` and auto-compaction. `manual`: only `/compact` and `/blackhole`. `off`: leave compaction to Claude Code. |
| `memory` | `true` | Run the memory workers. |
| `workerModel` | `claude-haiku-4-5-20251001` | Model for the memory workers. |
| `observeAfterTokens` | `8000` | Unobserved tokens that trigger the observer. |
| `observationsPoolMaxTokens` | `6000` | Memory size. Each kind has a share (constraint 20%, lesson 30%, decision 25%, state 10%, fact 15%). |

## Install

```sh
git clone https://github.com/manji-0/claude-blackhole ~/src/claude-blackhole
claude --plugin-dir ~/src/claude-blackhole
```

To load it in every session (including ones the desktop app starts), set
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/src/claude-blackhole" } }
```

Loaded from a folder, the plugin reloads when its files change, sessions already running
included.

## Data and cleanup

Session data lives under `~/.claude/blackhole/<session id>/`:

| File | |
|---|---|
| `meta.json` | Archive bookkeeping: entry count, segments, archived entry ids. |
| `seg-NNNN.json` | Archived entries, in segments of about 1 MB. |
| `ledger.json` | The memory items, worker usage and timing. |
| `sections.json` | The last compaction's sections, merged into the next one. |
| `memory.md` | Written by `/blackhole-export`. |

After each compaction, blackhole removes the session directories no file was written in
for Claude Code's `cleanupPeriodDays` (30 days when unset), so an archive goes when the
transcript it came from does. The running session is never removed, nor anything not
named by a session id. The plugin's file API cannot delete, so this runs `rm -rf` through
`$.process.run`, which Claude Code offers in the CLI only. `/blackhole cleanup` runs it
now.

## Upgrading from 0.1

0.1 kept observations plus a separate layer of reflections. 0.2 migrates such a ledger on
load and sorts its items into kinds with one worker call, and saves it in the new format,
which 0.1 cannot read. Back up `~/.claude/blackhole/` first if you may go back. Entries
archived by 0.1 stay clipped (inputs at 2000 characters, results at 8000).

## Development

```sh
claude plugin validate .
claude plugin test .
```

Claude Code writes the API's type declarations into `.claude-plugin/types/` when it loads
the plugin from a folder you own; `tsconfig.json` extends them for type checking
(`npx -p typescript tsc -p . --noEmit`).

## Differences from pi-blackhole

- Memory workers answer with one JSON completion instead of tool calls.
- Memory is one layer of typed items (constraint, lesson, decision, state, fact) instead
  of observations plus reflections.
- `manual` mode hands auto-compaction back to Claude Code rather than blocking it.
- Session data is removed with Claude Code's `cleanupPeriodDays`.
- Sub-agent compaction and cross-project recall are not ported.

## License

MIT. Includes work derived from pi-blackhole, Copyright (c) 2026 k0valik. See [LICENSE](LICENSE).
