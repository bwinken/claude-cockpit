// Pure helpers for the timeline pane and the edited-files band.

import type {
  CockpitEdits,
  CockpitInventory,
  CockpitLiveTurn,
  CockpitMcpServer,
  CockpitQueued,
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

/** Whether a code point takes two terminal columns: CJK, Hangul, fullwidth forms, most emoji. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** Whether a code point takes no column: combining marks, zero-width spaces and joiners, variation selectors. */
function isZeroWidth(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1
}

/** How many terminal columns a text takes: `修正 bug` is 8. */
export function textWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/**
 * One line of a text that fits `max` columns, cut with `…`: like oneLine,
 * but a CJK character counts as the two columns it takes.
 */
export function fitWidth(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const room = Math.max(1, count(max))
  if (textWidth(line) <= room) return line
  let out = ''
  let width = 0
  for (const char of line) {
    const w = charWidth(char)
    if (width + w > room - 1) break
    out += char
    width += w
  }
  return out.trimEnd() + '…'
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

/** The running turn with a prompt the user typed over it, not read yet. */
export function addSteer(live: CockpitLiveTurn | null, turnId: string, text: string): CockpitLiveTurn | null {
  if (live === null || live.turnId !== turnId || text === '') return live
  return { ...live, waiting: [...(live.waiting ?? []), text] }
}

/** What marks a background task's notification among a turn's prompts. */
export const NOTE_MARK = '⚙ '

/** Whether `text` holds `prompt`, as cut to one line (a trailing `…` and a NOTE_MARK ignored). */
function holds(text: string, prompt: string): boolean {
  const bare = (prompt.startsWith(NOTE_MARK) ? prompt.slice(NOTE_MARK.length) : prompt).replace(/…$/, '')
  return oneLine(text, Number.MAX_SAFE_INTEGER).includes(bare)
}

/**
 * The running turn once the model is handed a prompt typed over it, or a
 * notification delivered into it (`text` is the delivery as the model reads
 * it): that one, or the oldest waiting of its kind when none matches, moves
 * from waiting to read.
 */
export function readSteer(live: CockpitLiveTurn | null, text: string): CockpitLiveTurn | null {
  const waiting = live?.waiting ?? []
  if (live === null || waiting.length === 0) return live
  const isNote = text.includes('<task-notification>')
  const found = waiting.findIndex(prompt => holds(text, prompt))
  const at = found >= 0 ? found : waiting.findIndex(prompt => prompt.startsWith(NOTE_MARK) === isNote)
  if (at < 0) return live
  return { ...live, steers: [...(live.steers ?? []), waiting[at]!], waiting: waiting.filter((_, i) => i !== at) }
}

/** How many turns a queued prompt may see start before it's let go. */
export const QUEUED_TURNS = 3

/**
 * The queued prompts as a turn starts: the ones the turn runs leave (every
 * queued notification, when a notification starts it: the engine runs them
 * together), the rest count the turn, and one that has seen QUEUED_TURNS go
 * by is let go.
 */
export function startQueued(queued: readonly CockpitQueued[], prompt: string): CockpitQueued[] {
  const isNote = noteOf(prompt) !== null
  return queued
    .filter(entry => !holds(prompt, entry.text) && !(isNote && entry.text.startsWith(NOTE_MARK)))
    .map(entry => ({ ...entry, passed: entry.passed + 1 }))
    .filter(entry => entry.passed < QUEUED_TURNS)
}

/** A background task's notification as its summary (`Agent "x" finished`); null for any other prompt. */
export function noteOf(text: string): string | null {
  if (!text.trimStart().startsWith('<task-notification>')) return null
  return /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() || 'Background task finished'
}

/**
 * The prompt a turn shows. A turn background tasks' notifications start (a
 * subagent finishing) reads as the first one's summary, and `+n more` when
 * the engine ran several as one turn: `notes`, as each was submitted.
 */
export function promptOf(text: string, notes: readonly string[] = []): { prompt: string; isNotification: boolean } {
  const own = noteOf(text)
  if (own === null) return { prompt: text, isNotification: false }
  const all = notes.length > 0 ? notes : [own]
  const count = Math.max(all.length, (text.match(/<task-notification>/g) ?? []).length)
  return { prompt: all[0]! + (count > 1 ? ` +${count - 1} more` : ''), isNotification: true }
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
