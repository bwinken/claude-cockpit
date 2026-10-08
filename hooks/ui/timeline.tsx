// The timeline pane's tree: the whole session at a glance, then one line per
// turn from #1 down (prompts typed mid-turn under their turn, a subagent's
// notification marked ⚙), compactions marked, the running turn last. A row
// pressed lists that turn's calls under it. No `$` here: the hook in
// register.tsx reads the state and passes the surface's elements in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { CockpitAgentStats, CockpitCall, CockpitCheck, CockpitLiveTurn, CockpitPlanItem, CockpitTimeline, CockpitTurnRow } from '../../types'
import { callTool, describeAgent, describePlan, formatAgo, planBar } from '../lib/activity'
import { count, formatDuration, formatTally, roundBrief } from '../lib/rounds'
import {
  describeCalls,
  describeContext,
  describeLines,
  describeTokens,
  fitWidth,
  formatElapsed,
  NOTE_MARK,
  sessionTotals,
  shortPath,
  textWidth,
} from '../lib/timeline'

export type TimelineModel = {
  timeline: CockpitTimeline
  running: CockpitLiveTurn | null
  /** Prompts typed over a turn that ended before reading them: each waits to run as a turn. */
  queued: readonly string[]
  /** The overview's skills line: `26 available · used commit ×2`. */
  skills: string
  /** The overview's MCP line: `2 connected · used github ×3`. */
  mcp: string
  columns: number
  maxTools: number
  /** How long the session has run; undefined when unknown. */
  elapsedMs?: number
  /** The context window's fill, as `$.session.usage()` reports it. */
  context?: { tokens?: number; window?: number; percent?: number }
  /** The last run of each kind of check; none, and the line is left out. */
  checks?: readonly CockpitCheck[]
  /** The model's plan; empty, and the line is left out. */
  plan?: readonly CockpitPlanItem[]
  isPlanExpanded?: boolean
  /** The turn whose calls are listed under its row. */
  expandedTurn?: string | null
  /** Each subagent's calls and failures, for the Agent calls a turn lists. */
  agentStats?: Readonly<Record<string, CockpitAgentStats>>
  /** `$.clock.now()`, for the checks' age. */
  now?: number
  onToggleTurn?: (turnId: string) => unknown
  onTogglePlan?: () => unknown
}

/** The width of a row's calls column (`12 calls`), and of its time column (`1m 05s`). */
const CALLS_WIDTH = 8
const TIME_WIDTH = 7
/** The most edited files an expanded row lists; the rest are counted. */
const MAX_LISTED_FILES = 8

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

/** `✗ 2` for a turn with failed calls, '' for one without. */
function failMark(turn: { failed?: number }): string {
  return count(turn.failed) > 0 ? '✗ ' + count(turn.failed) : ''
}

/** A turn's prompt for its line; a subagent's notification is marked `⚙`. */
function label(turn: { prompt: string; isNotification?: true }): string {
  return (turn.isNotification ? NOTE_MARK : '') + (turn.prompt || '(no prompt)')
}

export function timelineTree(ui: Elements[RenderSurface], model: TimelineModel): RenderElement {
  const { Box, Button, Text } = ui
  const { timeline, running, maxTools } = model
  const columns = Math.max(24, model.columns)
  const totals = sessionTotals(timeline, running)
  const allRows = [...timeline.compacted.flatMap(section => section.rows), ...timeline.rows]
  const failedCalls = allRows.reduce((sum, row) => sum + count(row.failed), 0) + count(running?.failed)

  const field = (key: string, label: string, value: string | RenderElement) => (
    <Box key={key} flexDirection="row">
      {/* A fixed label column: a value that wraps keeps its indent. */}
      <Box width={13} flexShrink={0}>
        <Text dimColor>{'  ' + label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {typeof value === 'string' ? <Text wrap="wrap">{value}</Text> : value}
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
      <Box flexDirection="row">
        <Text wrap="wrap">
          {`${totals.turns}` +
            (totals.compactions > 0 ? ` (${totals.compactions} ${totals.compactions === 1 ? 'compaction' : 'compactions'})` : '') +
            ` · ${totals.calls} tool ${totals.calls === 1 ? 'call' : 'calls'}`}
        </Text>
        {failedCalls > 0 ? <Text color="error">{` · ✗ ${failedCalls} failed`}</Text> : null}
      </Box>,
    ),
  ]
  overview.push(field('tools', 'tools', totals.tools.length > 0 ? formatTally(totals.tools, maxTools) : 'no calls yet'))

  // tests ✓ 2m ago · lint ✗ just now: the last run of each kind, by any loop.
  const checks = model.checks ?? []
  if (checks.length > 0) {
    overview.push(
      field(
        'checks',
        'checks',
        <Box flexDirection="row" flexWrap="wrap">
          {checks.flatMap((check, i) => [
            i > 0 ? <Text key={'sep-' + check.kind} dimColor>{' · '}</Text> : null,
            <Text key={'check-' + check.kind} color={check.isPassing ? 'success' : 'error'}>
              {check.kind + (check.isPassing ? ' ✓' : ' ✗')}
            </Text>,
            model.now === undefined ? null : (
              <Text key={'ago-' + check.kind} dimColor>
                {' ' + formatAgo(model.now - check.at)}
              </Text>
            ),
          ])}
        </Box>,
      ),
    )
  }

  // ■■■■□□ 3/6 · Running tests: done, running, waiting; pressed, the steps.
  const plan = model.plan ?? []
  if (plan.length > 0) {
    const COLORS = { completed: 'success', in_progress: 'claude', pending: undefined } as const
    overview.push(
      field(
        'plan',
        'plan',
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="row" flexShrink={0}>
            {planBar(plan).map(run => (
              <Text key={'bar-' + run.status} color={COLORS[run.status]} dimColor={run.status === 'pending'}>
                {(run.status === 'pending' ? '□' : '■').repeat(run.cells)}
              </Text>
            ))}
          </Box>
          <Button key="plan-toggle" plain dimColor label={fitWidth(describePlan(plan), columns - 13 - Math.min(plan.length, 24) - 1)} onPress={() => model.onTogglePlan?.()} />
        </Box>,
      ),
    )
    if (model.isPlanExpanded) {
      plan.forEach((item, i) => {
        const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▶' : '○'
        overview.push(
          <Text key={'plan-' + i} color={COLORS[item.status]} dimColor={item.status === 'pending'} wrap="truncate-end">
            {' '.repeat(13) + mark + ' ' + fitWidth(item.text, columns - 15)}
          </Text>,
        )
      })
    }
  }

  overview.push(field('skills', 'skills', model.skills))
  overview.push(field('mcp', 'mcp', model.mcp))
  overview.push(field('tokens', 'tokens', totals.turns === 0 && totals.tokens.responses === 0 ? 'none yet' : describeTokens(totals.tokens)))
  if (totals.edits !== null) {
    const files = totals.edits.files.length
    overview.push(field('edited', 'edited', `${files} ${files === 1 ? 'file' : 'files'} ${describeLines(totals.edits)}`))
  }

  // Each turn is one line: its prompt cut to fit, then the stats in fixed columns,
  // so the calls and times of every row line up whatever the prompt's script.
  const extraWidth = Math.max(0, ...allRows.map(row => textWidth(rowExtra(row))))
  const failWidth = Math.max(0, ...[...allRows, ...(running ? [running] : [])].map(turn => failMark(turn).length))
  const statsWidth = CALLS_WIDTH + 2 + TIME_WIDTH + (extraWidth > 0 ? 2 + extraWidth : 0)
  const rightWidth = statsWidth + (failWidth > 0 ? 2 + failWidth : 0)
  const line = (
    key: string,
    left: string,
    right: string,
    failed: string,
    options: { isDim: boolean; color?: string; turnId?: string },
  ) => {
    const text = fitWidth(left, columns - Math.max(rightWidth, textWidth(right) + (failWidth > 0 ? 2 + failWidth : 0)) - 1)
    const { turnId } = options
    return (
      <Box key={key} flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          {turnId !== undefined ? (
            // A finished turn's prompt is a press: it lists the turn's calls under the row.
            <Button key={'turn-' + turnId} plain dimColor={options.isDim} label={text} onPress={() => model.onToggleTurn?.(turnId)} />
          ) : (
            <Text dimColor={options.isDim} color={options.color} wrap="truncate-end">
              {text}
            </Text>
          )}
        </Box>
        <Box flexShrink={0} flexDirection="row">
          <Text dimColor>{right}</Text>
          {failWidth > 0 ? <Text color="error">{'  ' + failed.padEnd(failWidth)}</Text> : null}
        </Box>
      </Box>
    )
  }

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

  // The calls of the turn pressed open: tool, then what it ran on; a failure in
  // red with the error the model read under it. Then what the turn edited.
  const details = (key: string, row: CockpitTurnRow) => {
    const calls = row.calls ?? []
    const total = row.rounds.reduce((sum, round) => sum + count(round.calls), 0)
    const toolWidth = Math.min(16, Math.max(4, ...calls.map(call => callTool(call).length)))
    const indent = '     '
    const subjectRoom = columns - indent.length - toolWidth - 2
    if (calls.length === 0) {
      rows.push(
        <Text key={key + '-none'} dimColor>
          {indent + (total === 0 ? 'no calls' : 'no calls recorded for this turn')}
        </Text>,
      )
    }
    calls.forEach((call, i) => {
      const subject = callSubject(call, model.agentStats)
      rows.push(
        <Box key={`${key}-call-${i}`} flexDirection="row">
          <Text dimColor>{indent + callTool(call).slice(0, toolWidth).padEnd(toolWidth) + '  '}</Text>
          <Text color={call.error !== undefined ? 'error' : undefined} wrap="truncate-end">
            {fitWidth((call.error !== undefined ? '✗ ' : '') + (subject || '—'), subjectRoom)}
          </Text>
        </Box>,
      )
      if (call.error !== undefined) {
        rows.push(
          <Text key={`${key}-error-${i}`} color="error" dimColor wrap="truncate-end">
            {indent + ' '.repeat(toolWidth + 2) + fitWidth(call.error, subjectRoom)}
          </Text>,
        )
      }
    })
    if (total > calls.length && calls.length > 0) {
      rows.push(
        <Text key={key + '-more'} dimColor>
          {indent + `… and ${total - calls.length} more`}
        </Text>,
      )
    }
    const files = row.edits?.files ?? []
    files.slice(0, MAX_LISTED_FILES).forEach((file, i) => {
      const lines = describeLines(file)
      rows.push(
        <Box key={`${key}-file-${i}`} flexDirection="row">
          <Text dimColor>{indent + (i === 0 ? 'edited' : '').padEnd(toolWidth) + '  '}</Text>
          <Text wrap="truncate-start">{shortPath(file.path, subjectRoom - lines.length - 1) + ' '}</Text>
          <Text dimColor>{lines}</Text>
        </Box>,
      )
    })
    if (files.length > MAX_LISTED_FILES) {
      rows.push(
        <Text key={key + '-files-more'} dimColor>
          {indent + ' '.repeat(toolWidth + 2) + `… and ${files.length - MAX_LISTED_FILES} more`}
        </Text>,
      )
    }
  }

  const finished = (key: string, number: number, row: CockpitTurnRow, isDim: boolean) => {
    const isOpen = model.expandedTurn === row.turnId
    rows.push(line(key, `#${number} ${label(row)}`, rowStats(row, extraWidth), failMark(row), { isDim, turnId: row.turnId }))
    steers(key + '-steer', row.steers)
    if (isOpen) details(key, row)
  }

  // #1 at the top. Each compaction ends a segment; numbering starts again after it.
  timeline.compacted.forEach((section, s) => {
    section.rows.forEach((row, i) => finished(`old-${s}-${row.turnId}`, i + 1, row, true))
    rows.push(
      <Text key={'compacted-' + s} dimColor>
        ── compacted ──
      </Text>,
    )
  })
  timeline.rows.forEach((row, i) => finished('row-' + row.turnId, i + 1, row, row.isNotification === true))
  if (running !== null) {
    // Its round in place of calls and time: `round 2 · 3 calls`, ending where the times end.
    const brief = roundBrief(running).padStart(CALLS_WIDTH + 2 + TIME_WIDTH)
    const right = brief + ' '.repeat(statsWidth - CALLS_WIDTH - 2 - TIME_WIDTH)
    rows.push(line('running', `▶ #${timeline.rows.length + 1} ${label(running)}`, right, failMark(running), { isDim: false, color: 'claude' }))
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

/** What a call ran on; an Agent call adds what its subagent did, `Read audit.ts · 3 calls · ✗ 1`. */
function callSubject(call: CockpitCall, stats: Readonly<Record<string, CockpitAgentStats>> | undefined): string {
  const seen = call.agentId === undefined ? undefined : stats?.[call.agentId]
  if (seen === undefined) return call.subject
  const detail = describeAgent(seen.calls, undefined, seen.failed)
  return detail === '' ? call.subject : call.subject + ' · ' + detail
}
