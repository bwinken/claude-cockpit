// Pure helpers for what a turn did: each tool call and how it ended, the
// checks a shell command ran (tests, lint, types, build), the plan the model
// keeps, and what a subagent did. register.tsx feeds them tool.call results.

import type { CockpitAgentStats, CockpitCall, CockpitCheck, CockpitCheckKind, CockpitCheckRun, CockpitLiveTurn, CockpitPlanItem } from '../../types'
import { count, formatDuration, toolLabel } from './rounds'
import { program, segments } from './rules'
import { noteOf } from './timeline'

/** The most calls a turn keeps for its expanded row; its failures are counted past it. */
export const MAX_CALLS = 60
/** How much of a subject or an error line a call keeps. */
export const SUBJECT_KEPT = 160

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function cut(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= SUBJECT_KEPT ? line : line.slice(0, SUBJECT_KEPT - 1).trimEnd() + '…'
}

/** A path inside `root` as relative to it; any other as given. */
export function relativePath(path: string, root: string): string {
  if (root === '') return path
  const base = root.replace(/[\\/]+$/, '')
  if (path === base) return '.'
  return path.startsWith(base + '/') || path.startsWith(base + '\\') ? path.slice(base.length + 1) : path
}

/** What a call ran on, as its row lists it: a path, a command, a pattern, a description. */
export function subjectOfCall(tool: string, input: Record<string, unknown>, root = ''): string {
  const path = text(input.file_path) || text(input.notebook_path)
  if (path !== '') return cut(relativePath(path, root))
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return cut(text(input.command))
    case 'Grep': {
      const where = text(input.path)
      return cut(text(input.pattern) + (where === '' ? '' : ' in ' + relativePath(where, root)))
    }
    case 'Glob':
      return cut(text(input.pattern))
    case 'WebFetch':
      return cut(text(input.url))
    case 'WebSearch':
      return cut(text(input.query))
    case 'Agent':
    case 'Task':
      return cut(text(input.description))
    case 'Skill':
      return cut(text(input.skill))
    case 'ToolSearch':
      return cut(text(input.query))
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} ${input.todos.length === 1 ? 'item' : 'items'}` : ''
    case 'TaskCreate':
      return cut(text(input.subject))
    case 'TaskUpdate':
      return cut(['#' + text(input.taskId), text(input.status)].filter(part => part !== '' && part !== '#').join(' → '))
    default:
      return ''
  }
}

/**
 * The line of an error worth showing: tags stripped, and a bare `Exit code 2`
 * joined to the line after it, `Exit code 2: ls: cannot access 'x'`.
 */
export function errorLine(error: string): string {
  const lines = error
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const first = lines[0] ?? 'failed'
  return cut(/^Exit code \d+$/.test(first) && lines[1] !== undefined ? first + ': ' + lines[1] : first)
}

/** The call as a turn records it. */
export function callOf(
  tool: string,
  input: Record<string, unknown>,
  root: string,
  outcome: { error?: string; agentId?: string; checked?: CockpitCheckRun | null } = {},
): CockpitCall {
  const { error, agentId, checked } = outcome
  return {
    tool,
    subject: subjectOfCall(tool, input, root),
    ...(error !== undefined ? { error: errorLine(error) } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(checked ? { checked } : {}),
  }
}

/** `tests ✗`, `lint ✓ types ✓`: what a call checked, as its row shows it. */
export function describeChecked(run: CockpitCheckRun): string {
  return run.kinds.map(kind => kind + (run.isPassing ? ' ✓' : ' ✗')).join(' ')
}

/** `Read`, `github:get_issue`: a call's tool as its row shows it. */
export function callTool(call: CockpitCall): string {
  return toolLabel(call.tool)
}

// ── Checks ───────────────────────────────────────────────────────────────

const RUNNER = String.raw`(?:npm|pnpm|yarn|bun)(?: run)?`
const EXEC = String.raw`(?:(?:npx|bunx|pnpm exec|pnpm dlx|yarn dlx|uv run|poetry run|python3? -m) )?`
const PATTERNS: ReadonlyArray<[CockpitCheckKind, RegExp]> = [
  ['tests', new RegExp(String.raw`^${RUNNER} (?:test|tests|test:\S+)\b`)],
  ['tests', new RegExp(String.raw`^${EXEC}(?:jest|vitest|mocha|ava|pytest|tox|nox|rspec|phpunit|ctest|playwright test|cypress run)\b`)],
  ['tests', /^(?:go|cargo|deno|dotnet|mvn|mvnw|gradle|gradlew|swift|mix|bundle exec rspec|make|just) test\b/],
  ['tests', /^cargo nextest\b/],
  ['tests', /^claude plugin test\b/],
  ['lint', new RegExp(String.raw`^${RUNNER} (?:lint|lint:\S+)\b`)],
  ['lint', new RegExp(String.raw`^${EXEC}(?:eslint|oxlint|biome (?:check|lint|ci)|prettier --check|stylelint|ruff(?: check)?|flake8|pylint|black --check|golangci-lint|rubocop|shellcheck|markdownlint|hadolint)\b`)],
  ['lint', /^(?:cargo clippy|cargo fmt --check|gofmt -l|make lint|just lint)\b/],
  ['lint', /^claude plugin validate\b/],
  ['types', new RegExp(String.raw`^${RUNNER} (?:typecheck|type-check|types|tsc|check-types|check)\b`)],
  ['types', new RegExp(String.raw`^${EXEC}(?:tsc|vue-tsc|mypy|pyright|basedpyright)\b`)],
  ['types', /^(?:go vet|cargo check)\b/],
  ['build', new RegExp(String.raw`^${RUNNER} build\b`)],
  ['build', /^(?:cargo|go|dotnet|swift|zig) build\b/],
  ['build', /^(?:mvn|mvnw) (?:package|install|verify|compile)\b/],
  ['build', /^(?:gradle|gradlew) (?:build|assemble)\b/],
  ['build', /^(?:make|just|cmake --build|bazel build|vite build|next build|webpack|tsup|esbuild)\b/],
]

/** The checks a shell command runs, in the order first seen: `npm run lint && npm test` runs lint and tests. */
export function checkKinds(command: string): CockpitCheckKind[] {
  const kinds: CockpitCheckKind[] = []
  for (const words of segments(command)) {
    const line = program(words).join(' ').replace(/^(?:\.\/)/, '')
    const kind = PATTERNS.find(([, pattern]) => pattern.test(line))?.[0]
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/**
 * Whether a check failed: the shell reported an error (a non-zero exit), or
 * its output says so though a pipe hid the exit code (`npm test | tail`).
 */
export function checkFailed(kinds: readonly CockpitCheckKind[], isError: boolean, output: string): boolean {
  if (isError) return true
  const said = [
    /\b[1-9]\d* (?:fail|failed|failing|failures?)\b/i, // `2 failed`, `1 fail` (bun, claude plugin test)
    /^\s*FAIL\b/m, // jest, vitest
    /^# fail\s+[1-9]/m, // node --test, TAP summaries
    /^not ok \d+/m, // TAP
    /^--- FAIL\b/m, // go test
    /\btest result: FAILED\b/, // cargo test
  ]
  if (said.some(pattern => pattern.test(output))) return true
  const counted = kinds.includes('lint') || kinds.includes('types')
  return counted && (/\b[1-9]\d* errors?\b/i.test(output) || /\berror TS\d+:/.test(output))
}

/** What one shell command checked and whether it passed; null when it ran no check. */
export function checkRun(command: string, isError: boolean, output: string): CockpitCheckRun | null {
  const kinds = checkKinds(command)
  return kinds.length === 0 ? null : { kinds, isPassing: !checkFailed(kinds, isError, output) }
}

/** The checks with a command's run in place of the ones it ran before. */
export function recordChecks(
  checks: readonly CockpitCheck[],
  command: string,
  isError: boolean,
  output: string,
  at: number,
): CockpitCheck[] {
  const run = checkRun(command, isError, output)
  if (run === null) return [...checks]
  const { kinds, isPassing } = run
  const runs = kinds.map(kind => ({ kind, isPassing, command: cut(command), at }))
  return [...checks.filter(check => !kinds.includes(check.kind)), ...runs].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  )
}

const KIND_ORDER: readonly CockpitCheckKind[] = ['tests', 'lint', 'types', 'build']

/** `just now`, `45s ago`, `3m ago`, `2h ago`. */
export function formatAgo(ms: number): string {
  const seconds = Math.floor(count(ms) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return seconds + 's ago'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
  return Math.floor(seconds / 3600) + 'h ago'
}

// ── Plan ─────────────────────────────────────────────────────────────────

type Status = CockpitPlanItem['status']

function statusOf(value: unknown): Status | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
}

/** The plan TodoWrite sets: its whole list, in place of the last. */
export function planFromTodos(todos: unknown): CockpitPlanItem[] | null {
  if (!Array.isArray(todos)) return null
  const items: CockpitPlanItem[] = []
  for (const todo of todos) {
    const t = (todo ?? {}) as Record<string, unknown>
    const status = statusOf(t.status)
    if (status === null || text(t.content) === '') continue
    items.push({ text: cut(text(t.content)), ...(text(t.activeForm) ? { active: cut(text(t.activeForm)) } : {}), status })
  }
  return items
}

/** The plan after TaskCreate made a task (`result.task`), pending. */
export function planWithCreated(plan: readonly CockpitPlanItem[], result: unknown, input: Record<string, unknown>): CockpitPlanItem[] {
  const task = ((result ?? {}) as { task?: { id?: unknown; subject?: unknown } }).task
  const id = text(task?.id)
  if (id === '') return [...plan]
  const subject = text(task?.subject) || text(input.subject)
  const item: CockpitPlanItem = { id, text: cut(subject), ...(text(input.activeForm) ? { active: cut(text(input.activeForm)) } : {}), status: 'pending' }
  return [...plan.filter(entry => entry.id !== id), item]
}

/** The plan after TaskUpdate: a new status, subject or active form; `deleted` takes it out. */
export function planWithUpdate(plan: readonly CockpitPlanItem[], input: Record<string, unknown>): CockpitPlanItem[] {
  const id = text(input.taskId)
  if (input.status === 'deleted') return plan.filter(entry => entry.id !== id)
  const status = statusOf(input.status)
  return plan.map(entry =>
    entry.id !== id
      ? entry
      : {
          ...entry,
          ...(status !== null ? { status } : {}),
          ...(text(input.subject) ? { text: cut(text(input.subject)) } : {}),
          ...(text(input.activeForm) ? { active: cut(text(input.activeForm)) } : {}),
        },
  )
}

/** The plan as TaskList reports it, keeping the active forms already known. */
export function planFromTaskList(plan: readonly CockpitPlanItem[], result: unknown): CockpitPlanItem[] | null {
  const tasks = ((result ?? {}) as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) return null
  const items: CockpitPlanItem[] = []
  for (const task of tasks) {
    const t = (task ?? {}) as Record<string, unknown>
    const status = statusOf(t.status)
    if (status === null || text(t.id) === '') continue
    const known = plan.find(entry => entry.id === text(t.id))
    items.push({ id: text(t.id), text: cut(text(t.subject)), ...(known?.active ? { active: known.active } : {}), status })
  }
  return items
}

/** `3/6 · Running tests`, `6/6 done`. */
export function describePlan(plan: readonly CockpitPlanItem[]): string {
  const done = plan.filter(item => item.status === 'completed').length
  if (done === plan.length) return `${done}/${plan.length} done`
  const now = plan.find(item => item.status === 'in_progress')
  return `${done}/${plan.length}` + (now ? ' · ' + (now.active ?? now.text) : '')
}

/** The most cells the plan's bar draws; a longer plan draws to scale. */
export const PLAN_CELLS = 24

/** The plan's bar as runs of one status, each `cells` long: drawn left to right, done first. */
export function planBar(plan: readonly CockpitPlanItem[], cells = PLAN_CELLS): Array<{ status: Status; cells: number }> {
  if (plan.length === 0) return []
  const n = { completed: 0, in_progress: 0, pending: 0 }
  for (const item of plan) n[item.status] += 1
  let widths = n
  if (plan.length > cells) {
    // To scale, but a status that's there keeps at least one cell.
    const scaled = (k: number) => (k === 0 ? 0 : Math.max(1, Math.round((k / plan.length) * cells)))
    const done = scaled(n.completed)
    const now = scaled(n.in_progress)
    widths = { completed: done, in_progress: now, pending: Math.max(n.pending === 0 ? 0 : 1, cells - done - now) }
  }
  return (['completed', 'in_progress', 'pending'] as const).filter(status => widths[status] > 0).map(status => ({ status, cells: widths[status] }))
}

// ── Subagents ────────────────────────────────────────────────────────────

/** A subagent's calls and failures with one more call. */
export function addAgentCall(stats: Readonly<Record<string, CockpitAgentStats>>, agentId: string, failed: boolean): Record<string, CockpitAgentStats> {
  const seen = stats[agentId] ?? { calls: 0, failed: 0 }
  const next = { ...stats, [agentId]: { calls: seen.calls + 1, failed: seen.failed + (failed ? 1 : 0) } }
  // Keep the newest 200 agents.
  const ids = Object.keys(next)
  if (ids.length <= 200) return next
  return Object.fromEntries(ids.slice(-200).map(id => [id, next[id]!]))
}

/** What a notification's `<usage>` and `<task-id>` say: the agent, its calls and its time. */
export function noteUsage(text: string): { taskId?: string; calls?: number; durationMs?: number } {
  const tag = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(text)?.[1]
  const number = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined)
  const taskId = tag('task-id')
  const calls = number(tag('tool_uses'))
  const durationMs = number(tag('duration_ms'))
  return { ...(taskId ? { taskId } : {}), ...(calls !== undefined ? { calls } : {}), ...(durationMs !== undefined ? { durationMs } : {}) }
}

/** `3 calls · 2.1s · ✗ 1`: a subagent's work, from what is known of it. */
export function describeAgent(calls: number | undefined, durationMs: number | undefined, failed: number): string {
  const parts: string[] = []
  if (calls !== undefined) parts.push(calls === 0 ? 'no calls' : `${calls} ${calls === 1 ? 'call' : 'calls'}`)
  if (durationMs !== undefined) parts.push(formatDuration(durationMs))
  if (failed > 0) parts.push('✗ ' + failed)
  return parts.join(' · ')
}

/** A notification's line: its summary, then what the subagent did, `Agent "x" finished · 3 calls · 2.1s · ✗ 1`. */
export function noteLabel(text: string, stats: Readonly<Record<string, CockpitAgentStats>>): string | null {
  const summary = noteOf(text)
  if (summary === null) return null
  const usage = noteUsage(text)
  const seen = usage.taskId === undefined ? undefined : stats[usage.taskId]
  const detail = describeAgent(usage.calls ?? seen?.calls, usage.durationMs, seen?.failed ?? 0)
  return detail === '' ? summary : summary + ' · ' + detail
}

/** The running turn with one more call: kept up to MAX_CALLS, its failures counted past it. */
export function addCall(live: CockpitLiveTurn | null, call: CockpitCall): CockpitLiveTurn | null {
  if (live === null) return null
  const calls = live.calls ?? []
  return {
    ...live,
    ...(calls.length < MAX_CALLS ? { calls: [...calls, call] } : {}),
    failed: count(live.failed) + (call.error !== undefined ? 1 : 0),
  }
}
