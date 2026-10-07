// Pure helpers for tool call round tracing: no `$`, so tests call them directly.

import type { CockpitLiveTurn, CockpitRound } from '../../types'

/** A count that is a whole number of zero or more; anything else is 0. */
export function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** `850ms`, `12.3s`, `2m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const total = count(ms)
  if (total < 1000) return total + 'ms'
  if (total < 60_000) return (total / 1000).toFixed(1) + 's'
  const seconds = Math.floor(total / 1000)
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
  const minutes = Math.floor(seconds / 60)
  return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm'
}

/** A tool's name as a person reads it: `mcp__github__get_issue` is `github:get_issue`. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? mcp[1] + ':' + mcp[2] : name
}

/** A round from the tool names one response asked for. */
export function makeRound(names: readonly string[]): CockpitRound {
  const tools: Record<string, number> = {}
  for (const name of names) tools[name] = (tools[name] ?? 0) + 1
  return { calls: names.length, tools }
}

/** `parallel processing 3 tool calls`, or `processing 1 tool call`. */
export function describeCalls(calls: number): string {
  const n = count(calls)
  return n > 1 ? `parallel processing ${n} tool calls` : `processing ${n} tool call`
}

/**
 * What the spinner adds while tools are asked for or run: the round and its
 * calls, `round 2 · parallel processing 3 tool calls`. Undefined while a
 * request is out with no tool call yet, and between turns.
 */
export function spinnerText(live: CockpitLiveTurn | null, columns?: number): string | undefined {
  if (live === null) return undefined
  const streaming = count(live.streaming)
  let round: number
  let calls: number
  if (streaming > 0) {
    round = live.rounds.length + 1
    calls = streaming
  } else if (live.streaming === null && live.rounds.length > 0) {
    round = live.rounds.length
    calls = count(live.rounds[round - 1]?.calls)
  } else {
    return undefined
  }
  if (calls === 0) return undefined
  // Below 90 columns the round number gives way to the call count.
  return columns !== undefined && columns < 90 ? describeCalls(calls) : `round ${round} · ${describeCalls(calls)}`
}

/** The pane's short form of the round in progress: `round 2 · 3 calls`, or `thinking`. */
export function roundBrief(live: CockpitLiveTurn): string {
  const streaming = count(live.streaming)
  if (streaming > 0) return `round ${live.rounds.length + 1} · ${streaming} ${streaming === 1 ? 'call' : 'calls'}`
  const last = live.rounds[live.rounds.length - 1]
  if (live.streaming === null && last !== undefined) {
    const calls = count(last.calls)
    return `round ${live.rounds.length} · ${calls} ${calls === 1 ? 'call' : 'calls'}`
  }
  return 'thinking'
}

/** Every tool's calls across rounds, most used first; ties keep first use. */
export function tally(rounds: readonly CockpitRound[]): Array<[string, number]> {
  const totals = new Map<string, number>()
  for (const round of rounds) {
    for (const [name, n] of Object.entries(round.tools ?? {})) {
      const calls = count(n)
      if (calls > 0) totals.set(name, (totals.get(name) ?? 0) + calls)
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
}

/** `Read ×4, Bash ×2, Grep`, the tail past `max` names folded into `+k more`. */
export function formatTally(entries: ReadonlyArray<readonly [string, number]>, max: number): string {
  const shown = entries.slice(0, Math.max(1, count(max)))
  const parts = shown.map(([name, n]) => (n > 1 ? `${toolLabel(name)} ×${n}` : toolLabel(name)))
  const rest = entries.length - shown.length
  if (rest > 0) parts.push(`+${rest} more`)
  return parts.join(', ')
}

/**
 * The turn's summary: `3 rounds · 6 tool calls (Read ×4, Bash ×2) · 8.5s`, the
 * duration left out when `durationMs` is undefined; undefined for a turn that
 * made no tool calls.
 */
export function summarize(
  rounds: readonly CockpitRound[],
  durationMs: number | undefined,
  maxTools: number,
  isAborted = false,
): string | undefined {
  const asked = rounds.filter(round => count(round.calls) > 0)
  if (asked.length === 0) return undefined
  const calls = asked.reduce((sum, round) => sum + count(round.calls), 0)
  const parts = [
    asked.length + (asked.length === 1 ? ' round' : ' rounds'),
    `${calls} tool ${calls === 1 ? 'call' : 'calls'} (${formatTally(tally(asked), maxTools)})`,
  ]
  // The terminal's closing line states the duration already: left out there.
  if (durationMs !== undefined) parts.push(formatDuration(durationMs))
  if (isAborted) parts.push('interrupted')
  return parts.join(' · ')
}

/** A new turn's record. */
export function startTurn(turnId: string, prompt = ''): CockpitLiveTurn {
  return { turnId, prompt, rounds: [], streaming: null, tokens: { in: 0, out: 0, responses: 0 } }
}

function turnOf(live: CockpitLiveTurn | null, turnId: string): CockpitLiveTurn {
  return live !== null && live.turnId === turnId ? live : startTurn(turnId)
}

/** The record once a request goes out: the last round's tools have run. */
export function beginStep(live: CockpitLiveTurn | null, turnId: string): CockpitLiveTurn {
  return { ...turnOf(live, turnId), streaming: 0 }
}

/** The record with the response's tool_use blocks so far. */
export function withStreaming(live: CockpitLiveTurn | null, turnId: string, seen: number): CockpitLiveTurn {
  return { ...turnOf(live, turnId), streaming: count(seen) }
}

/** The record once a response is whole: one that asked for tools adds a round. */
export function endStep(live: CockpitLiveTurn | null, turnId: string, names: readonly string[]): CockpitLiveTurn {
  const turn = turnOf(live, turnId)
  if (names.length === 0) return { ...turn, streaming: 0 }
  return { ...turn, rounds: [...turn.rounds, makeRound(names)], streaming: null }
}
