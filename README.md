# claude-cockpit

[繁體中文](README.zh-TW.md)

**cockpit** is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that makes a session's work visible while it happens. It runs in the terminal and in the Claude Code Desktop app, and works with any model, provider, or gateway.

<!-- Screenshot: the spinner during a round, e.g. "Sauteing… round 2 · parallel processing 3 tool calls" -->
> 📷 _Screenshot placeholder: spinner with round tracing_

<!-- Screenshot: the summary line under an answer -->
> 📷 _Screenshot placeholder: per-turn summary line_

## Requirements

- Claude Code **2.1.292** or later. Plugin manifests have no field that Claude Code enforces for a minimum version, so cockpit checks the version when a session starts and shows a warning on older versions.
- Mods turned on. They're on by default since Claude Code 2.1.286, but your organization may have turned them off. See [If your organization manages Claude Code](#if-your-organization-manages-claude-code).

## Install

At the prompt of a Claude Code session in a terminal, run:

```text
/plugin install cockpit --marketplace bwinken/claude-cockpit
```

Answer `y` to add the marketplace, then pick a scope. The user scope is listed first and makes cockpit load in every session. cockpit is active right away, without a restart.

The command works in a terminal session only. Once cockpit is installed at the user scope, it also loads in the sessions the Desktop app starts on the same machine.

To try a local checkout without installing it:

```bash
git clone https://github.com/bwinken/claude-cockpit
claude --plugin-dir ./claude-cockpit
```

## Features

Each feature can be turned on or off on its own. Change a setting in `/config` (each option is a row there) or under `pluginConfigs` in `~/.claude/settings.json`. With `--plugin-dir`, the key is `cockpit@inline`.

### Tool call round tracing

A **round** is the set of tool calls that Claude asks for in a single model response. Only the main conversation is counted: subagent requests are left out.

- **While a round runs**, the spinner keeps its own animation, word, and counters, and cockpit adds what the round is doing after them, as in `Sauteing… round 2 · parallel processing 3 tool calls` or `round 3 · processing 1 tool call`. The count goes up as the model's response streams in. Between rounds, while the model works on its next response, the spinner shows nothing extra. Below 90 columns, the round number is left out.
- **When the turn ends**, cockpit adds a short summary: how many rounds there were, how many tool calls in total, and the calls per tool. In the terminal it appears as a dim row under Claude Code's own closing line, as in `✻ Crunched for 3s · done 12:37 PM` followed by `⎿  2 rounds · 5 tool calls (Read ×3, Bash ×2)`. The Desktop app, a session that another app is also attached to, and `claude -p` have no closing line, so there the summary is a line under the answer and includes the duration, as in `2 rounds · 5 tool calls (Read ×3, Bash ×2) · 3.2s`. A turn that made no tool calls gets no summary, and an interrupted turn ends its summary with `interrupted`. MCP tools appear as `server:tool`.

| Option | Default | What it does |
| :- | :- | :- |
| `roundTrace` | `true` | Turns round tracing on or off |
| `roundTraceMaxTools` | `5` | How many tool names the summary lists, most used first, from 1 to 20. The rest are counted as `+k more` |

### Timeline pane

Run `/cockpit` to open a pane that shows where the whole session stands. `/cockpit close` closes it. cockpit never opens the pane on its own, so a narrow terminal stays as it is. In the fullscreen layout the pane docks beside the transcript; otherwise it opens above the prompt.

```text
Session · running 12m
  context    45% of 1M (450k)
  turns      5 (1 compaction) · 23 tool calls
  tools      Read ×10, Edit ×6, Bash ×5, +2 more
  skills     17 · release-notes ✓, commit ×2, review-pr, init, +13 more
  mcp        2 connected · github ×3 (24 tools), weather (2 tools)
  tokens     340k in · 4.1k out
  edited     6 files +120 −8

#1 read the config files               2 calls     3.0s
#2 add the add() function               3 calls     5.6s  +18 −0
── compacted ──
#1 run ls src                           1 call      2.4s
▶ #2 fix the failing test               round 2 · 3 calls
```

- **The overview** covers the whole session. It shows how long the session has run (updated every 30 seconds), how full the context window is, the number of turns and compactions, the total tool calls and the calls per tool, the skills and connected MCP servers, the tokens, and every file edited so far. A file edited in several turns counts once, with its lines summed. Tokens are summed over the main conversation's responses: `in` counts uncached, cache-read and cache-written input together, and `out` counts output. A provider or gateway that reports no cache fields, or zeros, still gives correct numbers. One that reports no usage at all shows `no token usage reported`.
- **Skills and MCP servers** show what the session has on hand, with the ones used so far listed first: `✓` marks a skill Claude ran once, `×2` one it ran twice, and `×3` after a server counts the calls to its tools. Skills are the ones listed for Claude (the same list `/skills` shows), and a server counts as connected when its tools are listed. cockpit reads both when the session starts, after each turn and when you run `/cockpit`, counting locally without sending a request.
- **Each turn is one line**, with #1 at the top: the prompt (cut to fit), its tool calls, how long it took, and its edits. The running turn is the last line, marked `▶`, with the round it's on.
- **A compaction** draws a `── compacted ──` divider, and numbering starts again at #1 below it. Nothing is dropped. The pane keeps the last 200 turns. `/clear`, `/resume` and `/branch` start a new conversation, so the timeline starts empty.

| Option | Default | What it does |
| :- | :- | :- |
| `timeline` | `true` | Keeps the timeline and adds the `/cockpit` command |

### Edited files band

After each turn in a git repository, a band above the prompt shows what the turn changed, as in `Edited 3 files +18 −0 [ Show files ] [ Dismiss ]`. **Show files** lists each file with its line counts. Press ctrl+x tab to reach the band from the keyboard. The band hides while a turn runs, while a survey uses the band, and while you view a subagent's transcript. Whatever other mods draw in the band stays.

cockpit compares a snapshot of the working tree from the start of the turn with one from its end, so changes made with Bash commands count too, as do new files and files that aren't tracked yet. Files that `.gitignore` excludes don't count. Taking a snapshot doesn't change the index, `HEAD`, the stash list or any file. Outside a git repository the band never appears.

| Option | Default | What it does |
| :- | :- | :- |
| `editedFiles` | `true` | Takes the snapshots and shows the band. When it's off, git never runs |

## Known limitations

- **Edited files are counted by git.** Edits you make by hand while a turn runs count as that turn's. A rename shows as one file removed and one added. Past 500 untracked files, untracked files aren't counted. Past 50 changed untracked files, the rest are listed without line counts. Taking the snapshots runs a few git commands at the start and end of each turn, which takes longer in a very large repository.
- **Round boundaries come from the model's response.** cockpit counts the `tool_use` blocks of each response. Tool calls that the API runs on its own side, such as the advisor, don't count.
- **Desktop app.** The tests check the tree cockpit gives the Desktop app's spinner, but only a real session shows how the app draws the added text. In the Desktop app, the spinner's word describes the current step instead of the animated verb.
- **Subagent views.** The spinner doesn't say whose loop it belongs to, so a spinner drawn while you view a subagent's transcript shows the main conversation's round.
- **The summary line's label outside the terminal.** Where the summary is a line under the answer, Claude Code labels it with the names of every mod that hooks the end of a turn, such as `cockpit+cc-plugin-agents-md:`. A mod can't change that label.
- **Matching the closing line.** Claude Code's closing line doesn't say which turn it belongs to, so cockpit matches it to a turn by its duration in milliseconds. Two turns of exactly the same length would show the same summary.

## If your organization manages Claude Code

Mods run with your permissions and aren't sandboxed, so organizations can restrict them with [managed settings](https://code.claude.com/docs/en/plugins/mods/admin). If cockpit doesn't load, one of these settings may be the reason:

| Managed setting | Effect on cockpit |
| :- | :- |
| `allowManagedModsOnly` on the built-in guard (`pluginConfigs["cc-plugin-sec-default@builtin"].options`) | Only your organization's own mods load, so cockpit doesn't |
| `allowManagedHooksOnly` | Only your organization's mods and hooks run |
| `disableAllHooks` | No mod and no hook runs |
| `disableSideloadFlags` | `claude --plugin-dir` is rejected at startup |
| `strictKnownMarketplaces` and other marketplace restrictions | Decide whether this repository can be added as a marketplace at all |

Users can't override these settings. To see why cockpit didn't load, start a session with `claude --debug` and look in the debug log for a line such as `refused by cc-plugin-sec-default: … (allowManagedModsOnly)`. Starting with `claude --safe-mode` turns off every installed mod, which helps you check whether a problem comes from a mod.

## Development

```bash
claude plugin validate --strict .   # manifest, hooks module, state contract
claude plugin test .                # tests/*.test.ts against the engine
tsc -p .                            # after Claude Code has loaded the folder once (writes .claude-plugin/types/)
```

`NOTES.md` records the places where the mods documentation and the declarations of this build of Claude Code disagree.

## License

MIT
