// Pure helpers for tool call batch tracing: no `$`, so tests call them directly.

import type { CockpitLiveTurn } from '../../types'

export const ARROW = ' → '
export const PARALLEL = '∥'

/** A count that is a whole number of zero or more; anything else is 0. */
export function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** One batch: `∥3` for parallel calls, `1` for a single call. */
export function formatBatch(n: number): string {
  const calls = count(n)
  return calls > 1 ? PARALLEL + calls : String(calls)
}

/**
 * The batches joined by arrows. Past `maxShown` entries the middle folds into
 * `…+k`, keeping the head and the tail: `∥3 → 1 → …+5 → ∥2 → 1`.
 */
export function formatSequence(batches: readonly number[], maxShown: number): string {
  const max = Math.max(3, count(maxShown))
  const parts = batches.map(formatBatch)
  if (parts.length <= max) return parts.join(ARROW)
  const kept = max - 1
  const head = Math.ceil(kept / 2)
  const tail = kept - head
  const folded = parts.length - head - tail
  return [...parts.slice(0, head), '…+' + folded, ...parts.slice(parts.length - tail)].join(ARROW)
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

/** The sequence the spinner shows: the finished batches, then the one streaming. */
export function liveSequence(live: CockpitLiveTurn | null): readonly number[] {
  if (live === null) return []
  const streaming = count(live.streaming)
  return streaming > 0 ? [...live.batches, streaming] : live.batches
}

/**
 * How many batches fit after the spinner's word, elapsed time and token
 * count at this width: about five cells a batch, never fewer than three.
 */
export function spinnerRoom(columns: number | undefined, maxShown: number): number {
  const max = Math.max(3, count(maxShown))
  if (columns === undefined) return Math.min(max, 8)
  return Math.max(3, Math.min(max, Math.floor((count(columns) - 50) / 5)))
}

/** A new turn's record. */
export function startTurn(turnId: string): CockpitLiveTurn {
  return { turnId, batches: [], streaming: null }
}

/** The record with the streaming response's tool_use count set. */
export function withStreaming(live: CockpitLiveTurn | null, turnId: string, seen: number): CockpitLiveTurn {
  const turn = live !== null && live.turnId === turnId ? live : startTurn(turnId)
  return { ...turn, streaming: count(seen) }
}

/** The record once a response is whole: a step that asked for tools adds a batch. */
export function endStep(live: CockpitLiveTurn | null, turnId: string, toolUses: number): CockpitLiveTurn {
  const turn = live !== null && live.turnId === turnId ? live : startTurn(turnId)
  const calls = count(toolUses)
  return { ...turn, batches: calls > 0 ? [...turn.batches, calls] : turn.batches, streaming: null }
}

/**
 * The line under the answer: `Batches ∥3 → ∥2 → 1 · 6 calls · 12.3s`, or
 * undefined for a turn that made no tool calls.
 */
export function summarize(
  batches: readonly number[],
  durationMs: number,
  maxShown: number,
  isAborted = false,
): string | undefined {
  const sizes = batches.map(count).filter(n => n > 0)
  if (sizes.length === 0) return undefined
  const calls = sizes.reduce((sum, n) => sum + n, 0)
  const parts = [
    'Batches ' + formatSequence(sizes, maxShown),
    calls + (calls === 1 ? ' call' : ' calls'),
    formatDuration(durationMs),
  ]
  if (isAborted) parts.push('interrupted')
  return parts.join(' · ')
}
