/**
 * One round of tool calls: the calls one model response asked for, counted
 * per tool name (`Read`, `Bash`, `mcp__server__tool`).
 */
export type CockpitRound = {
  calls: number
  tools: Readonly<Record<string, number>>
}

/**
 * The tool call rounds of the main loop's running turn.
 *
 * `rounds` holds the finished responses that asked for tools, in order.
 * `streaming` counts the tool_use blocks of the response in flight: 0 while
 * a request is out and has asked for none yet, null between responses,
 * while the last round's tools run.
 */
export type CockpitLiveTurn = {
  turnId: string
  rounds: readonly CockpitRound[]
  streaming: number | null
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

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      live: CockpitLiveTurn | null
      turnLines: readonly CockpitTurnLine[]
    }
  }
}
