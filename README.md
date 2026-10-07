# claude-cockpit

[繁體中文](README.zh-TW.md)

**cockpit** is a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that makes a session's work visible while it happens. It runs in the terminal and in the Claude Code Desktop app, and works with any model, provider, or gateway.

<!-- Screenshot: the spinner showing a batch sequence, e.g. "Sauteing… ∥3 → ∥2 → 1" -->
> 📷 _Screenshot placeholder: spinner with batch trace_

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

### Tool call batch tracing

A **batch** is the set of tool calls that Claude asks for in a single model response. Only the main conversation is counted: subagent requests are left out.

- **While a turn runs**, the spinner keeps its own animation, word, and counters, and cockpit adds the batch sequence after them, as in `Sauteing… ∥3 → ∥2 → 1`. `∥3` means three tool calls in one response, and `1` means a single call. The newest batch is counted while the response is still streaming. On a narrow terminal, the middle of the sequence folds into `…+k`.
- **When the turn ends**, cockpit adds one line under the answer with the whole sequence, the total number of calls, and how long the turn took, as in `Batches ∥3 → ∥2 → 1 · 6 calls · 12.3s`. A turn that made no tool calls gets no line, and an interrupted turn ends its line with `interrupted`. Past the configured length, the summary also keeps the first and last batches and folds the middle.

| Option | Default | What it does |
| :- | :- | :- |
| `batchTrace` | `true` | Turns batch tracing on or off |
| `batchTraceMaxShown` | `12` | The longest sequence the summary line shows in full, from 4 to 64 |

## Known limitations

- **Batch boundaries come from the model's response.** cockpit counts the `tool_use` blocks of each response. Tool calls that the API runs on its own side, such as the advisor, don't count.
- **Desktop app.** The tests check the tree cockpit gives the Desktop app's spinner, but only a real session shows how the app draws the added text. In the Desktop app, the spinner's word describes the current step instead of the animated verb.
- **Subagent views.** The spinner doesn't say whose loop it belongs to, so a spinner drawn while you view a subagent's transcript shows the main conversation's batches.
- **The summary line's label.** Claude Code labels the line with the names of every mod that hooks the end of a turn, such as `cockpit+cc-plugin-agents-md:`.

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
