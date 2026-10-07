// Pure helpers for the timeline pane and the edited-files band.

import type {
  CockpitEdits,
  CockpitInventory,
  CockpitLiveTurn,
  CockpitMcpServer,
  CockpitRound,
  CockpitTimeline,
  CockpitTokens,
  CockpitTurnRow,
} from '../../types'
import { totalEdits } from './git'
import { count, tally } from './rounds'

/** The most turns the timeline keeps, compacted sections included; the oldest go first. */
export const MAX_ROWS = 200
/** How much of a prompt a row keeps. */
export const PROMPT_KEPT = 240

export const EMPTY_TIMELINE: CockpitTimeline = { compacted: [], rows: [] }
export const NO_TOKENS: CockpitTokens = { in: 0, out: 0, responses: 0 }

/**
 * Adds one response's usage. Any field may be missing, zero or not a number
 * (some providers and gateways report no cache fields): each counts as 0.
 * A response with no usage object at all adds nothing.
 */
export function addUsage(tokens: CockpitTokens, usage: unknown): CockpitTokens {
  if (usage === null || typeof usage !== 'object') return tokens
  const u = usage as Record<string, unknown>
  return {
    in: tokens.in + count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens),
    out: tokens.out + count(u.output_tokens),
    responses: tokens.responses + 1,
  }
}

/** `950`, `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  const value = count(n)
  if (value < 1000) return String(value)
  if (value < 1_000_000) return (value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, '') + 'k'
  return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

/** `42.1k in · 1.2k out`, or `no token usage reported`. */
export function describeTokens(tokens: CockpitTokens): string {
  if (count(tokens.responses) === 0) return 'no token usage reported'
  return `${formatTokens(tokens.in)} in · ${formatTokens(tokens.out)} out`
}

/** One line of a prompt: whitespace folded, cut to `max` characters with `…`. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const room = Math.max(1, count(max))
  if (line.length <= room) return line
  return line.slice(0, Math.max(0, room - 1)).trimEnd() + '…'
}

/** A path cut from its start to `max` characters, at a `/` where one fits: `…/rounds.ts`. */
export function shortPath(path: string, max: number): string {
  const room = Math.max(4, count(max))
  if (path.length <= room) return path
  const tail = path.slice(path.length - room + 1)
  const slash = tail.indexOf('/')
  return '…' + (slash >= 0 && slash < tail.length - 1 ? tail.slice(slash) : tail)
}

/** `+682 −1`. */
export function describeLines(edits: { added: number | null; removed: number | null; large?: true }): string {
  if (edits.large === true) return 'large file'
  if (edits.added === null && edits.removed === null) return 'binary'
  return `+${count(edits.added)} −${count(edits.removed)}`
}

/** `Edited 9 files +682 −1`. */
export function describeEdits(edits: CockpitEdits): string {
  const files = edits.files.length
  return `Edited ${files} ${files === 1 ? 'file' : 'files'} ${describeLines(edits)}`
}

function trim(timeline: CockpitTimeline): CockpitTimeline {
  let excess = timeline.compacted.reduce((sum, section) => sum + section.rows.length, 0) + timeline.rows.length - MAX_ROWS
  if (excess <= 0) return timeline
  const compacted = []
  for (const section of timeline.compacted) {
    if (excess >= section.rows.length) {
      excess -= section.rows.length
      continue
    }
    compacted.push(excess > 0 ? { rows: section.rows.slice(excess) } : section)
    excess = 0
  }
  return { compacted, rows: excess > 0 ? timeline.rows.slice(excess) : timeline.rows }
}

/** The timeline with a finished turn appended. */
export function addRow(timeline: CockpitTimeline, row: CockpitTurnRow): CockpitTimeline {
  return trim({ ...timeline, rows: [...timeline.rows, row] })
}

/**
 * The timeline after a compaction: the turns so far fold into a compacted
 * section, nothing is dropped, and the next turn is #1 of a new segment.
 */
export function foldCompacted(timeline: CockpitTimeline): CockpitTimeline {
  if (timeline.rows.length === 0) return timeline
  return { compacted: [...timeline.compacted, { rows: timeline.rows }], rows: [] }
}

/** `<1m`, `12m`, `1h 05m`: how long the session has run, to the minute. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(count(ms) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return minutes + 'm'
  return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm'
}

/** `45% of 1M (450k)`, or a note while no response has measured it yet. */
export function describeContext(context: { tokens?: number; window?: number; percent?: number } | undefined): string {
  if (context === undefined || context.tokens === undefined) return 'not measured yet'
  const window = count(context.window)
  const percent = context.percent ?? (window > 0 ? Math.round((count(context.tokens) / window) * 100) : undefined)
  const used = formatTokens(context.tokens)
  if (percent === undefined || window === 0) return used
  return `${count(percent)}% of ${formatTokens(window)} (${used})`
}

export type SessionTotals = {
  turns: number
  compactions: number
  calls: number
  tools: Array<[string, number]>
  tokens: CockpitTokens
  edits: CockpitEdits | null
}

/**
 * The whole session so far: every turn in every segment, plus the one
 * running. Files edited in several turns count once, their lines summed.
 */
export function sessionTotals(timeline: CockpitTimeline, running: CockpitLiveTurn | null): SessionTotals {
  const rows = [...timeline.compacted.flatMap(section => section.rows), ...timeline.rows]
  const rounds = [...rows.flatMap(row => row.rounds), ...(running?.rounds ?? [])]
  let tokens = NO_TOKENS
  for (const t of [...rows.map(row => row.tokens), ...(running ? [running.tokens] : [])]) {
    tokens = { in: tokens.in + count(t.in), out: tokens.out + count(t.out), responses: tokens.responses + count(t.responses) }
  }
  const files = new Map<string, { added: number | null; removed: number | null }>()
  for (const row of rows) {
    for (const file of row.edits?.files ?? []) {
      const seen = files.get(file.path)
      const sum = (a: number | null | undefined, b: number | null) => (a == null && b === null ? null : count(a) + count(b))
      files.set(file.path, { added: sum(seen?.added, file.added), removed: sum(seen?.removed, file.removed) })
    }
  }
  const edits = files.size === 0 ? null : totalEdits([...files].map(([path, lines]) => ({ path, ...lines })))
  return {
    turns: rows.length + (running ? 1 : 0),
    compactions: timeline.compacted.length,
    calls: rounds.reduce((sum, round) => sum + count(round.calls), 0),
    tools: tally(rounds),
    tokens,
    edits,
  }
}

/** A row's calls for its one line: `3 calls`, `1 call`, `no calls`. */
export function describeCalls(rounds: readonly CockpitRound[]): string {
  const calls = rounds.reduce((sum, round) => sum + count(round.calls), 0)
  return calls === 0 ? 'no calls' : `${calls} ${calls === 1 ? 'call' : 'calls'}`
}

/** How many skill or server names a line of the overview lists before `+k more`. */
export const MAX_NAMES = 6

/** The session's inventory from `$.session.usage({ breakdown })`: listed skills, MCP servers by tool. */
export function inventoryFrom(
  skills: ReadonlyArray<{ name: string; source: string }> | undefined,
  mcpTools: ReadonlyArray<{ name: string; serverName: string }> | undefined,
): CockpitInventory {
  const servers = new Map<string, CockpitMcpServer>()
  for (const tool of mcpTools ?? []) {
    const seen = servers.get(tool.serverName)
    const prefix = seen?.prefix ?? (/^(mcp__.+?__)/.exec(tool.name)?.[1] ?? tool.name)
    servers.set(tool.serverName, { name: tool.serverName, prefix, tools: (seen?.tools ?? 0) + 1 })
  }
  return {
    skills: (skills ?? []).map(skill => ({ name: skill.name, source: skill.source })),
    mcp: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** The same from `$.tool.list()` alone, where no breakdown is had: servers by tool-name prefix, no skills. */
export function inventoryFromTools(tools: ReadonlyArray<{ name: string; mcp: boolean }>): CockpitInventory {
  const servers = new Map<string, CockpitMcpServer>()
  for (const tool of tools) {
    const match = tool.mcp ? /^(mcp__(.+?)__)/.exec(tool.name) : null
    if (!match) continue
    const seen = servers.get(match[1]!)
    servers.set(match[1]!, { name: match[2]!, prefix: match[1]!, tools: (seen?.tools ?? 0) + 1 })
  }
  return { skills: [], mcp: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

function rounds(timeline: CockpitTimeline, running: CockpitLiveTurn | null): CockpitRound[] {
  return [...timeline.compacted.flatMap(section => section.rows), ...timeline.rows].flatMap(row => row.rounds).concat(running?.rounds ?? [])
}

function names(entries: string[], max: number): string {
  const shown = entries.slice(0, max)
  return shown.join(', ') + (entries.length > shown.length ? `, +${entries.length - shown.length} more` : '')
}

/** `14 · commit ×2, review-pr, init, +11 more`: the used ones first, with their counts. */
export function describeSkills(inventory: CockpitInventory | null, timeline: CockpitTimeline, running: CockpitLiveTurn | null): string {
  const used = new Map<string, number>()
  for (const round of rounds(timeline, running)) {
    for (const [name, n] of Object.entries(round.skills ?? {})) used.set(name, (used.get(name) ?? 0) + count(n))
  }
  const listed = inventory?.skills.map(skill => skill.name) ?? []
  if (listed.length === 0 && used.size === 0) return inventory === null ? 'checking…' : 'none listed'
  const ordered = [
    ...[...used].sort((a, b) => b[1] - a[1]).map(([name, n]) => (n > 1 ? `${name} ×${n}` : `${name} ✓`)),
    ...listed.filter(name => !used.has(name)),
  ]
  const total = new Set([...listed, ...used.keys()]).size
  return `${total} · ${names(ordered, MAX_NAMES)}`
}

/** `2 connected · github ×3 (24 tools), linear (8 tools)`: the used servers first. */
export function describeMcp(inventory: CockpitInventory | null, timeline: CockpitTimeline, running: CockpitLiveTurn | null): string {
  if (inventory === null) return 'checking…'
  if (inventory.mcp.length === 0) return 'none connected'
  const calls = new Map<string, number>()
  for (const round of rounds(timeline, running)) {
    for (const [tool, n] of Object.entries(round.tools)) {
      const server = inventory.mcp.find(s => tool.startsWith(s.prefix))
      if (server) calls.set(server.name, (calls.get(server.name) ?? 0) + count(n))
    }
  }
  const ordered = [...inventory.mcp]
    .sort((a, b) => (calls.get(b.name) ?? 0) - (calls.get(a.name) ?? 0))
    .map(server => {
      const n = calls.get(server.name) ?? 0
      return `${server.name}${n > 0 ? ' ×' + n : ''} (${server.tools} ${server.tools === 1 ? 'tool' : 'tools'})`
    })
  return `${inventory.mcp.length} connected · ${names(ordered, MAX_NAMES)}`
}
