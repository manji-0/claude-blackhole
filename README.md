# claude-blackhole

A [Claude Code](https://claude.com/claude-code) mod that replaces LLM compaction with a
deterministic summary, keeps an observational memory of the session, and lets the model
recall everything that was compacted away. It is a port of
[pi-blackhole](https://github.com/k0valik/pi-blackhole) to Claude Code's plugin hooks.

> Claude Code's plugin hooks API is early access and may change between releases.
> This mod was written against Claude Code 2.1.287.

## What it does

| Feature | How |
|---|---|
| Zero-cost compaction | `session.compact` builds the summary from the transcript without a model call: session goal (with scope changes), files and changes, commits, outstanding errors, user preferences, a brief transcript with `#N` entry indices, and the current state (last request, last reply, the calls after it). |
| Archive | Every entry is saved before compaction under `~/.claude/blackhole/<session id>/`, so nothing is lost. |
| Observational memory | After a turn, once unobserved conversation passes a token threshold, a small worker model (Haiku 4.5 by default) observes it into one layer of typed items, each citing the source entries it comes from (uncited ones are dropped). The kind decides how long an item lives: **constraints**, **lessons** (what failed, why, what works) and **decisions** are kept; **state** keeps only the newest; **facts** go first, since recall finds them in the archive. An item can supersede an older one, which retires it. A consolidator call merges a lasting kind only when it outgrows its share of the pool. |
| Recall | The `recall` tool (`mcp__blackhole__recall`) searches the archive and memory: BM25 text search (Japanese supported via CJK bigrams), `#N` to expand an entry, `#N:<text>`, 12-hex memory ids, `/regex/`, and `mode:file <path>`. |

The summary tells the model to use `recall` for details it no longer holds, so the
compacted context stays small without making old work unreachable.

## Commands

- `/blackhole` — compact now. `/blackhole <instructions>` passes compaction instructions.
  Also: `preview`, `settings`, `om-on`, `om-off`.
- `/blackhole-memory` — memory status: items per kind against their budget, and worker time (total, per call, last cycle). Also: `view`, `full`, `run`.
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
| `observationsPoolMaxTokens` | `6000` | Memory size. Each kind has a share (constraint 20%, lesson 30%, decision 25%, state 10%, fact 15%); past it, lasting kinds are consolidated, then the lowest-relevance, oldest items are trimmed. |

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

## Development

```sh
claude plugin validate .
claude plugin test .
```

Claude Code writes the API's type declarations into `.claude-plugin/types/` when it loads
the plugin from a folder you own; `tsconfig.json` extends them for type checking.

## Differences from pi-blackhole

- Memory workers answer with one JSON completion instead of tool calls.
- Memory is one layer of typed items (constraint, lesson, decision, state, fact) instead of observations plus reflections. A ledger written with reflections is migrated on load, and one worker call sorts its items into kinds.
- `manual` mode hands auto-compaction back to Claude Code rather than blocking it.
- Sub-agent compaction and cross-project recall are not ported.

## License

MIT. Includes work derived from pi-blackhole, Copyright (c) 2026 k0valik. See [LICENSE](LICENSE).
