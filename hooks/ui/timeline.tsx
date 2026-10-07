// The timeline pane's tree: one row per turn, newest first, with the turns
// before each compaction folded under a header. No `$` here: the hook in
// register.tsx reads the state and passes the surface's elements in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { CockpitLiveTurn, CockpitTimeline, CockpitTurnRow } from '../../types'
import { formatDuration, spinnerText, summarize } from '../lib/rounds'
import { describeLines, describeTokens, oneLine, sectionTotals } from '../lib/timeline'

export type TimelineModel = {
  timeline: CockpitTimeline
  running: CockpitLiveTurn | null
  isShowingCompacted: boolean
  columns: number
  maxTools: number
  onToggleCompacted: () => unknown
}

/** The second line of a row: rounds and calls per tool, tokens, edits. */
export function rowDetails(row: CockpitTurnRow, maxTools: number): string {
  const rounds = summarize(row.rounds, undefined, maxTools, row.isAborted)
  const parts = [rounds ?? (row.isAborted ? 'no tool calls · interrupted' : 'no tool calls')]
  parts.push(describeTokens(row.tokens))
  if (row.edits !== null && row.edits.files.length > 0) {
    const files = row.edits.files.length
    parts.push(`${describeLines(row.edits)} in ${files} ${files === 1 ? 'file' : 'files'}`)
  }
  return parts.join(' · ')
}

export function timelineTree(ui: Elements[RenderSurface], model: TimelineModel): RenderElement {
  const { Box, Button, Text } = ui
  const { timeline, running, isShowingCompacted, maxTools } = model
  const columns = Math.max(20, model.columns)

  const turnRow = (row: CockpitTurnRow, number: number, isOld: boolean, key: string) => {
    const time = formatDuration(row.durationMs)
    const head = `#${number} ${oneLine(row.prompt || '(no prompt)', columns - time.length - String(number).length - 4)}`
    return (
      <Box key={key} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold={!isOld} dimColor={isOld} wrap="truncate-end">
            {head}
          </Text>
          <Text dimColor>{time}</Text>
        </Box>
        <Text dimColor>{'   ' + rowDetails(row, maxTools)}</Text>
      </Box>
    )
  }

  // Newest first: the running turn, this segment's turns, then each compacted section.
  const body: RenderElement[] = []
  if (running !== null) {
    const doing = spinnerText(running) ?? 'thinking'
    body.push(
      <Box key="running" flexDirection="column" marginBottom={1}>
        <Text color="claude" wrap="truncate-end">
          {`▶ #${timeline.rows.length + 1} ${oneLine(running.prompt || '(no prompt)', columns - 8)}`}
        </Text>
        <Text dimColor>{'   running · ' + doing + ' · ' + describeTokens(running.tokens)}</Text>
      </Box>,
    )
  }
  for (let i = timeline.rows.length - 1; i >= 0; i--) {
    const row = timeline.rows[i]!
    body.push(turnRow(row, i + 1, false, 'row-' + row.turnId))
  }
  for (let s = timeline.compacted.length - 1; s >= 0; s--) {
    const section = timeline.compacted[s]!
    const totals = sectionTotals(section.rows)
    body.push(
      <Box key={'compacted-' + s} flexDirection="row" gap={1} marginBottom={1}>
        <Text dimColor>
          {`── compacted · ${totals.turns} ${totals.turns === 1 ? 'turn' : 'turns'} · ${totals.calls} tool calls · ${describeTokens(totals.tokens)} · ${formatDuration(totals.durationMs)}`}
        </Text>
        <Button
          key={'toggle-compacted-' + s}
          label={isShowingCompacted ? 'Hide' : 'Show'}
          plain
          dimColor
          onPress={model.onToggleCompacted}
        />
      </Box>,
    )
    if (isShowingCompacted) {
      for (let i = section.rows.length - 1; i >= 0; i--) {
        const row = section.rows[i]!
        body.push(turnRow(row, i + 1, true, `old-${s}-${row.turnId}`))
      }
    }
  }

  if (body.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No turns yet in this conversation.</Text>
        <Text dimColor>Each turn shows up here when it ends: its prompt, tool calls, tokens, time and edited files.</Text>
      </Box>
    )
  }
  return <Box flexDirection="column">{body}</Box>
}
