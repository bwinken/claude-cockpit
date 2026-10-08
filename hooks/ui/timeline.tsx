// The timeline pane's tree: the whole session at a glance, then one line per
// turn from #1 down (prompts typed mid-turn under their turn, a subagent's
// notification marked ⚙), compactions marked, the running turn last. No `$` here: the hook in register.tsx reads
// the state and passes the surface's elements in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { CockpitLiveTurn, CockpitTimeline, CockpitTurnRow } from '../../types'
import { formatDuration, formatTally, roundBrief } from '../lib/rounds'
import {
  describeCalls,
  describeContext,
  describeLines,
  describeTokens,
  fitWidth,
  formatElapsed,
  NOTE_MARK,
  sessionTotals,
  textWidth,
} from '../lib/timeline'

export type TimelineModel = {
  timeline: CockpitTimeline
  running: CockpitLiveTurn | null
  /** Prompts typed over a turn that ended before reading them: each waits to run as a turn. */
  queued: readonly string[]
  /** The overview's skills line: `14 · commit ×2, review-pr, +12 more`. */
  skills: string
  /** The overview's MCP line: `2 connected · github ×3 (24 tools), linear (8 tools)`. */
  mcp: string
  columns: number
  maxTools: number
  /** How long the session has run; undefined when unknown. */
  elapsedMs?: number
  /** The context window's fill, as `$.session.usage()` reports it. */
  context?: { tokens?: number; window?: number; percent?: number }
}

/** The width of a row's calls column (`12 calls`), and of its time column (`1m 05s`). */
const CALLS_WIDTH = 8
const TIME_WIDTH = 7

/** What a row adds after its time: `+18 −0`, `interrupted`, both, or nothing. */
export function rowExtra(row: CockpitTurnRow): string {
  const parts: string[] = []
  if (row.edits !== null && row.edits.files.length > 0) parts.push(describeLines(row.edits))
  if (row.isAborted) parts.push('interrupted')
  return parts.join('  ')
}

/**
 * A row's right-hand side in fixed columns, `extraWidth` wide for the last:
 * ` 3 calls     5.6s  +18 −0`. Every row's calls and time line up.
 */
export function rowStats(row: CockpitTurnRow, extraWidth = 0): string {
  const stats = describeCalls(row.rounds).padStart(CALLS_WIDTH) + '  ' + formatDuration(row.durationMs).padStart(TIME_WIDTH)
  return extraWidth > 0 ? stats + '  ' + rowExtra(row).padEnd(extraWidth) : stats
}

/** A turn's prompt for its line; a subagent's notification is marked `⚙`. */
function label(turn: { prompt: string; isNotification?: true }): string {
  return (turn.isNotification ? NOTE_MARK : '') + (turn.prompt || '(no prompt)')
}

export function timelineTree(ui: Elements[RenderSurface], model: TimelineModel): RenderElement {
  const { Box, Text } = ui
  const { timeline, running, maxTools } = model
  const columns = Math.max(24, model.columns)
  const totals = sessionTotals(timeline, running)

  const field = (key: string, label: string, value: string) => (
    <Box key={key} flexDirection="row">
      {/* A fixed label column: a value that wraps keeps its indent. */}
      <Box width={13} flexShrink={0}>
        <Text dimColor>{'  ' + label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">{value}</Text>
      </Box>
    </Box>
  )

  const overview: RenderElement[] = [
    <Text key="title" bold>
      {'Session' + (model.elapsedMs === undefined ? '' : ' · running ' + formatElapsed(model.elapsedMs))}
    </Text>,
    field('context', 'context', describeContext(model.context)),
    field(
      'turns',
      'turns',
      `${totals.turns}` +
        (totals.compactions > 0 ? ` (${totals.compactions} ${totals.compactions === 1 ? 'compaction' : 'compactions'})` : '') +
        ` · ${totals.calls} tool ${totals.calls === 1 ? 'call' : 'calls'}`,
    ),
  ]
  overview.push(field('tools', 'tools', totals.tools.length > 0 ? formatTally(totals.tools, maxTools) : 'no calls yet'))
  overview.push(field('skills', 'skills', model.skills))
  overview.push(field('mcp', 'mcp', model.mcp))
  overview.push(field('tokens', 'tokens', totals.turns === 0 && totals.tokens.responses === 0 ? 'none yet' : describeTokens(totals.tokens)))
  if (totals.edits !== null) {
    const files = totals.edits.files.length
    overview.push(field('edited', 'edited', `${files} ${files === 1 ? 'file' : 'files'} ${describeLines(totals.edits)}`))
  }

  // Each turn is one line: its prompt cut to fit, then the stats in fixed columns,
  // so the calls and times of every row line up whatever the prompt's script.
  const allRows = [...timeline.compacted.flatMap(section => section.rows), ...timeline.rows]
  const extraWidth = Math.max(0, ...allRows.map(row => textWidth(rowExtra(row))))
  const statsWidth = CALLS_WIDTH + 2 + TIME_WIDTH + (extraWidth > 0 ? 2 + extraWidth : 0)
  const line = (key: string, left: string, right: string, isDim: boolean, color?: string) => (
    <Box key={key} flexDirection="row" gap={1}>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor={isDim} color={color} wrap="truncate-end">
          {fitWidth(left, columns - Math.max(statsWidth, textWidth(right)) - 1)}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{right}</Text>
      </Box>
    </Box>
  )

  const rows: RenderElement[] = []
  // A prompt typed while the turn ran, on a dim line of its own under the turn.
  const steers = (key: string, texts: readonly string[] | undefined, note = '') =>
    (texts ?? []).forEach((text, i) =>
      rows.push(
        <Text key={`${key}-${i}`} dimColor wrap="truncate-end">
          {'   ↳ ' + fitWidth(text, columns - 5 - note.length) + note}
        </Text>,
      ),
    )

  // #1 at the top. Each compaction ends a segment; numbering starts again after it.
  timeline.compacted.forEach((section, s) => {
    section.rows.forEach((row, i) => {
      rows.push(line(`old-${s}-${row.turnId}`, `#${i + 1} ${label(row)}`, rowStats(row, extraWidth), true))
      steers(`old-${s}-${row.turnId}-steer`, row.steers)
    })
    rows.push(
      <Text key={'compacted-' + s} dimColor>
        ── compacted ──
      </Text>,
    )
  })
  timeline.rows.forEach((row, i) => {
    rows.push(line('row-' + row.turnId, `#${i + 1} ${label(row)}`, rowStats(row, extraWidth), row.isNotification === true))
    steers(`row-${row.turnId}-steer`, row.steers)
  })
  if (running !== null) {
    // Its round in place of calls and time: `round 2 · 3 calls`, ending where the times end.
    const brief = roundBrief(running).padStart(CALLS_WIDTH + 2 + TIME_WIDTH)
    rows.push(line('running', `▶ #${timeline.rows.length + 1} ${label(running)}`, brief + ' '.repeat(statsWidth - CALLS_WIDTH - 2 - TIME_WIDTH), false, 'claude'))
    steers('running-steer', running.steers)
    steers('running-waiting', running.waiting, ' · not read yet')
  }
  model.queued.forEach((text, i) =>
    rows.push(
      <Text key={'queued-' + i} dimColor wrap="truncate-end">
        {'   ⋯ ' + fitWidth(text, columns - 14) + ' · queued'}
      </Text>,
    ),
  )

  return (
    <Box flexDirection="column">
      <Box key="overview" flexDirection="column" marginBottom={1}>
        {overview}
      </Box>
      {rows.length === 0 ? (
        <Text key="empty" dimColor>
          No turns yet in this conversation.
        </Text>
      ) : (
        <Box key="turn-list" flexDirection="column">
          {rows}
        </Box>
      )}
    </Box>
  )
}
