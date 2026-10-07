import { describe, expect, test } from 'claude-code/testing'

import {
  beginStep,
  endStep,
  formatDuration,
  formatTally,
  makeRound,
  spinnerText,
  startTurn,
  summarize,
  tally,
  toolLabel,
  withStreaming,
} from '../hooks/lib/rounds'
import { isOlder } from '../hooks/lib/version'
import { drain, spinner, stepStub, SURFACES, turnDuration } from './helpers'

// Stands for the engine's spinner: it shows the suffix it was handed.
const suffixStub = ($: unknown, e: { props: unknown }) => ({
  type: 'Text' as const,
  props: {},
  children: [String((e.props as { suffix?: string }).suffix)],
})

describe('round helpers', () => {
  test('describes a round on the spinner', async () => {
    let turn = withStreaming(startTurn('t1'), 't1', 3)
    expect(spinnerText(turn, 120)).toBe('round 1 · parallel processing 3 tool calls')
    turn = endStep(turn, 't1', ['Read', 'Read', 'Grep'])
    // The response is whole and its tools run: still round 1.
    expect(spinnerText(turn, 120)).toBe('round 1 · parallel processing 3 tool calls')
    turn = beginStep(turn, 't1')
    // A new request with no tool call yet: nothing to add.
    expect(spinnerText(turn, 120)).toBeUndefined()
    turn = withStreaming(turn, 't1', 1)
    expect(spinnerText(turn, 120)).toBe('round 2 · processing 1 tool call')
    expect(spinnerText(turn, 80)).toBe('processing 1 tool call')
    expect(spinnerText(null, 120)).toBeUndefined()
  })

  test('counts calls per tool, most used first', async () => {
    const rounds = [makeRound(['Read', 'Read', 'Grep']), makeRound(['Bash', 'Read']), makeRound(['Grep'])]
    expect(tally(rounds)).toEqual([
      ['Read', 3],
      ['Grep', 2],
      ['Bash', 1],
    ])
    expect(formatTally(tally(rounds), 5)).toBe('Read ×3, Grep ×2, Bash')
    expect(formatTally(tally(rounds), 1)).toBe('Read ×3, +2 more')
    expect(toolLabel('mcp__github__get_issue')).toBe('github:get_issue')
  })

  test('formats durations', async () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(12_340)).toBe('12.3s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
    expect(formatDuration(Number.NaN)).toBe('0ms')
  })

  test('summarizes a turn, or nothing when it made no tool calls', async () => {
    const rounds = [makeRound(['Read', 'Read', 'Read']), makeRound(['Bash', 'Bash']), makeRound(['Read'])]
    expect(summarize(rounds, 12_340, 5)).toBe('3 rounds · 6 tool calls (Read ×4, Bash ×2) · 12.3s')
    expect(summarize([makeRound(['Edit'])], 500, 5, true)).toBe('1 round · 1 tool call (Edit) · 500ms · interrupted')
    expect(summarize([], 500, 5)).toBeUndefined()
    // Without a duration, for the terminal's closing line that states it.
    expect(summarize(rounds, undefined, 5)).toBe('3 rounds · 6 tool calls (Read ×4, Bash ×2)')
  })

  test('compares versions', async () => {
    expect(isOlder('2.1.291')).toBe(true)
    expect(isOlder('2.1.292')).toBe(false)
    expect(isOlder('2.2.0')).toBe(false)
    expect(isOlder('nightly')).toBe(false)
  })
})

describe('round tracing in a turn', () => {
  test('the spinner shows the round in progress, on both surfaces', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read', 'Grep'] }, { tools: ['Bash'] }]))
    on('ui.render', suffixStub)

    await $.turn.start({ text: 'fix the bug', turnId: 't1' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()
      await ui.unmount()
    }

    // Two chunks into the first response: two of its three tool calls have arrived.
    const first = $.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 })
    await first.next()
    await first.next()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '… round 1 · parallel processing 2 tool calls' })).toBeDefined()
      await ui.unmount()
    }
    await drain(first)
    // The response is whole and its tools run.
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '… round 1 · parallel processing 3 tool calls' })).toBeDefined()
      await ui.unmount()
    }

    await drain($.turn.step({ turnId: 't1', index: 1, model: 'any-model', messageCount: 2 }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '… round 2 · processing 1 tool call' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a narrow spinner leaves out the round number', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read'] }]))
    on('ui.render', suffixStub)

    await $.turn.start({ text: 'read', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    const ui = await $.ui.mount(spinner('terminal', 70))
    expect(await ui.find({ type: 'Text', text: '… parallel processing 2 tool calls' })).toBeDefined()
  })

  test('the turn ends with rounds, calls per tool and the time', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read', 'Read'] }, { tools: ['Bash', 'Bash'] }, { tools: ['Read'] }, { tools: [] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', suffixStub)

    await $.turn.start({ text: 'fix the bug', turnId: 't1' })
    for (const index of [0, 1, 2, 3]) {
      await drain($.turn.step({ turnId: 't1', index, model: 'any-model', messageCount: 1 }))
    }
    // The last response answered with text: the spinner adds nothing.
    const ui = await $.ui.mount(spinner('terminal'))
    expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()

    const done = await $.turn.complete({ turnId: 't1', answer: 'Fixed.', durationMs: 12_340, isAborted: false, reason: 'answer' })
    expect(done.text).toBe('3 rounds · 6 tool calls (Read ×4, Bash ×2) · 12.3s')
  })

  test("a subagent's steps and turns are not counted", async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read'] }, { tools: ['Grep', 'Grep', 'Grep', 'Grep'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'research', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    // The subagent's request and its turn's end carry its agentId.
    await drain($.turn.step({ turnId: 'sub', index: 1, model: 'any-model', messageCount: 1, agentId: 'agent-1' }))
    const sub = await $.turn.complete({ turnId: 'sub', answer: 'report', durationMs: 900, isAborted: false, reason: 'answer', agentId: 'agent-1' })
    expect(sub.text).toBe('report')

    const done = await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 2_000, isAborted: false, reason: 'answer' })
    expect(done.text).toBe('1 round · 1 tool call (Read) · 2.0s')
  })

  test('a turn without tool calls adds no line, and an interrupted one says so', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: [] }, { tools: ['Bash', 'Bash'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    const quiet = await $.turn.complete({ turnId: 't1', answer: 'Hello.', durationMs: 800, isAborted: false, reason: 'answer' })
    expect(quiet.text).toBe('Hello.')

    await $.turn.start({ text: 'build', turnId: 't2' })
    await drain($.turn.step({ turnId: 't2', index: 1, model: 'any-model', messageCount: 1 }))
    const stopped = await $.turn.complete({ turnId: 't2', answer: '', durationMs: 4_000, isAborted: true, reason: 'aborted' })
    expect(stopped.text).toBe('1 round · 2 tool calls (Bash ×2) · 4.0s · interrupted')
  })

  test('the summary names at most roundTraceMaxTools tools', { options: { roundTraceMaxTools: 2 } }, async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read', 'Grep', 'Glob', 'mcp__github__get_issue'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'x', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    const done = await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1_500, isAborted: false, reason: 'answer' })
    expect(done.text).toBe('1 round · 5 tool calls (Read ×2, Grep, +2 more) · 1.5s')
  })

  test('in a terminal-only session the summary joins the closing line, with no label', async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read'] }, { tools: ['Bash'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    // Stands for the engine's own closing line.
    on('ui.render', ($, e) => ({ type: 'Text' as const, props: {}, children: ['✻ Baked for 3s'] }))

    await $.turn.start({ text: 'x', turnId: 't1' })
    for (const index of [0, 1]) {
      await drain($.turn.step({ turnId: 't1', index, model: 'any-model', messageCount: 1 }))
    }
    const done = await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 3_210, isAborted: false, reason: 'answer' })
    // No line under the answer: the closing line carries it instead.
    expect(done.text).toBe('ok')

    const ui = await $.ui.mount(turnDuration(3_210))
    expect(await ui.find({ type: 'Text', text: '✻ Baked for 3s' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ⎿  2 rounds · 3 tool calls (Read ×2, Bash)' })).toBeDefined()
    await ui.unmount()

    // Another turn's closing line (another duration) is left as the engine draws it.
    const other = await $.ui.mount(turnDuration(999))
    expect(await other.find({ type: 'Text', text: /⎿/ })).toBeUndefined()
    expect(await other.find({ type: 'Text', text: '✻ Baked for 3s' })).toBeDefined()
  })

  for (const surfaces of [['desktop'], ['terminal', 'desktop'], []] as const) {
    const where = surfaces.length === 0 ? 'a headless run' : surfaces.join(' + ')
    test(`with ${where}, the summary is the line under the answer`, async ($, on) => {
      on('session.surfaces', () => ({ value: surfaces }))
      on('turn.start', ($, e) => ({ turnId: e.turnId }))
      on('turn.step', stepStub([{ tools: ['Read', 'Read'] }]))
      on('turn.complete', ($, e) => ({ text: e.answer }))

      await $.turn.start({ text: 'x', turnId: 't1' })
      await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
      const done = await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 3_210, isAborted: false, reason: 'answer' })
      expect(done.text).toBe('1 round · 2 tool calls (Read ×2) · 3.2s')
    })
  }

  test('the spinner is left alone between turns', async ($, on) => {
    on('ui.render', suffixStub)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('turned off in userConfig, nothing changes', { options: { roundTrace: false } }, async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', suffixStub)

    await $.turn.start({ text: 'x', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    const ui = await $.ui.mount(spinner('terminal'))
    expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()
    const done = await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 10, isAborted: false, reason: 'answer' })
    expect(done.text).toBe('ok')
  })

  test('warns once at session start on an older Claude Code', async ($, on) => {
    const toasts: string[] = []
    on('session.start', () => ({ cwd: '/work' }))
    on('session.version', () => ({ value: { version: '2.1.200', base: '2.1.200', builtAt: '2026-01-01T00:00:00Z' } }))
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toMatch(/2\.1\.292/)
  })
})
