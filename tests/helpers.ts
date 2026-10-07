// Shared stubs for the cockpit tests: they answer in Claude Code's place.

import type { RenderSurface } from 'claude-code'

export const SURFACES = ['terminal', 'desktop'] as const satisfies readonly RenderSurface[]

export type StepPlan = {
  /** Tool names the response streams, in order: one batch. */
  tools: readonly string[]
  /** What `result.usage` reports; null when the response carried none. */
  usage?: unknown
  /** Each tool call's arguments, by position; `{}` where left out. */
  inputs?: readonly unknown[]
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
    // The kit holds a stop chunk to null or all four counts; a partial usage rides the result only.
    const isWhole = usage !== null && ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(k => typeof (usage as Record<string, unknown>)[k] === 'number')
    yield { kind: 'stop' as const, stopReason: plan.tools.length > 0 ? ('tool_use' as const) : ('end_turn' as const), usage: isWhole ? usage : (null as never) }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: plan.tools.length > 0 ? '' : 'done',
      toolUses: plan.tools.map((name, i) => ({ name, input: plan.inputs?.[i] ?? {} })),
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

/** A `turn.step` stub that streams `plans[e.turnId][e.index]`. */
export function stepsByTurn(plans: Readonly<Record<string, readonly StepPlan[]>>) {
  return async function* ($: unknown, e: { turnId: string; index: number }) {
    const plan = plans[e.turnId]?.[e.index] ?? { tools: [] }
    const result = yield* stepStub([plan])($, { ...e, index: 0 })
    return { ...result, index: e.index }
  }
}

/** The timeline pane as Claude Code hands it to `ui.render`. */
export function pane(surface: (typeof SURFACES)[number], bodyColumns = 100) {
  return {
    plugin: 'cockpit',
    surface,
    component: 'Pane',
    requestId: 'cockpit-timeline',
    viewport: { columns: 140, rows: 40, isFullscreen: true },
    props: {
      title: 'Cockpit timeline',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  } as const
}

/** The band above the prompt as Claude Code hands it to `ui.render`. */
export function band(
  surface: (typeof SURFACES)[number],
  props: { isWorking?: boolean; hasSurvey?: boolean; agentId?: string } = {},
) {
  return {
    plugin: 'cockpit',
    surface,
    component: 'AbovePrompt',
    viewport: { columns: 120, rows: 40, isFullscreen: false },
    props: {
      hasSurvey: props.hasSurvey ?? false,
      isWorking: props.isWorking ?? false,
      maxRows: 20,
      bodyColumns: 115,
      scroll: { offset: 0, bodyRows: 19 },
      view: props.agentId === undefined ? {} : { agentId: props.agentId },
    },
  } as const
}

type RunArgs = { argv: readonly string[]; init?: { stdin?: string } }
type RunValue = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } }

function ran(exitCode: number, stdout: string): RunValue {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

/** A `process.run` stub for a directory that isn't a git repository. */
export function notGit() {
  return () => ran(128, '')
}

/**
 * A `process.run` stub standing for git in one repository across one turn:
 * the first snapshot sees `notes.txt` untracked; by the second, the turn
 * changed `hooks/a.ts` (+3 −1), grew `notes.txt` (+2) and added `new.txt` (+5).
 * `calls` collects every argv, to show nothing but read-only git ran.
 */
export function fakeGit(calls: string[][] = []) {
  let snapshots = 0
  return ($: unknown, e: RunArgs): RunValue => {
    const argv = [...e.argv]
    calls.push(argv)
    const args = argv.slice(1).join(' ')
    if (argv[0] !== 'git') return ran(127, '')
    if (args === 'rev-parse --show-toplevel') return ran(0, '/repo\n')
    if (args === 'stash create') {
      snapshots += 1
      return ran(0, snapshots === 1 ? 'aaa\n' : 'bbb\n')
    }
    if (args.startsWith('ls-files')) return ran(0, snapshots <= 1 ? 'notes.txt\0' : 'notes.txt\0new.txt\0')
    if (args === 'hash-object -w --stdin-paths') {
      const blobs: Record<string, string> = snapshots <= 1 ? { 'notes.txt': 'b1' } : { 'notes.txt': 'b2', 'new.txt': 'b3' }
      const lines = (e.init?.stdin ?? '').split('\n').filter(Boolean)
      return ran(0, lines.map(path => blobs[path] ?? 'zz').join('\n') + '\n')
    }
    if (args === 'hash-object -w --stdin') return ran(0, 'e69\n')
    if (args === 'diff --numstat -z --no-renames aaa bbb') return ran(0, '3\t1\thooks/a.ts\0')
    if (args === 'diff --numstat b1 b2') return ran(0, '2\t0\tb1 => b2\n')
    if (args === 'diff --numstat e69 b3') return ran(0, '5\t0\te69 => b3\n')
    return ran(1, '')
  }
}
