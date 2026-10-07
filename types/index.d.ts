/**
 * One round of tool calls: the calls one model response asked for, counted
 * per tool name (`Read`, `Bash`, `mcp__server__tool`).
 */
export type CockpitRound = {
  calls: number
  tools: Readonly<Record<string, number>>
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

/** One changed file; `added`/`removed` are null for a binary file. */
export type CockpitEditedFile = {
  path: string
  added: number | null
  removed: number | null
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

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      live: CockpitLiveTurn | null
      turnLines: readonly CockpitTurnLine[]
      timeline: CockpitTimeline
      tick: number
      lastEdits: CockpitEdits | null
      editsExpanded: boolean
      editsDismissed: boolean
    }
  }
}
