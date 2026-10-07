// The timeline pane's tree: the whole session at a glance, then one line per
// turn from #1 down, compactions marked, the running turn last. No `$` here:
// the hook in register.tsx reads the state and passes the surface's elements in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { CockpitLiveTurn, CockpitTimeline, CockpitTurnRow } from '../../types'
import { formatDuration, formatTally, roundBrief } from '../lib/rounds'
import {
  describeCalls,
  describeContext,
  describeLines,
  describeTokens,
  formatElapsed,
  oneLine,
  sessionTotals,
} from '../lib/timeline'

export type TimelineModel = {
  timeline: CockpitTimeline
  running: CockpitLiveTurn | null
  columns: number
  maxTools: number
  /** How long the session has run; undefined when unknown. */
  elapsedMs?: number
  /** The context window's fill, as `$.session.usage()` reports it. */
  context?: { tokens?: number; window?: number; percent?: number }
}

/** A row's right-hand side: `3 calls   5.6s  +18 −0`. */
export function rowStats(row: CockpitTurnRow): string {
  const parts = [describeCalls(row.rounds).padStart(8), formatDuration(row.durationMs).padStart(7)]
  if (row.edits !== null && row.edits.files.length > 0) parts.push(describeLines(row.edits))
  if (row.isAborted) parts.push('interrupted')
  return parts.join('  ')
}

export function timelineTree(ui: Elements[RenderSurface], model: TimelineModel): RenderElement {
  const { Box, Text } = ui
  const { timeline, running, maxTools } = model
  const columns = Math.max(24, model.columns)
  const totals = sessionTotals(timeline, running)

  const field = (key: string, label: string, value: string) => (
    <Box key={key} flexDirection="row">
      <Text dimColor>{'  ' + label.padEnd(11)}</Text>
      <Text wrap="truncate-end">{value}</Text>
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
  if (totals.tools.length > 0) overview.push(field('tools', 'tools', formatTally(totals.tools, maxTools)))
  overview.push(field('tokens', 'tokens', describeTokens(totals.tokens)))
  if (totals.edits !== null) {
    const files = totals.edits.files.length
    overview.push(field('edited', 'edited', `${files} ${files === 1 ? 'file' : 'files'} ${describeLines(totals.edits)}`))
  }

  const line = (key: string, left: string, right: string, isDim: boolean, color?: string) => (
    <Box key={key} flexDirection="row" justifyContent="space-between" gap={1}>
      <Text dimColor={isDim} color={color} wrap="truncate-end">
        {oneLine(left, columns - right.length - 1)}
      </Text>
      <Text dimColor>{right}</Text>
    </Box>
  )

  // #1 at the top. Each compaction ends a segment; numbering starts again after it.
  const rows: RenderElement[] = []
  timeline.compacted.forEach((section, s) => {
    section.rows.forEach((row, i) => rows.push(line(`old-${s}-${row.turnId}`, `#${i + 1} ${row.prompt || '(no prompt)'}`, rowStats(row), true)))
    rows.push(
      <Text key={'compacted-' + s} dimColor>
        ── compacted ──
      </Text>,
    )
  })
  timeline.rows.forEach((row, i) => rows.push(line('row-' + row.turnId, `#${i + 1} ${row.prompt || '(no prompt)'}`, rowStats(row), false)))
  if (running !== null) {
    rows.push(line('running', `▶ #${timeline.rows.length + 1} ${running.prompt || '(no prompt)'}`, roundBrief(running), false, 'claude'))
  }

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
