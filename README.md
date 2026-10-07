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

## Known limitations

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
