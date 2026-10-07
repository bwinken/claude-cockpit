// Pure helpers for the timeline pane and the edited-files band.

import type { CockpitEdits, CockpitTimeline, CockpitTokens, CockpitTurnRow } from '../../types'
import { count } from './rounds'

/** The most turns the timeline keeps, compacted sections included; the oldest go first. */
export const MAX_ROWS = 200
/** How much of a prompt a row keeps. */
export const PROMPT_KEPT = 240

export const EMPTY_TIMELINE: CockpitTimeline = { compacted: [], rows: [] }
export const NO_TOKENS: CockpitTokens = { in: 0, out: 0, responses: 0 }

/**
 * Adds one response's usage. Any field may be missing, zero or not a number
 * (some providers and gateways report no cache fields): each counts as 0.
 * A response with no usage object at all adds nothing.
 */
export function addUsage(tokens: CockpitTokens, usage: unknown): CockpitTokens {
  if (usage === null || typeof usage !== 'object') return tokens
  const u = usage as Record<string, unknown>
  return {
    in: tokens.in + count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens),
    out: tokens.out + count(u.output_tokens),
    responses: tokens.responses + 1,
  }
}

/** `950`, `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  const value = count(n)
  if (value < 1000) return String(value)
  if (value < 1_000_000) return (value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, '') + 'k'
  return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/** `42.1k in · 1.2k out`, or `no token usage reported`. */
export function describeTokens(tokens: CockpitTokens): string {
  if (count(tokens.responses) === 0) return 'no token usage reported'
  return `${formatTokens(tokens.in)} in · ${formatTokens(tokens.out)} out`
}

/** One line of a prompt: whitespace folded, cut to `max` characters with `…`. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const room = Math.max(1, count(max))
  if (line.length <= room) return line
  return line.slice(0, Math.max(0, room - 1)).trimEnd() + '…'
}

/** A path cut from its start to `max` characters, at a `/` where one fits: `…/rounds.ts`. */
export function shortPath(path: string, max: number): string {
  const room = Math.max(4, count(max))
  if (path.length <= room) return path
  const tail = path.slice(path.length - room + 1)
  const slash = tail.indexOf('/')
  return '…' + (slash >= 0 && slash < tail.length - 1 ? tail.slice(slash) : tail)
}

/** `+682 −1`. */
export function describeLines(edits: { added: number | null; removed: number | null }): string {
  if (edits.added === null && edits.removed === null) return 'binary'
  return `+${count(edits.added)} −${count(edits.removed)}`
}

/** `Edited 9 files +682 −1`. */
export function describeEdits(edits: CockpitEdits): string {
  const files = edits.files.length
  return `Edited ${files} ${files === 1 ? 'file' : 'files'} ${describeLines(edits)}`
}

function trim(timeline: CockpitTimeline): CockpitTimeline {
  let excess = timeline.compacted.reduce((sum, section) => sum + section.rows.length, 0) + timeline.rows.length - MAX_ROWS
  if (excess <= 0) return timeline
  const compacted = []
  for (const section of timeline.compacted) {
    if (excess >= section.rows.length) {
      excess -= section.rows.length
      continue
    }
    compacted.push(excess > 0 ? { rows: section.rows.slice(excess) } : section)
    excess = 0
  }
  return { compacted, rows: excess > 0 ? timeline.rows.slice(excess) : timeline.rows }
}

/** The timeline with a finished turn appended. */
export function addRow(timeline: CockpitTimeline, row: CockpitTurnRow): CockpitTimeline {
  return trim({ ...timeline, rows: [...timeline.rows, row] })
}

/**
 * The timeline after a compaction: the turns so far fold into a compacted
 * section, nothing is dropped, and the next turn is #1 of a new segment.
 */
export function foldCompacted(timeline: CockpitTimeline): CockpitTimeline {
  if (timeline.rows.length === 0) return timeline
  return { compacted: [...timeline.compacted, { rows: timeline.rows }], rows: [] }
}

/** A section's totals for its header: turns, tool calls, tokens and time. */
export function sectionTotals(rows: readonly CockpitTurnRow[]): { turns: number; calls: number; tokens: CockpitTokens; durationMs: number } {
  let calls = 0
  let tokens = NO_TOKENS
  let durationMs = 0
  for (const row of rows) {
    for (const round of row.rounds) calls += count(round.calls)
    tokens = {
      in: tokens.in + count(row.tokens.in),
      out: tokens.out + count(row.tokens.out),
      responses: tokens.responses + count(row.tokens.responses),
    }
    durationMs += count(row.durationMs)
  }
  return { turns: rows.length, calls, tokens, durationMs }
}
