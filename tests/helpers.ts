// Shared stubs for the cockpit tests: they answer in Claude Code's place.

import type { RenderSurface } from 'claude-code'

export const SURFACES = ['terminal', 'desktop'] as const satisfies readonly RenderSurface[]

export type StepPlan = {
  /** Tool names the response streams, in order: one batch. */
  tools: readonly string[]
  /** What `result.usage` reports; null when the response carried none. */
  usage?: unknown
}

/** The Spinner as Claude Code hands it to `ui.render`. */
export function spinner(surface: (typeof SURFACES)[number], columns = 120) {
  return {
    plugin: 'cockpit',
    surface,
    component: 'Spinner',
    requestId: 'main',
    viewport: { columns, rows: 40, isFullscreen: false },
    props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' },
  } as const
}

/** The terminal's closing line of a turn, as Claude Code hands it to `ui.render`. */
export function turnDuration(durationMs: number) {
  return {
    plugin: 'cockpit',
    surface: 'terminal',
    component: 'TurnDuration',
    requestId: 'msg-' + durationMs,
    viewport: { columns: 120, rows: 40, isFullscreen: false },
    props: { word: 'Baked', durationMs },
  } as const
}

/**
 * Registers a `turn.step` stub that streams `plans[e.index]`: one tool chunk
 * per tool, then the stop, and returns the matching result.
 */
export function stepStub(plans: readonly StepPlan[]) {
  return async function* (_$: unknown, e: { turnId: string; index: number }) {
    const plan = plans[e.index] ?? { tools: [] }
    for (const [i, name] of plan.tools.entries()) {
      yield { kind: 'tool' as const, index: i, id: `toolu_${e.index}_${i}`, name }
    }
    const usage = (plan.usage ?? null) as never
    yield { kind: 'stop' as const, stopReason: plan.tools.length > 0 ? ('tool_use' as const) : ('end_turn' as const), usage }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: plan.tools.length > 0 ? '' : 'done',
      toolUses: plan.tools.map(name => ({ name, input: {} })),
      stopReason: plan.tools.length > 0 ? ('tool_use' as const) : ('end_turn' as const),
      usage,
    }
  }
}

/** Reads a streaming event to its end and returns the result. */
export async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<T> {
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  return step.value
}
