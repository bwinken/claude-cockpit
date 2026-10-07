import { describe, expect, test } from 'claude-code/testing'

import type { CockpitTurnRow } from '../types'
import { diffSnapshots, parseCounts, parseNumstat, snapshot } from '../hooks/lib/git'
import type { GitRun } from '../hooks/lib/git'
import { makeRound } from '../hooks/lib/rounds'
import {
  addRow,
  addUsage,
  describeTokens,
  EMPTY_TIMELINE,
  foldCompacted,
  formatTokens,
  MAX_ROWS,
  NO_TOKENS,
  oneLine,
  shortPath,
} from '../hooks/lib/timeline'
import { band, drain, fakeGit, notGit, pane, stepsByTurn, SURFACES } from './helpers'

const USAGE = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 900, model: 'any-model' }

function row(turnId: string): CockpitTurnRow {
  return { turnId, prompt: turnId, rounds: [], tokens: NO_TOKENS, durationMs: 1000, isAborted: false, edits: null }
}

/** fakeGit as a GitRun, for calling the git module directly. */
function gitRun(stub: ReturnType<typeof fakeGit>): GitRun {
  return async (args, options) => stub(null, { argv: ['git', ...args], init: options }).value
}

describe('timeline helpers', () => {
  test('adds usage whatever fields the provider reports', async () => {
    expect(addUsage(NO_TOKENS, USAGE)).toEqual({ in: 42_100, out: 300, responses: 1 })
    expect(shortPath('a/b', 12)).toBe('a/b')
    // A gateway that reports no cache fields, or reports them as zero.
    expect(addUsage(NO_TOKENS, { input_tokens: 500, output_tokens: 20 })).toEqual({ in: 500, out: 20, responses: 1 })
    expect(addUsage(NO_TOKENS, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 })).toEqual({ in: 0, out: 0, responses: 1 })
    // Fields of the wrong type, or not numbers, count as 0: never NaN.
    expect(addUsage(NO_TOKENS, { input_tokens: 'many', output_tokens: Number.NaN, cache_read_input_tokens: null })).toEqual({ in: 0, out: 0, responses: 1 })
    // No usage at all adds nothing.
    expect(addUsage(NO_TOKENS, null)).toEqual(NO_TOKENS)
    expect(describeTokens(NO_TOKENS)).toBe('no token usage reported')
    expect(describeTokens({ in: 42_100, out: 300, responses: 2 })).toBe('42.1k in · 300 out')
  })

  test('formats token counts and cuts prompts and paths', async () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(42_100)).toBe('42.1k')
    expect(formatTokens(250_000)).toBe('250k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(oneLine('fix   the\nfailing  test', 50)).toBe('fix the failing test')
    expect(oneLine('a very long prompt indeed', 10)).toBe('a very lo…')
    expect(shortPath('hooks/lib/rounds.ts', 12)).toBe('…/rounds.ts')
  })

  test('folds turns on compaction without dropping any', async () => {
    let timeline = addRow(addRow(EMPTY_TIMELINE, row('t1')), row('t2'))
    timeline = foldCompacted(timeline)
    expect(timeline.rows).toEqual([])
    expect(timeline.compacted.map(section => section.rows.map(r => r.turnId))).toEqual([['t1', 't2']])
    // A compaction with no turn since the last one adds no empty section.
    expect(foldCompacted(timeline)).toBe(timeline)
  })

  test('keeps at most MAX_ROWS turns, the oldest going first', async () => {
    let timeline = EMPTY_TIMELINE
    for (let i = 0; i < 150; i++) timeline = addRow(timeline, row('old' + i))
    timeline = foldCompacted(timeline)
    for (let i = 0; i < 100; i++) timeline = addRow(timeline, row('new' + i))
    const kept = timeline.compacted.reduce((n, s) => n + s.rows.length, 0) + timeline.rows.length
    expect(kept).toBe(MAX_ROWS)
    expect(timeline.compacted[0]!.rows[0]!.turnId).toBe('old50')
    expect(timeline.rows.length).toBe(100)
  })
})

describe('git snapshots', () => {
  test('parses numstat, binary files included', async () => {
    expect(parseNumstat('3\t1\thooks/a.ts\0-\t-\timg.png\0')).toEqual([
      { path: 'hooks/a.ts', added: 3, removed: 1 },
      { path: 'img.png', added: null, removed: null },
    ])
    expect(parseCounts('2\t0\tb1 => b2\n')).toEqual({ added: 2, removed: 0 })
    expect(parseCounts('')).toEqual({ added: null, removed: null })
  })

  test('diffs tracked and untracked files between two snapshots', async () => {
    const run = gitRun(fakeGit())
    const before = await snapshot(run)
    const after = await snapshot(run)
    expect(before).toEqual({ root: '/repo', tree: 'aaa', untracked: { 'notes.txt': 'b1' } })
    const edits = await diffSnapshots(run, before!, after!)
    expect(edits).toEqual({
      files: [
        { path: 'hooks/a.ts', added: 3, removed: 1 },
        { path: 'new.txt', added: 5, removed: 0 },
        { path: 'notes.txt', added: 2, removed: 0 },
      ],
      added: 10,
      removed: 1,
    })
  })

  test('outside a git repository there is no snapshot', async () => {
    const run: GitRun = async () => ({ exitCode: 128, stdout: '' })
    expect(await snapshot(run)).toBeNull()
  })
})

/** One main-loop turn through the hooks: start, each step, complete. */
async function runTurn(
  $: { turn: { start: Function; step: Function; complete: Function } },
  turnId: string,
  text: string,
  steps: number,
  durationMs = 2_000,
) {
  await $.turn.start({ text, turnId })
  for (let index = 0; index < steps; index++) {
    await drain($.turn.step({ turnId, index, model: 'any-model', messageCount: 1 + index }))
  }
  return $.turn.complete({ turnId, answer: 'done', durationMs, isAborted: false, reason: 'answer' })
}

const PLANS = {
  t1: [{ tools: ['Read', 'Read'], usage: USAGE }, { tools: [], usage: { input_tokens: 100, output_tokens: 50 } }],
  t2: [{ tools: ['Bash'], usage: null }, { tools: [] }],
  t3: [{ tools: ['Edit'], usage: { input_tokens: 10, output_tokens: 5 } }, { tools: [] }],
}

describe('timeline pane', () => {
  test('/cockpit opens the pane; the session start does not', async ($, on) => {
    const opened: unknown[] = []
    const registered: string[] = []
    on('session.start', () => ({ cwd: '/work' }))
    on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292', builtAt: '' } }))
    on('command.register', ($, e) => {
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    on('ui.open', ($, e) => {
      opened.push(e)
      return { value: { isPlaced: true } }
    })
    on('ui.close', () => ({ value: undefined }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(registered).toEqual(['cockpit'])
    expect(opened).toEqual([])

    await $.command.run({ command: 'cockpit', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect(opened).toEqual([{ id: 'cockpit-timeline', title: 'Cockpit timeline' }])
  })

  test('one row per turn, newest first, on both surfaces; missing usage never shows NaN', async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await runTurn($, 't1', 'read the two config files and compare them', 2, 3_200)
    await runTurn($, 't2', 'run the build', 2, 61_000)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: '#2 run the build' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1m 01s' })).toBeDefined()
      // t2's responses reported no usage at all.
      expect(await ui.find({ type: 'Text', text: '   1 round · 1 tool call (Bash) · no token usage reported' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '#1 read the two config files and compare them' })).toBeDefined()
      // t1: one response with every field, one with no cache fields.
      expect(await ui.find({ type: 'Text', text: '   1 round · 2 tool calls (Read ×2) · 42.2k in · 350 out' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /NaN|undefined/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the running turn is listed at the top while it runs', async ($, on) => {
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))

    await $.turn.start({ text: 'read the two config files', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: '▶ #1 read the two config files' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '   running · round 1 · parallel processing 2 tool calls · 42.1k in · 300 out' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a compaction folds the turns so far and the count starts again', async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('classic.SessionStart', () => ({}))

    await runTurn($, 't1', 'first prompt', 2, 3_000)
    await runTurn($, 't2', 'second prompt', 2, 4_000)
    await $.classic.SessionStart({ source: 'compact' })
    await runTurn($, 't3', 'after compaction', 2, 1_000)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: '#1 after compaction' })).toBeDefined()
      expect(
        await ui.find({ type: 'Text', text: '── compacted · 2 turns · 3 tool calls · 42.2k in · 350 out · 7.0s' }),
      ).toBeDefined()
      // Folded: the old rows are kept but not drawn until asked for.
      expect(await ui.find({ type: 'Text', text: '#1 first prompt' })).toBeUndefined()
      await ui.press({ key: 'toggle-compacted-0' })
      expect(await ui.find({ type: 'Text', text: '#1 first prompt' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '#2 second prompt' })).toBeDefined()
      await ui.press({ key: 'toggle-compacted-0' })
      expect(await ui.find({ type: 'Text', text: '#1 first prompt' })).toBeUndefined()
      await ui.unmount()
    }
  })

  for (const source of ['clear', 'resume', 'fork'] as const) {
    test(`after /${source === 'fork' ? 'branch' : source} resets $.state, the pane and the band start empty`, async ($, on) => {
      on('classic.SessionStart', () => ({}))
      on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['other band'] }))
      // Each test starts with $.state at its defaults, which is how these commands leave it.
      await $.classic.SessionStart({ source })
      for (const surface of SURFACES) {
        const ui = await $.ui.mount(pane(surface))
        expect(await ui.find({ type: 'Text', text: 'No turns yet in this conversation.' })).toBeDefined()
        await ui.unmount()
        const above = await $.ui.mount(band(surface))
        expect(await above.find({ type: 'Text', text: 'other band' })).toBeDefined()
        expect(await above.find({ type: 'Text', text: /^Edited/ })).toBeUndefined()
        await above.unmount()
      }
    })
  }
})

describe('edited files band', () => {
  test('shows what the turn changed, expands to files, and can be dismissed, on both surfaces', async ($, on) => {
    const calls: string[][] = []
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', fakeGit(calls))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    // Another mod's band content, which cockpit keeps.
    on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['other band'] }))

    await runTurn($, 't3', 'edit the hooks', 2)

    // Only read-only git ran: no add, commit, checkout, reset or stash push.
    const subcommands = new Set(calls.map(argv => argv.slice(1, 3).join(' ')))
    for (const sub of subcommands) expect(sub).toMatch(/^(rev-parse|stash create|ls-files|hash-object -w|diff --numstat)/)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.find({ type: 'Text', text: 'other band' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Edited 3 files' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '+10' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '−1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '  hooks/a.ts' })).toBeUndefined()
      await ui.press({ key: 'edits-toggle' })
      expect(await ui.find({ type: 'Text', text: '  hooks/a.ts' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '  new.txt' })).toBeDefined()
      await ui.press({ key: 'edits-toggle' })
      expect(await ui.find({ type: 'Text', text: '  hooks/a.ts' })).toBeUndefined()
      await ui.unmount()
    }

    // The timeline row carries the same totals.
    const timeline = await $.ui.mount(pane('terminal'))
    expect(await timeline.find({ type: 'Text', text: '   1 round · 1 tool call (Edit) · 10 in · 5 out · +10 −1 in 3 files' })).toBeDefined()
    await timeline.unmount()

    const ui = await $.ui.mount(band('terminal'))
    await ui.press({ key: 'edits-dismiss' })
    expect(await ui.find({ type: 'Text', text: /^Edited/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'other band' })).toBeDefined()
  })

  test('stays out of the way during a turn, a survey, or a subagent view', async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', fakeGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['other band'] }))

    await runTurn($, 't3', 'edit the hooks', 2)
    for (const surface of SURFACES) {
      for (const props of [{ isWorking: true }, { hasSurvey: true }, { agentId: 'agent-1' }]) {
        const ui = await $.ui.mount(band(surface, props))
        expect(await ui.find({ type: 'Text', text: /^Edited/ })).toBeUndefined()
        expect(await ui.find({ type: 'Text', text: 'other band' })).toBeDefined()
        await ui.unmount()
      }
    }
  })

  test('outside a git repository nothing is shown', async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['other band'] }))

    await runTurn($, 't3', 'edit the hooks', 2)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.find({ type: 'Text', text: /^Edited/ })).toBeUndefined()
      await ui.unmount()
    }
    const timeline = await $.ui.mount(pane('terminal'))
    expect(await timeline.find({ type: 'Text', text: '   1 round · 1 tool call (Edit) · 10 in · 5 out' })).toBeDefined()
  })

  test('turned off in userConfig, git never runs', { options: { editedFiles: false } }, async ($, on) => {
    const calls: string[][] = []
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', fakeGit(calls))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await runTurn($, 't3', 'edit the hooks', 2)
    expect(calls).toEqual([])
  })
})

describe('timeline turned off', () => {
  test('no /cockpit command is registered', { options: { timeline: false } }, async ($, on) => {
    const registered: string[] = []
    on('session.start', () => ({ cwd: '/work' }))
    on('session.version', () => ({ value: { version: '2.1.292', base: '2.1.292', builtAt: '' } }))
    on('command.register', ($, e) => {
      registered.push(e.name)
      return { value: { command: e.name } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(registered).toEqual([])
  })
})
