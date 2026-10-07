import { describe, expect, test } from 'claude-code/testing'

import {
  endStep,
  formatDuration,
  formatSequence,
  liveSequence,
  spinnerRoom,
  summarize,
  withStreaming,
} from '../hooks/lib/batch'
import { isOlder } from '../hooks/lib/version'
import { drain, spinner, stepStub, SURFACES } from './helpers'

describe('batch helpers', () => {
  test('formats parallel and single batches', async () => {
    expect(formatSequence([3, 2, 1], 12)).toBe('∥3 → ∥2 → 1')
  })

  test('folds the middle of a long sequence, keeping head and tail', async () => {
    const batches = [5, 4, 3, 2, 1, 1, 2, 3, 4, 5]
    expect(formatSequence(batches, 5)).toBe('∥5 → ∥4 → …+6 → ∥4 → ∥5')
    expect(formatSequence(batches, 10)).toBe('∥5 → ∥4 → ∥3 → ∥2 → 1 → 1 → ∥2 → ∥3 → ∥4 → ∥5')
  })

  test('formats durations', async () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(12_340)).toBe('12.3s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
    expect(formatDuration(Number.NaN)).toBe('0ms')
  })

  test('summarizes a turn, or nothing when it made no tool calls', async () => {
    expect(summarize([3, 2, 1], 12_340, 12)).toBe('Batches ∥3 → ∥2 → 1 · 6 calls · 12.3s')
    expect(summarize([1], 500, 12, true)).toBe('Batches 1 · 1 call · 500ms · interrupted')
    expect(summarize([], 500, 12)).toBeUndefined()
  })

  test('tracks the streaming batch, then the finished one', async () => {
    let turn = withStreaming(null, 't1', 2)
    expect(liveSequence(turn)).toEqual([2])
    turn = endStep(turn, 't1', 3)
    expect(turn).toEqual({ turnId: 't1', batches: [3], streaming: null })
    expect(liveSequence(endStep(turn, 't1', 0))).toEqual([3])
  })

  test('sizes the spinner sequence to the width', async () => {
    expect(spinnerRoom(undefined, 12)).toBe(8)
    expect(spinnerRoom(60, 12)).toBe(3)
    expect(spinnerRoom(200, 12)).toBe(12)
  })

  test('compares versions', async () => {
    expect(isOlder('2.1.291')).toBe(true)
    expect(isOlder('2.1.292')).toBe(false)
    expect(isOlder('2.2.0')).toBe(false)
    expect(isOlder('nightly')).toBe(false)
  })
})

describe('batch tracing in a turn', () => {
  test('the spinner shows each batch as it streams, on both surfaces', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read', 'Grep'] }, { tools: ['Edit', 'Edit'] }, { tools: ['Bash'] }]))
    // Stands for the engine's spinner: it shows the suffix it was handed.
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [String((e.props as { suffix?: string }).suffix)] }))

    await $.turn.start({ text: 'fix the bug', turnId: 't1' })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()
      await ui.unmount()
    }

    for (const index of [0, 1, 2]) {
      await drain($.turn.step({ turnId: 't1', index, model: 'any-model', messageCount: 1 + index }))
    }

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '… ∥3 → ∥2 → 1' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the spinner counts a batch while its response is still streaming', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read'] }, { tools: ['Read', 'Grep', 'Glob'] }]))
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [String((e.props as { suffix?: string }).suffix)] }))

    await $.turn.start({ text: 'look around', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))

    // Read the second response two chunks in: two of its three tool_use blocks have arrived.
    const stream = $.turn.step({ turnId: 't1', index: 1, model: 'any-model', messageCount: 2 })
    await stream.next()
    await stream.next()
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '… 1 → ∥2' })).toBeDefined()
      await ui.unmount()
    }
    await drain(stream)
    const ui = await $.ui.mount(spinner('terminal'))
    expect(await ui.find({ type: 'Text', text: '… 1 → ∥3' })).toBeDefined()
  })

  test('a narrow spinner folds the middle of the sequence', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    const plans = [1, 2, 3, 4, 5, 6].map(n => ({ tools: Array.from({ length: n }, () => 'Read') }))
    on('turn.step', stepStub(plans))
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [String((e.props as { suffix?: string }).suffix)] }))

    await $.turn.start({ text: 'read everything', turnId: 't1' })
    for (const index of plans.keys()) {
      await drain($.turn.step({ turnId: 't1', index, model: 'any-model', messageCount: 1 }))
    }
    const ui = await $.ui.mount(spinner('terminal', 60))
    expect(await ui.find({ type: 'Text', text: '… 1 → …+4 → ∥6' })).toBeDefined()
  })

  test('the turn ends with the whole sequence, the call count and the time', async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read', 'Grep'] }, { tools: ['Edit', 'Edit'] }, { tools: ['Bash'] }, { tools: [] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'fix the bug', turnId: 't1' })
    for (const index of [0, 1, 2, 3]) {
      await drain($.turn.step({ turnId: 't1', index, model: 'any-model', messageCount: 1 }))
    }
    const done = await $.turn.complete({ turnId: 't1', answer: 'Fixed.', durationMs: 12_340, isAborted: false, reason: 'answer' })
    expect(done.text).toBe('Batches ∥3 → ∥2 → 1 · 6 calls · 12.3s')
  })

  test("a subagent's steps and turns are not counted", async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read'] }, { tools: ['Read', 'Read', 'Read', 'Read'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await $.turn.start({ text: 'research', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    // The subagent's request and its turn's end carry its agentId.
    await drain($.turn.step({ turnId: 'sub', index: 1, model: 'any-model', messageCount: 1, agentId: 'agent-1' }))
    const sub = await $.turn.complete({ turnId: 'sub', answer: 'report', durationMs: 900, isAborted: false, reason: 'answer', agentId: 'agent-1' })
    expect(sub.text).toBe('report')

    const done = await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 2_000, isAborted: false, reason: 'answer' })
    expect(done.text).toBe('Batches 1 · 1 call · 2.0s')
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
    expect(stopped.text).toBe('Batches ∥2 · 2 calls · 4.0s · interrupted')
  })

  test('the spinner is left alone between turns', async ($, on) => {
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [String((e.props as { suffix?: string }).suffix)] }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(spinner(surface))
      expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('turned off in userConfig, nothing changes', { options: { batchTrace: false } }, async ($, on) => {
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepStub([{ tools: ['Read', 'Read'] }]))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: [String((e.props as { suffix?: string }).suffix)] }))

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
