// The context window by category, as /context breaks it down: a grid of
// squares, one colour a category, and a legend beside it. Pure: the breakdown
// comes in from register.tsx, the pane draws what these return.

import type { CockpitContextCategory, CockpitContextMap } from '../../types'
import { count } from './rounds'
import { formatTokens } from './timeline'

/** The grid's size: 10 by 10, a square for each 1% of the window, as /context draws it. */
export const GRID_WIDTH = 10
export const GRID_HEIGHT = 10

/** The cells of the one-line bar beside the context figures: 5% a cell. */
export const BAR_CELLS = 20

/** /context's glyphs: a full square, one under 70% full, the window left, the compaction reserve. */
export const SQUARE = { full: '⛁', partial: '⛀', free: '⛶', buffer: '⛝' } as const

/**
 * What the pane keeps of `$.session.usage({ breakdown })`: the rows inside the
 * window (deferred tool schemas are outside it) and the window measured
 * against. Null when the breakdown carries no categories or no window.
 */
export function contextMapFrom(breakdown: unknown): CockpitContextMap | null {
  if (typeof breakdown !== 'object' || breakdown === null) return null
  const b = breakdown as Record<string, unknown>
  const window = count(b.rawMaxTokens) || count(b.maxTokens)
  if (!Array.isArray(b.categories) || window === 0) return null
  const categories: CockpitContextCategory[] = []
  for (const row of b.categories as unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const kind = r.kind === 'free' || r.kind === 'buffer' || r.kind === 'deferred' ? r.kind : 'used'
    if (kind === 'deferred' || r.isDeferred === true) continue
    categories.push({
      name: typeof r.name === 'string' ? r.name : '',
      tokens: count(r.tokens),
      color: typeof r.color === 'string' && r.color !== '' ? r.color : 'inactive',
      kind,
    })
  }
  if (categories.length === 0) return null
  const used = categories.filter(c => c.kind === 'used').reduce((sum, c) => sum + c.tokens, 0)
  return {
    categories,
    window,
    used: count(b.totalTokens) || used,
    percent: typeof b.percentage === 'number' ? count(b.percentage) : Math.round((used / window) * 100),
    model: typeof b.model === 'string' ? b.model : '',
  }
}

/** One square of the grid: the category it belongs to (by index), and its glyph. */
export type ContextSquare = { category: number; glyph: string }

/**
 * Each category's share of `cells`: the used rows first, in their order, then
 * the free space, the compaction buffer last. A used row with any tokens
 * keeps at least one cell, as /context's grid keeps it; the free space gives
 * way first when they overflow. `fullness` is how full the row's last cell
 * is, 0 to 1.
 */
function shares(map: CockpitContextMap, cells: number): Array<{ category: number; cells: number; fullness: number }> {
  const exact = (tokens: number) => (tokens / map.window) * cells
  const out: Array<{ category: number; cells: number; fullness: number }> = []
  let taken = 0
  for (const i of gridOrder(map)) {
    const c = map.categories[i]!
    if (c.kind === 'free') continue
    const e = exact(c.tokens)
    const n = c.tokens === 0 ? 0 : Math.max(c.kind === 'used' ? 1 : 0, Math.round(e))
    const fullness = n === 0 ? 0 : Math.min(1, Math.max(0, e - (n - 1)))
    out.push({ category: i, cells: n, fullness })
    taken += n
  }
  // Too many: take cells back from the largest used row until they fit.
  while (taken > cells) {
    const largest = out.filter(s => map.categories[s.category]!.kind === 'used' && s.cells > 1).sort((a, b) => b.cells - a.cells)[0]
    const victim = largest ?? out.filter(s => s.cells > 0).sort((a, b) => b.cells - a.cells)[0]
    if (victim === undefined) break
    victim.cells -= 1
    victim.fullness = 1
    taken -= 1
  }
  const free = map.categories.findIndex(c => c.kind === 'free')
  const left = Math.max(0, cells - taken)
  // The free space sits between what's used and the buffer.
  const bufferAt = out.findIndex(s => map.categories[s.category]!.kind === 'buffer')
  const freeShare = { category: free, cells: left, fullness: 1 }
  if (left > 0) out.splice(bufferAt === -1 ? out.length : bufferAt, 0, freeShare)
  return out.filter(s => s.cells > 0)
}

/**
 * The grid, row by row, as /context draws it: used squares in their
 * category's colour (a last square under 70% full drawn hollow), the window
 * left, the compaction reserve. A square of the window left has category -1
 * when the breakdown names no free row.
 */
export function contextGrid(map: CockpitContextMap, width = GRID_WIDTH, height = GRID_HEIGHT): ContextSquare[][] {
  const squares: ContextSquare[] = []
  for (const share of shares(map, width * height)) {
    const kind = share.category === -1 ? 'free' : map.categories[share.category]!.kind
    for (let k = 0; k < share.cells; k++) {
      const isLast = k === share.cells - 1
      const glyph =
        kind === 'free' ? SQUARE.free : kind === 'buffer' ? SQUARE.buffer : isLast && share.fullness < 0.7 ? SQUARE.partial : SQUARE.full
      squares.push({ category: share.category, glyph })
    }
  }
  const rows: ContextSquare[][] = []
  for (let r = 0; r < height; r++) rows.push(squares.slice(r * width, (r + 1) * width))
  return rows
}

/**
 * The one-line bar, `cells` wide: what's used, the window left, the
 * compaction reserve. What's used is the live figure (the last response's
 * input) where there is one, the breakdown's estimate otherwise; the window
 * and the reserve are the breakdown's. Anything used shows as a cell at least.
 */
export function usageBar(
  map: CockpitContextMap,
  context: { tokens?: number } | undefined,
  cells = BAR_CELLS,
): Array<{ kind: 'used' | 'free' | 'buffer'; cells: number }> {
  const scaled = (tokens: number) => Math.round((tokens / map.window) * cells)
  const tokens = context?.tokens ?? map.used
  const buffer = Math.min(cells, scaled(map.categories.filter(c => c.kind === 'buffer').reduce((sum, c) => sum + c.tokens, 0)))
  const used = Math.min(cells - buffer, tokens > 0 ? Math.max(1, scaled(tokens)) : 0)
  const runs = [
    { kind: 'used' as const, cells: used },
    { kind: 'free' as const, cells: cells - buffer - used },
    { kind: 'buffer' as const, cells: buffer },
  ]
  return runs.filter(run => run.cells > 0)
}

/** The categories' indexes in the order the grid draws them: used, free, then buffer. */
export function gridOrder(map: CockpitContextMap): number[] {
  return (['used', 'free', 'buffer'] as const).flatMap(kind => map.categories.flatMap((c, i) => (c.kind === kind ? [i] : [])))
}

/** The legend's header, as /context heads it: `claude-opus · 45k/200k tokens (23%)`. */
export function describeContextMap(map: CockpitContextMap): string {
  const figures = `${formatTokens(map.used)}/${formatTokens(map.window)} tokens (${map.percent}%)`
  return map.model === '' ? figures : `${map.model} · ${figures}`
}

/** A legend row's figures: `3.1k (1.6%)`. */
export function describeCategory(map: CockpitContextMap, category: CockpitContextCategory): string {
  const share = (category.tokens / map.window) * 100
  const percent = share > 0 && share < 0.1 ? '<0.1' : share.toFixed(1).replace(/\.0$/, '')
  return `${formatTokens(category.tokens)} (${percent}%)`
}

/** The glyph a category's legend row starts with. */
export function legendGlyph(category: CockpitContextCategory): string {
  return category.kind === 'free' ? SQUARE.free : category.kind === 'buffer' ? SQUARE.buffer : SQUARE.full
}
