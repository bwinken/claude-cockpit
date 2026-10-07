import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { beginStep, endStep, spinnerText, startTurn, summarize, withStreaming } from './lib/rounds'
import { readConfig } from './lib/config'
import { isOlder, MIN_CLAUDE_CODE } from './lib/version'

const live = atom({ plugin: 'cockpit', key: 'live' } as const, null)
const turnLines = atom({ plugin: 'cockpit', key: 'turnLines' } as const, [])

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

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    try {
      const { version, base } = await $.session.version()
      if (isOlder(base ?? version)) {
        $.ui.toast(`cockpit needs Claude Code ${MIN_CLAUDE_CODE} or later; this is ${version}. Some parts may not work.`)
      }
    } catch {
      // No version to compare against: carry on.
    }
    return next(e)
  })

  if (config.roundTrace) {
    // turn.start fires for the main loop only; a subagent's run raises none.
    on('turn.start', async ($, e, next) => {
      await update($, live, () => startTurn(e.turnId))
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
      await update($, live, turn => endStep(turn, e.turnId, names))
      return result
    })

    on('turn.complete', async ($, e, next) => {
      const answered = await next(e)
      if (e.agentId !== undefined) return answered

      const turn = await read($, live)
      await update($, live, () => null)
      if (turn === null || turn.turnId !== e.turnId) return answered

      const line = summarize(turn.rounds, e.durationMs, config.roundTraceMaxTools, e.isAborted)
      if (line === undefined) return answered
      const short = summarize(turn.rounds, undefined, config.roundTraceMaxTools, e.isAborted) ?? line
      const entry = { durationMs: e.durationMs, text: short }
      await update($, turnLines, lines => [...lines, entry].slice(-KEPT_TURN_LINES))
      if (await isTerminalOnly($)) return answered
      // Keep a line another mod beneath already put under the answer.
      const theirs = answered.text !== e.answer && answered.text !== '' ? answered.text + ' · ' : ''
      return { ...answered, text: theirs + line }
    })

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
}
