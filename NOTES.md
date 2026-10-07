# Development notes

Places where the mods documentation and the TypeScript declarations that
Claude Code writes for its build disagree, or where the docs leave something
out. The types win. Checked against Claude Code **2.1.292**; the online docs
say they describe v2.1.290.

## Documentation vs. types

| Topic | Docs say | Types (2.1.292) say | What cockpit does |
| :- | :- | :- | :- |
| `e.surface` values | Mods reference, Render sites: "`e.surface` is `terminal` or `desktop`" | `RenderSurface` is `terminal`, `desktop`, `vscode` or `mobile` | Branches on `terminal` vs. everything else, so no surface is assumed |
| Where `Pane`, `CommandOutput`, `ToolUse`, `UserMessage`, `AssistantMessage`, `AskUserQuestion` are drawn | Render sites table: "Terminal, Desktop" | `RenderPropsOf`: "Raised on every surface" | Treated as available on every surface |
| `$.session.usage().context` | Mods reference: "`context` has `tokens`, `window`, and `percent`" | `SessionContextUsage`: `window` is always there; `tokens` and `percent` are optional, missing until the first response and again just after compaction | Treats a missing `tokens` or `percent` as "not known yet" and never as 0 |
| `tool.check` and auto mode | Events guide: `next(e)` resolves to "the decision the rules, the permission mode, and those hooks reached" | `tool.check` fires "before the mode settles an ask". An `ask` verdict then goes to the mode's decider: the dialog, the auto-mode classifier, or a headless host. The classifier's verdict is never part of `next(e)` | Doesn't expect a classifier verdict at `tool.check`. Auto-mode denials come in through `classic.PermissionDenied` |
| `ToolProgress` props | Render sites table: `kind` | Also has `tool_use_id` and `hint` | Not used |
| Minimum Claude Code version | The manifest reference has no field for it | `claude plugin validate` flags `engines` and `minClaudeCodeVersion` as unknown fields, and Claude Code ignores them when it loads the plugin | The minimum version goes in `metadata` (which Claude Code doesn't read), in the README, and in a check at `session.start` that calls `$.session.version()` |

## Facts the docs only state in passing

- `/branch` sends `session.end` with `reason: 'resume'`, but `classic.SessionStart`
  arrives with `source: 'fork'`. A hook that resets state has to match
  `clear`, `resume` and `fork`.
- `$.ui.ask` is a call to the `AskUserQuestion` tool. It goes through every
  `tool.call` hook except the one that made the call. A `tool.call` hook with
  no matcher therefore also sees the questions other mods ask.
- `turn.step` results list in `serverToolUses` the tool calls the API ran
  itself, such as the advisor. Those never raise `tool.call`, and `toolUses`
  leaves them out.
