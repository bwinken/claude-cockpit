import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { readConfig } from './lib/config'
import { diffSnapshots, snapshot } from './lib/git'
import type { GitRun } from './lib/git'
import { beginStep, endStep, spinnerText, startTurn, summarize, withStreaming } from './lib/rounds'
import { addRow, addUsage, foldCompacted, oneLine, PROMPT_KEPT } from './lib/timeline'
import { isOlder, MIN_CLAUDE_CODE } from './lib/version'
import { editsBandTree } from './ui/edits'
import { timelineTree } from './ui/timeline'

// Every $.state value cockpit keeps, declared in types/index.d.ts.
export const live = atom({ plugin: 'cockpit', key: 'live' } as const, null)
export const turnLines = atom({ plugin: 'cockpit', key: 'turnLines' } as const, [])
export const timeline = atom({ plugin: 'cockpit', key: 'timeline' } as const, { compacted: [], rows: [] })
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)
export const lastEdits = atom({ plugin: 'cockpit', key: 'lastEdits' } as const, null)
export const editsExpanded = atom({ plugin: 'cockpit', key: 'editsExpanded' } as const, false)
export const editsDismissed = atom({ plugin: 'cockpit', key: 'editsDismissed' } as const, false)

/** The timeline pane, opened by /cockpit. */
const PANE_ID = 'cockpit-timeline'
const PANE_TITLE = 'Cockpit timeline'

/** How many finished turns' summaries wait for their closing line. */
const KEPT_TURN_LINES = 50

/**
 * True when only the terminal draws this session. Its closing line carries
 * the summary; every other surface (and a headless run, which draws nothing)
 * gets the summary as the line under the answer.
 */
async function isTerminalOnly($: EngineInterface): Promise<boolean> {
  try {
    const surfaces = await $.session.surfaces()
    return surfaces.length > 0 && surfaces.every(surface => surface === 'terminal')
  } catch {
    return false
  }
}

/** git through `$.process.run`, taking no optional lock so it never blocks the person's own git. */
function gitOf($: EngineInterface): GitRun {
  return (args, options) =>
    $.process.run(['git', ...args], {
      cwd: options?.cwd,
      stdin: options?.stdin,
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 15_000,
    })
}

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const tracksTurns = config.roundTrace || config.timeline || config.editedFiles

  on('session.start', async ($, e, next) => {
    try {
      const { version, base } = await $.session.version()
      if (isOlder(base ?? version)) {
        $.ui.toast(`cockpit needs Claude Code ${MIN_CLAUDE_CODE} or later; this is ${version}. Some parts may not work.`)
      }
    } catch {
      // No version to compare against: carry on.
    }
    if (config.timeline) {
      // The pane's running time moves to the minute: a tick every 30s redraws it, and nothing else.
      $.clock.every(30_000, () => void update($, tick, n => (n + 1) % 1_000_000))
      await $.command.register({
        name: 'cockpit',
        description: 'Open the cockpit timeline pane (/cockpit close closes it)',
        argumentHint: '[close]',
      })
    }
    return next(e)
  })

  if (tracksTurns) {
    // turn.start fires for the main loop only; a subagent's run raises none.
    on('turn.start', async ($, e, next) => {
      await update($, live, () => startTurn(e.turnId, oneLine(e.text, PROMPT_KEPT)))
      if (config.editedFiles) {
        const git = await snapshot(gitOf($))
        await update($, live, turn => (turn !== null && turn.turnId === e.turnId ? { ...turn, git } : turn))
      }
      return next(e)
    })

    on('turn.step', async function* ($, e, next) {
      if (e.agentId !== undefined) return yield* next(e)

      // A request going out means the last round's tools have all run.
      await update($, live, turn => beginStep(turn, e.turnId))
      const stream = next(e)
      let seen = 0
      try {
        for await (const chunk of stream) {
          // A tool chunk opens one tool_use block: count it as it arrives.
          if (chunk.kind === 'tool') {
            seen += 1
            await update($, live, turn => withStreaming(turn, e.turnId, seen))
          }
          yield chunk
        }
      } catch (error) {
        await update($, live, turn => endStep(turn, e.turnId, []))
        throw error
      }

      const result = await stream.result
      // The finished response's tool_use list is the round, whatever streamed.
      const names = result.toolUses.map(use => use.name)
      await update($, live, turn => {
        const ended = endStep(turn, e.turnId, names)
        return { ...ended, tokens: addUsage(ended.tokens, result.usage) }
      })
      return result
    })

    on('turn.complete', async ($, e, next) => {
      const answered = await next(e)
      if (e.agentId !== undefined) return answered

      const turn = await read($, live)
      await update($, live, () => null)
      if (turn === null || turn.turnId !== e.turnId) return answered

      let reply = answered
      if (config.roundTrace) {
        const line = summarize(turn.rounds, e.durationMs, config.roundTraceMaxTools, e.isAborted)
        if (line !== undefined) {
          const short = summarize(turn.rounds, undefined, config.roundTraceMaxTools, e.isAborted) ?? line
          const entry = { durationMs: e.durationMs, text: short }
          await update($, turnLines, lines => [...lines, entry].slice(-KEPT_TURN_LINES))
          if (!(await isTerminalOnly($))) {
            // Keep a line another mod beneath already put under the answer.
            const theirs = answered.text !== e.answer && answered.text !== '' ? answered.text + ' · ' : ''
            reply = { ...answered, text: theirs + line }
          }
        }
      }

      let edits = null
      if (config.editedFiles && turn.git) {
        const run = gitOf($)
        const now = await snapshot(run)
        edits = now === null ? null : await diffSnapshots(run, turn.git, now)
        const shown = edits !== null && edits.files.length > 0 ? edits : null
        await update($, lastEdits, () => shown)
        await update($, editsExpanded, () => false)
        await update($, editsDismissed, () => false)
      }

      if (config.timeline) {
        const row = {
          turnId: turn.turnId,
          prompt: turn.prompt,
          rounds: turn.rounds,
          tokens: turn.tokens,
          durationMs: e.durationMs,
          isAborted: e.isAborted,
          edits,
        }
        await update($, timeline, current => addRow(current, row))
      }
      return reply
    })
  }

  if (config.roundTrace) {
    on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
      const text = spinnerText(await read($, live), e.viewport?.columns)
      if (text === undefined) return next(e)
      // Change a detail: the engine keeps its word, animation and counters.
      return next({ ...e, props: { ...e.props, suffix: e.props.suffix + ' ' + text } })
    })

    // The terminal's closing line (`✻ Baked for 5s`): the summary goes on a dim
    // row under it, with no plugin label. Raised on the terminal only.
    on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
      const lines = await read($, turnLines)
      const match = [...lines].reverse().find(line => line.durationMs === e.props.durationMs)
      if (match === undefined) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const theirs = await next(e)
      return (
        <Box flexDirection="column">
          {theirs}
          <Text dimColor>{'  ⎿  ' + match.text}</Text>
        </Box>
      )
    })
  }

  if (config.timeline) {
    on('command.run', { command: 'cockpit' }, async ($, e) => {
      if (e.args.trim() === 'close') {
        await $.ui.close({ id: PANE_ID })
        return {}
      }
      // Opened because the person asked: it seats at any width.
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      return {}
    })

    on('ui.render', { component: 'Pane', requestId: 'cockpit-timeline' }, async ($, e) => {
      // Reading the tick redraws the pane each time it moves, so the running time keeps up.
      await read($, tick)
      let elapsedMs: number | undefined
      let context: { tokens?: number; window?: number; percent?: number } | undefined
      try {
        const usage = await $.session.usage()
        elapsedMs = (await $.clock.now()) - usage.startedAt
        context = usage.context
      } catch {
        // No usage to read: the overview leaves those two out.
      }
      return timelineTree($.ui.resolve(e), {
        timeline: await read($, timeline),
        running: await read($, live),
        columns: e.props.bodyColumns,
        maxTools: config.roundTraceMaxTools,
        elapsedMs,
        context,
      })
    })

    // A compaction keeps $.state: fold this segment's turns, then count afresh.
    on('classic.SessionStart', { source: 'compact' }, async ($, e, next) => {
      await update($, timeline, current => foldCompacted(current))
      return next(e)
    })
  }

  if (config.editedFiles) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      // Keep what the mods beneath draw in the band: cockpit's rows go under it.
      const theirs = await next(e)
      // Yield to a survey, stay out of the way while a turn runs or a subagent is in view.
      if (e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) return theirs
      const edits = await read($, lastEdits)
      if (edits === null || edits.files.length === 0 || (await read($, editsDismissed))) return theirs
      return editsBandTree(
        $.ui.resolve(e),
        {
          edits,
          isExpanded: await read($, editsExpanded),
          columns: e.props.bodyColumns,
          onToggle: () => update($, editsExpanded, shown => !shown),
          onDismiss: () => update($, editsDismissed, () => true),
        },
        theirs,
      )
    })
  }
}
