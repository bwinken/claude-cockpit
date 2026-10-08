/**
 * One round of tool calls: the calls one model response asked for, counted
 * per tool name (`Read`, `Bash`, `mcp__server__tool`).
 */
export type CockpitRound = {
  calls: number
  tools: Readonly<Record<string, number>>
  /** The skills its Skill calls named, counted; absent when it made none. */
  skills?: Readonly<Record<string, number>>
}

/** One connected MCP server: its name as /mcp lists it, and its tools' wire-name prefix. */
export type CockpitMcpServer = {
  name: string
  prefix: string
  tools: number
}

/** What the session has on hand: the skills listed for the model and the connected MCP servers. */
export type CockpitInventory = {
  skills: readonly { name: string; source: string }[]
  mcp: readonly CockpitMcpServer[]
}

/**
 * Token counts summed over a turn's main-loop responses. `in` is everything
 * the requests were answered over (uncached, cache-read and cache-written
 * input); `out` what they generated. `responses` counts the responses that
 * reported usage at all, so 0 means the provider reported none.
 */
export type CockpitTokens = {
  in: number
  out: number
  responses: number
}

/**
 * A snapshot of the working tree, taken without touching the index, HEAD or
 * any file: `tree` is a commit or tree id holding the tracked files as they
 * were, `untracked` the blob of each untracked, unignored file, or null when
 * there were too many to hash.
 */
export type CockpitGitSnapshot = {
  root: string
  tree: string
  untracked: Readonly<Record<string, string>> | null
}

/**
 * One changed file; `added`/`removed` are null for a binary file, and for a
 * large untracked file (`large`), whose lines aren't counted.
 */
export type CockpitEditedFile = {
  path: string
  added: number | null
  removed: number | null
  large?: true
}

/** What a turn changed in the working tree, by git. */
export type CockpitEdits = {
  files: readonly CockpitEditedFile[]
  added: number
  removed: number
}

/**
 * The main loop's running turn.
 *
 * `rounds` holds the finished responses that asked for tools, in order.
 * `streaming` counts the tool_use blocks of the response in flight: 0 while
 * a request is out and has asked for none yet, null between responses,
 * while the last round's tools run. `git` is the working tree at the turn's
 * start, absent outside a git repository or with edited-files tracking off.
 */
export type CockpitLiveTurn = {
  turnId: string
  prompt: string
  rounds: readonly CockpitRound[]
  streaming: number | null
  tokens: CockpitTokens
  git?: CockpitGitSnapshot | null
  /** True for a turn a background task's notification started (a subagent finishing). */
  isNotification?: true
  /** Prompts the user typed while this turn ran that the model has read, oldest first, each cut to one line. */
  steers?: readonly string[]
  /** Prompts the user typed while this turn ran that the model hasn't read yet. */
  waiting?: readonly string[]
}

/** A prompt typed over a turn that ended before reading it: it waits to run as a turn of its own. */
export type CockpitQueued = {
  text: string
  /** How many turns have started since it was queued without being it. */
  passed: number
}

/**
 * A finished turn's summary, kept until the terminal draws the line that
 * closes that turn. The line carries no turn id, only the duration it
 * reports, so the duration is the key.
 */
export type CockpitTurnLine = {
  durationMs: number
  text: string
}

/** One finished turn in the timeline. */
export type CockpitTurnRow = {
  turnId: string
  prompt: string
  rounds: readonly CockpitRound[]
  tokens: CockpitTokens
  durationMs: number
  isAborted: boolean
  edits: CockpitEdits | null
  isNotification?: true
  /** Prompts the user typed while the turn ran and the model read within it. */
  steers?: readonly string[]
}

/** The turns before one compaction, folded under a header. */
export type CockpitCompactedSection = {
  rows: readonly CockpitTurnRow[]
}

export type CockpitTimeline = {
  /** Oldest first; each compaction adds one. */
  compacted: readonly CockpitCompactedSection[]
  /** The turns since the last compaction, oldest first. */
  rows: readonly CockpitTurnRow[]
}

/** A tool call auto mode blocked, kept until the guard's `tool.call` hook sees the call come back refused. */
export type CockpitAutoBlock = {
  tool: string
  reason: string
  /** When auto mode blocked it, in `$.clock.now()` milliseconds. */
  at: number
  /** The command, path or arguments, as the guard's rules read them. */
  subject: string
}

/** A call the user approved after auto mode blocked it: `tool.check` lets it through once. */
export type CockpitApproval = {
  toolUseId: string
  tool: string
  subject: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      live: CockpitLiveTurn | null
      turnLines: readonly CockpitTurnLine[]
      timeline: CockpitTimeline
      queued: readonly CockpitQueued[]
      notes: readonly string[]
      tick: number
      inventory: CockpitInventory | null
      autoBlocks: Readonly<Record<string, CockpitAutoBlock>>
      approvals: readonly CockpitApproval[]
      addedDirs: readonly string[]
      lastEdits: CockpitEdits | null
      editsExpanded: boolean
      editsDismissed: boolean
    }
  }
}
