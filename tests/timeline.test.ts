import { describe, expect, mock, test } from 'claude-code/testing'

import type { CockpitTurnRow } from '../types'
import { diffSnapshots, parseCounts, parseNumstat, snapshot } from '../hooks/lib/git'
import type { GitRun } from '../hooks/lib/git'
import { makeRound, skillsOf } from '../hooks/lib/rounds'
import {
  addRow,
  addUsage,
  describeTokens,
  EMPTY_TIMELINE,
  foldCompacted,
  formatTokens,
  MAX_ROWS,
  NO_TOKENS,
  describeContext,
  describeMcp,
  describeSkills,
  formatElapsed,
  inventoryFrom,
  inventoryFromTools,
  oneLine,
  sessionTotals,
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

  test('describes the session: elapsed time, context, totals across segments', async () => {
    expect(formatElapsed(30_000)).toBe('<1m')
    expect(formatElapsed(760_000)).toBe('12m')
    expect(formatElapsed(3_900_000)).toBe('1h 05m')
    expect(describeContext({ tokens: 450_000, window: 1_000_000, percent: 45 })).toBe('45% of 1M (450k)')
    // percent left out: worked out from tokens and window.
    expect(describeContext({ tokens: 50_000, window: 200_000 })).toBe('25% of 200k (50k)')
    expect(describeContext({ window: 200_000 })).toBe('not measured yet')
    expect(describeContext(undefined)).toBe('not measured yet')

    const edited = (path: string, added: number) => ({ files: [{ path, added, removed: 1 }], added, removed: 1 })
    let timeline = addRow(EMPTY_TIMELINE, { ...row('t1'), rounds: [makeRound(['Read', 'Read'])], tokens: { in: 100, out: 10, responses: 1 }, edits: edited('a.ts', 3) })
    timeline = foldCompacted(timeline)
    timeline = addRow(timeline, { ...row('t2'), rounds: [makeRound(['Edit'])], tokens: { in: 50, out: 5, responses: 1 }, edits: edited('a.ts', 2) })
    const totals = sessionTotals(timeline, { turnId: 't3', prompt: 'x', rounds: [makeRound(['Read'])], streaming: null, tokens: { in: 1, out: 1, responses: 1 } })
    expect(totals.turns).toBe(3)
    expect(totals.compactions).toBe(1)
    expect(totals.calls).toBe(4)
    expect(totals.tools).toEqual([
      ['Read', 3],
      ['Edit', 1],
    ])
    expect(totals.tokens).toEqual({ in: 151, out: 16, responses: 3 })
    // a.ts edited in two turns counts once, its lines summed.
    expect(totals.edits).toEqual({ files: [{ path: 'a.ts', added: 5, removed: 2 }], added: 5, removed: 2 })
  })

  test('lists skills and MCP servers, the used ones first', async () => {
    const inventory = inventoryFrom(
      [
        { name: 'review-pr', source: 'plugin' },
        { name: 'commit', source: 'userSettings' },
        { name: 'init', source: 'built-in' },
      ],
      [
        { name: 'mcp__github__get_issue', serverName: 'github' },
        { name: 'mcp__github__create_pr', serverName: 'github' },
        { name: 'mcp__claude_ai_Linear__list', serverName: 'claude.ai Linear' },
      ],
    )
    expect(inventory.mcp).toEqual([
      { name: 'claude.ai Linear', prefix: 'mcp__claude_ai_Linear__', tools: 1 },
      { name: 'github', prefix: 'mcp__github__', tools: 2 },
    ])
    const used = addRow(EMPTY_TIMELINE, {
      ...row('t1'),
      rounds: [makeRound(['Skill', 'mcp__github__get_issue', 'mcp__github__create_pr'], ['commit'])],
    })
    expect(describeSkills(inventory, used, null)).toBe('3 · commit ✓, review-pr, init')
    expect(describeMcp(inventory, used, null)).toBe('2 connected · github ×2 (2 tools), claude.ai Linear (1 tool)')
    // Before the first read, and with nothing on hand.
    expect(describeSkills(null, EMPTY_TIMELINE, null)).toBe('checking…')
    expect(describeMcp(null, EMPTY_TIMELINE, null)).toBe('checking…')
    expect(describeMcp({ skills: [], mcp: [] }, EMPTY_TIMELINE, null)).toBe('none connected')
    expect(describeSkills({ skills: [], mcp: [] }, EMPTY_TIMELINE, null)).toBe('none listed')
    // Past MAX_NAMES the rest are counted.
    const many = { skills: Array.from({ length: 9 }, (_, i) => ({ name: 's' + i, source: 'plugin' })), mcp: [] }
    expect(describeSkills(many, EMPTY_TIMELINE, null)).toBe('9 · s0, s1, s2, s3, s4, s5, +3 more')
    // Without a breakdown the tool list still names the servers.
    expect(inventoryFromTools([{ name: 'Read', mcp: false }, { name: 'mcp__github__get_issue', mcp: true }])).toEqual({
      skills: [],
      mcp: [{ name: 'github', prefix: 'mcp__github__', tools: 1 }],
    })
    expect(skillsOf([{ name: 'Skill', input: { skill: 'commit' } }, { name: 'Read', input: { skill: 'x' } }, { name: 'Skill', input: {} }])).toEqual(['commit'])
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

  test("git for Windows' \\r\\n line ends don't spoil the blob ids", async () => {
    const stub = fakeGit()
    const crlf: GitRun = async (args, options) => {
      const value = stub(null, { argv: ['git', ...args], init: options }).value
      return { ...value, stdout: value.stdout.replace(/\n/g, '\r\n') }
    }
    expect(await snapshot(crlf)).toEqual({ root: '/repo', tree: 'aaa', untracked: { 'notes.txt': 'b1' } })
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

/** The texts of an element and its children, in drawing order. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (node === null || typeof node !== 'object') return []
  const el = node as { type?: string; children?: unknown[] }
  const inner = (el.children ?? []).flatMap(texts)
  return el.type === 'Text' ? [inner.join('')] : inner
}

/** The pane's turn lines, top to bottom: `#1 prompt | stats`. */
async function turnLines(ui: { find: (q: { key: string }) => Promise<unknown> }): Promise<string[]> {
  const list = await ui.find({ key: 'turn-list' })
  const out: string[] = []
  for (const child of (list as { children?: unknown[] } | undefined)?.children ?? []) {
    out.push(texts(child).map(t => t.trim().replace(/ +/g, ' ')).join(' | '))
  }
  return out
}

const USAGE_NOW = {
  value: { startedAt: 0, context: { tokens: 450_000, window: 1_000_000, percent: 45 }, rateLimits: [] },
}

describe('timeline pane', () => {
  test('/cockpit opens the pane; the session start does not', async ($, on) => {
    const opened: unknown[] = []
    const registered: string[] = []
    mock.clock(on)
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

  test('the session overview, then one line per turn from #1 down, on both surfaces', async ($, on) => {
    mock.clock(on, { now: 760_000 })
    on('session.usage', () => USAGE_NOW)
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await runTurn($, 't1', 'read the two config files and compare them', 2, 3_200)
    await runTurn($, 't2', 'run the build', 2, 61_000)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: 'Session · running 12m' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '45% of 1M (450k)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2 · 3 tool calls' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Read ×2, Bash' })).toBeDefined()
      // t1 reported every field once and no cache fields once; t2 reported no usage at all.
      expect(await ui.find({ type: 'Text', text: '42.2k in · 350 out' })).toBeDefined()
      expect(await turnLines(ui)).toEqual([
        '#1 read the two config files and compare them | 2 calls 3.2s',
        '#2 run the build | 1 call 1m 01s',
      ])
      expect(await ui.find({ type: 'Text', text: /NaN|undefined/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('the running turn is the last line while it runs', async ($, on) => {
    mock.clock(on)
    on('session.usage', () => USAGE_NOW)
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn(PLANS))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await runTurn($, 't2', 'run the build', 2, 4_000)
    await $.turn.start({ text: 'read the two config files', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      const lines = await turnLines(ui)
      expect(lines[0]).toMatch(/^#1 run the build \| 1 call/)
      expect(lines[1]).toBe('▶ #2 read the two config files | round 1 · 2 calls')
      await ui.unmount()
    }
  })

  test('a compaction draws a divider and the count starts again under it', async ($, on) => {
    mock.clock(on)
    on('session.usage', () => USAGE_NOW)
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
      const lines = await turnLines(ui)
      expect(lines.map(line => line.split(' | ')[0])).toEqual(['#1 first prompt', '#2 second prompt', '── compacted ──', '#1 after compaction'])
      expect(await ui.find({ type: 'Text', text: '3 (1 compaction) · 4 tool calls' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the overview shows the skills and MCP servers on hand, and which were used', async ($, on) => {
    mock.clock(on)
    on('session.usage', () => ({
      value: {
        ...USAGE_NOW.value,
        context: {
          ...USAGE_NOW.value.context,
          breakdown: {
            skills: {
              totalSkills: 3,
              includedSkills: 3,
              tokens: 300,
              skillFrontmatter: [
                { name: 'review-pr', source: 'plugin', tokens: 100 },
                { name: 'commit', source: 'userSettings', tokens: 100 },
                { name: 'init', source: 'built-in', tokens: 100 },
              ],
            },
            mcpTools: [
              { name: 'mcp__github__get_issue', serverName: 'github', tokens: 50, isLoaded: true },
              { name: 'mcp__github__create_pr', serverName: 'github', tokens: 50, isLoaded: false },
              { name: 'mcp__linear__list', serverName: 'linear', tokens: 50, isLoaded: true },
            ],
            // Only the fields cockpit reads; the rest of the breakdown is left out.
          } as never,
        },
      },
    }))
    on('session.surfaces', () => ({ value: ['terminal'] }))
    on('process.run', notGit())
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.step', stepsByTurn({ t1: [{ tools: ['Skill', 'mcp__github__get_issue'], inputs: [{ skill: 'commit' }, {}] }, { tools: [] }] }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await runTurn($, 't1', 'commit the change and link the issue', 2)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: '3 · commit ✓, review-pr, init' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2 connected · github ×1 (2 tools), linear (1 tool)' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('without usage to read, the overview still draws', async ($, on) => {
    on('session.usage', () => ({ deny: 'not available' }))
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'not measured yet' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'no token usage reported' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'checking…' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'No turns yet in this conversation.' })).toBeDefined()
      await ui.unmount()
    }
  })

  for (const source of ['clear', 'resume', 'fork'] as const) {
    test(`after /${source === 'fork' ? 'branch' : source} resets $.state, the pane and the band start empty`, async ($, on) => {
      mock.clock(on)
      on('session.usage', () => USAGE_NOW)
      on('classic.SessionStart', () => ({}))
      on('ui.render', () => ({ type: 'Text' as const, props: {}, children: ['other band'] }))
      // Each test starts with $.state at its defaults, which is how these commands leave it.
      await $.classic.SessionStart({ source })
      for (const surface of SURFACES) {
        const ui = await $.ui.mount(pane(surface))
        expect(await ui.find({ type: 'Text', text: 'No turns yet in this conversation.' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: '0 · 0 tool calls' })).toBeDefined()
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

    // The timeline's line and overview carry the same totals.
    const timeline = await $.ui.mount(pane('terminal'))
    expect((await turnLines(timeline))[0]).toBe('#1 edit the hooks | 1 call 2.0s +10 −1')
    expect(await timeline.find({ type: 'Text', text: '3 files +10 −1' })).toBeDefined()
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
    expect((await turnLines(timeline))[0]).toBe('#1 edit the hooks | 1 call 2.0s')
    expect(await timeline.find({ type: 'Text', text: /files/ })).toBeUndefined()
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
