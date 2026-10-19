import { describe, expect, mock, test } from 'claude-code/testing'

import { contextBar, contextGrid, contextMapFrom, describeCategory, describeContextMap } from '../hooks/lib/context'
import { pane, SURFACES } from './helpers'

/** A breakdown as `$.session.usage({ breakdown })` hands it back: only the fields cockpit reads. */
const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 12_000, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 25_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 5_000, color: 'cyan', isDeferred: true, kind: 'deferred' },
    { name: 'Skills', tokens: 0, color: 'warning', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 115_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 45_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 40_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 20,
  model: 'claude-opus',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
}

const USAGE = {
  value: {
    startedAt: 0,
    context: { tokens: 40_000, window: 200_000, percent: 20, breakdown: BREAKDOWN as never },
    rateLimits: [],
  },
}

/** Every Text under a node, a Button by its label. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (node === null || typeof node !== 'object') return []
  const el = node as { type?: string; children?: unknown[]; props?: { label?: string } }
  if (el.type === 'Button') return [el.props?.label ?? '']
  const inner = (el.children ?? []).flatMap(texts)
  return el.type === 'Text' ? [inner.join('')] : inner
}

describe('context map', () => {
  test('keeps the rows inside the window, and the window measured against', () => {
    const map = contextMapFrom(BREAKDOWN)!
    expect(map.categories.map(c => c.name)).toEqual(['System prompt', 'System tools', 'Messages', 'Skills', 'Free space', 'Autocompact buffer'])
    expect(map.window).toBe(200_000)
    expect(describeContextMap(map)).toBe('claude-opus · 40k/200k tokens (20%)')
    expect(describeCategory(map, map.categories[0]!)).toBe('3k (1.5%)')
    expect(describeCategory(map, { name: 'tiny', tokens: 50, color: 'x', kind: 'used' })).toBe('50 (<0.1%)')
    // No categories or no window: nothing to draw.
    expect(contextMapFrom({ mcpTools: [] })).toBeNull()
    expect(contextMapFrom({ ...BREAKDOWN, rawMaxTokens: 0, maxTokens: 0 })).toBeNull()
    expect(contextMapFrom(undefined)).toBeNull()
  })

  test('the grid: a square each 1%, used first, then the window left, the buffer last', () => {
    const grid = contextGrid(contextMapFrom(BREAKDOWN)!)
    expect(grid).toHaveLength(10)
    expect(grid.every(row => row.length === 10)).toBe(true)
    // 1.5 squares of system prompt, 6 of tools, 12.5 of messages: a last square under 70% is hollow.
    expect(grid[0]!.map(s => s.glyph).join('')).toBe('⛁⛀⛁⛁⛁⛁⛁⛁⛁⛁')
    expect(grid[0]!.map(s => s.category)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 2, 2])
    expect(grid[2]!.map(s => s.glyph).join('')).toBe('⛀⛶⛶⛶⛶⛶⛶⛶⛶⛶')
    const flat = grid.flat().map(s => s.glyph).join('')
    expect([...flat].filter(g => g === '⛶')).toHaveLength(56)
    expect([...flat].filter(g => g === '⛝')).toHaveLength(23)
    expect(flat.endsWith('⛝')).toBe(true)
  })

  test('the bar: runs of one category, as wide as asked', () => {
    const map = contextMapFrom(BREAKDOWN)!
    expect(contextBar(map, 20)).toEqual([
      { category: 0, cells: 1 },
      { category: 1, cells: 1 },
      { category: 2, cells: 3 },
      { category: 4, cells: 10 },
      { category: 5, cells: 5 },
    ])
    // Over the window: the used rows still fit, a cell each at least, and nothing is free.
    const full = contextMapFrom({ ...BREAKDOWN, categories: [{ name: 'Messages', tokens: 300_000, color: 'x', kind: 'used' }, { name: 'Prompt', tokens: 10, color: 'y', kind: 'used' }] })!
    const bar = contextBar(full, 20)
    expect(bar.reduce((sum, run) => sum + run.cells, 0)).toBe(20)
    expect(bar).toEqual([
      { category: 0, cells: 19 },
      { category: 1, cells: 1 },
    ])
  })
})

describe('timeline pane context', () => {
  test('a bar of the categories by the figures; pressed, the grid with its legend', async ($, on) => {
    mock.clock(on)
    on('session.usage', () => USAGE)
    on('classic.SessionStart', () => ({}))
    await $.classic.SessionStart({ source: 'clear' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(texts(await ui.find({ key: 'context' })).join('')).toBe('  context' + '■■■■■' + '□'.repeat(15) + '20% of 200k (40k)')
      expect(await ui.find({ key: 'grid-0' })).toBeUndefined()

      await ui.press({ key: 'context-toggle' })
      expect(texts(await ui.find({ key: 'grid-0' })).join('')).toBe('⛁ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁')
      expect(texts(await ui.find({ key: 'legend-head' })).join('')).toBe('claude-opus · 40k/200k tokens (20%)')
      const legend = []
      for (let i = 0; i < 5; i++) legend.push(texts(await ui.find({ key: 'legend-' + i })).join('').replace(/ +/g, ' '))
      expect(legend).toEqual([
        '⛁ System prompt 3k (1.5%)',
        '⛁ System tools 12k (6%)',
        '⛁ Messages 25k (12.5%)',
        '⛶ Free space 115k (57.5%)',
        '⛝ Autocompact buffer 45k (22.5%)',
      ])
      // Deferred tool schemas are outside the window, and an empty row isn't listed.
      expect(await ui.find({ type: 'Text', text: /MCP tools|Skills/ })).toBeUndefined()

      await ui.press({ key: 'context-toggle' })
      expect(await ui.find({ key: 'grid-0' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('on a narrow pane the legend goes under the grid', async ($, on) => {
    mock.clock(on)
    on('session.usage', () => USAGE)
    on('classic.SessionStart', () => ({}))
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await $.ui.mount(pane('terminal', 50))
    await ui.press({ key: 'context-toggle' })
    // Ten rows of grid, then the legend's head on a row of its own.
    expect(texts(await ui.find({ key: 'context-9' })).join('').trim()).toBe('⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝')
    expect(texts(await ui.find({ key: 'context-10' })).join('').trim()).toBe('claude-opus · 40k/200k tokens (20%)')
    await ui.unmount()
  })

  test('without a breakdown the context line is the figures alone', async ($, on) => {
    mock.clock(on)
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 40_000, window: 200_000, percent: 20 }, rateLimits: [] } }))
    on('classic.SessionStart', () => ({}))
    await $.classic.SessionStart({ source: 'clear' })
    const ui = await $.ui.mount(pane('terminal'))
    expect(texts(await ui.find({ key: 'context' })).join('')).toBe('  context20% of 200k (40k)')
    expect(await ui.find({ key: 'context-toggle' })).toBeUndefined()
    await ui.unmount()
  })
})
