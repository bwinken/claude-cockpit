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

## Rules the validator enforces that the docs don't spell out

Found while building Phase 2. `claude plugin validate` and the engine refuse a
module that breaks these:

- **`$` stays in one file.** `$` may be passed to a function declared in the
  same file, never to one imported from another file. That's why the UI files
  (`hooks/ui/*.tsx`) take the surface's element table, plain data and
  callbacks, and `hooks/register.tsx` makes every `$` call itself.
- **State references stay in one file.** An `atom` (or a `{ plugin, key }`
  reference) handed to `read`/`update` must be declared in the file that
  makes the call, so all of cockpit's atoms live in `register.tsx`.
- **Matchers are read from source.** A matcher value imported from another
  file shows up as `?` in `validate`'s report, as in
  `ui.render{component=Pane, requestId=?}`. Write it as a literal.

## The test kit vs. a session

- A `turn.step` stub's `stop` chunk must carry `usage: null` or all four token
  counts. Partial usage (no cache fields) can only ride on the step's result,
  which is where cockpit reads it.
- `$.command.run` from a test needs `origin` and `presentation` to
  type-check, although the docs' examples pass only `command` and `args`.

## git notes for the edited-files band

- `git diff --numstat -z` between two blobs prints an empty path field
  (`3\t0\t\0blobA\0blobB\0`), so blob-to-blob diffs run without `-z` and
  read the first line's counts.
- `git stash create` writes a commit of the working tree but adds no stash
  entry and changes neither the index nor the files. Checked against a real
  repository: `git status` and `git stash list` read the same before and
  after. cockpit runs every git command with `GIT_OPTIONAL_LOCKS=0`, which
  tells git to skip the locks it takes only for optional work. Whether that
  keeps `stash create` from ever taking the index lock hasn't been verified.
