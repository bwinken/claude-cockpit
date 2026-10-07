/**
 * The tool call batches of the main loop's running turn.
 *
 * A batch is the tool calls one model response asked for. `batches` holds
 * the finished steps' sizes in order; `streaming` counts the tool_use blocks
 * of the response still arriving, or is null between responses.
 */
export type CockpitLiveTurn = {
  turnId: string
  batches: readonly number[]
  streaming: number | null
}

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      live: CockpitLiveTurn | null
    }
  }
}
