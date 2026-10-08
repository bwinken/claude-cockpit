import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  addAgentCall,
  addCall,
  callOf,
  checkRun,
  noteLabel,
  planFromTaskList,
  planFromTodos,
  planWithCreated,
  planWithUpdate,
  recordChecks,
} from './lib/activity'
import { appendAudit, auditLine } from './lib/audit'
import type { AuditEntry } from './lib/audit'
import { stubClassifier } from './lib/classifier'
import { readConfig } from './lib/config'
import { diffSnapshots, snapshot } from './lib/git'
import type { GitRun, StatFile } from './lib/git'
import { beginStep, count, endStep, skillsOf, spinnerText, startTurn, summarize, withStreaming } from './lib/rounds'
import {
  addRow,
  addSteer,
  addUsage,
  describeMcp,
  describeSkills,
  foldCompacted,
  inventoryFrom,
  inventoryFromTools,
  NOTE_MARK,
  noteOf,
  oneLine,
  PROMPT_KEPT,
  promptOf,
  readSteer,
  startQueued,
} from './lib/timeline'
import {
  allowedBy,
  argsOf,
  checkCall,
  combineRules,
  defaultWritableRoots,
  FILE_TOOLS,
  isInside,
  NO_RULES,
  normalizePath,
  outsideProjectVerdict,
  parseRules,
  resolvePath,
  subjectOf,
} from './lib/rules'
import type { GuardRules, RulesFile, Verdict } from './lib/rules'
import { isOlder, MIN_CLAUDE_CODE } from './lib/version'
import { editsBandTree } from './ui/edits'
import { timelineTree } from './ui/timeline'

// Every $.state value cockpit keeps, declared in types/index.d.ts.
export const live = atom({ plugin: 'cockpit', key: 'live' } as const, null)
export const turnLines = atom({ plugin: 'cockpit', key: 'turnLines' } as const, [])
export const timeline = atom({ plugin: 'cockpit', key: 'timeline' } as const, { compacted: [], rows: [] })
export const queued = atom({ plugin: 'cockpit', key: 'queued' } as const, [])
/** The summaries of background tasks' notifications submitted since the last turn started. */
const notes = atom({ plugin: 'cockpit', key: 'notes' } as const, [])
/** The turn whose calls the pane lists under it, by id; null for none. */
const expandedTurn = atom({ plugin: 'cockpit', key: 'expandedTurn' } as const, null)
export const checks = atom({ plugin: 'cockpit', key: 'checks' } as const, [])
export const plan = atom({ plugin: 'cockpit', key: 'plan' } as const, [])
const planExpanded = atom({ plugin: 'cockpit', key: 'planExpanded' } as const, false)
const agentStats = atom({ plugin: 'cockpit', key: 'agentStats' } as const, {})
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)
const inventory = atom({ plugin: 'cockpit', key: 'inventory' } as const, null)
const autoBlocks = atom({ plugin: 'cockpit', key: 'autoBlocks' } as const, {})
const approvals = atom({ plugin: 'cockpit', key: 'approvals' } as const, [])
const addedDirs = atom({ plugin: 'cockpit', key: 'addedDirs' } as const, [])
export const lastEdits = atom({ plugin: 'cockpit', key: 'lastEdits' } as const, null)
export const editsExpanded = atom({ plugin: 'cockpit', key: 'editsExpanded' } as const, false)
export const editsDismissed = atom({ plugin: 'cockpit', key: 'editsDismissed' } as const, false)

/** The most prompts the pane shows as queued. */
const MAX_QUEUED = 5
/** The most notification summaries kept for the turn that runs them. */
const MAX_NOTES = 100

/** The session's root, to show paths inside it as relative; '' when there is none. */
async function rootOf($: EngineInterface): Promise<string> {
  try {
    return await $.session.root()
  } catch {
    return ''
  }
}

/**
 * One tool call as the timeline keeps it: on the running turn (the main loop's)
 * or in its subagent's counts, as a check's run when it ran one, and in the
 * plan when it changed it.
 */
async function recordCall($: EngineInterface, e: Readonly<Record<string, unknown>> & { tool: string; agentId?: string }, answer: unknown): Promise<void> {
  const a = (answer ?? {}) as { deny?: string; isError?: true; text?: string; result?: unknown }
  const input = argsOf(e)
  const error = a.deny !== undefined ? a.deny : a.isError ? a.text ?? (typeof a.result === 'string' ? a.result : 'failed') : undefined
  const isFailed = error !== undefined
  // A shell command that ran tests, lint, a type-check or a build: its outcome is a check's.
  const isShell = (e.tool === 'Bash' || e.tool === 'PowerShell') && typeof input.command === 'string'
  const checked = isShell && input.run_in_background !== true && a.deny === undefined ? checkRun(String(input.command), a.isError === true, a.text ?? '') : null
  if (e.agentId !== undefined) {
    const agentId = e.agentId
    await update($, agentStats, current => addAgentCall(current, agentId, isFailed))
  } else {
    const started = e.tool === 'Agent' && !isFailed ? (a.result as { agentId?: unknown } | undefined)?.agentId : undefined
    const call = callOf(e.tool, input, await rootOf($), { error, agentId: typeof started === 'string' ? started : undefined, checked })
    await update($, live, turn => addCall(turn, call))
  }
  if (checked !== null) {
    const command = String(input.command)
    const at = await $.clock.now()
    await update($, checks, current => recordChecks(current, command, a.isError === true, a.text ?? '', at))
  }
  if (isFailed) return
  if (e.tool === 'TodoWrite') {
    const items = planFromTodos(input.todos)
    if (items !== null) await update($, plan, () => items)
  } else if (e.tool === 'TaskCreate') {
    await update($, plan, current => planWithCreated(current, a.result, input))
  } else if (e.tool === 'TaskUpdate') {
    await update($, plan, current => planWithUpdate(current, input))
  } else if (e.tool === 'TaskList') {
    const items = planFromTaskList(await read($, plan), a.result)
    if (items !== null) await update($, plan, () => items)
  }
}

/** The answer a tool.call hook returns, recorded on the timeline first when it's one of the model's calls. */
async function observed<T>(
  $: EngineInterface,
  e: Readonly<Record<string, unknown>> & { tool: string; agentId?: string; tool_use_id?: string },
  answer: T,
  isRecorded: boolean,
): Promise<T> {
  if (isRecorded && e.tool_use_id !== undefined) await recordCall($, e, answer)
  return answer
}

/** Whether a prompt came from the person: typed, through Remote Control, or the SDK host's. */
function isPerson(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

/** The timeline pane, opened by /cockpit. */
const PANE_ID = 'cockpit-timeline'
const PANE_TITLE = 'Cockpit timeline'

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

/**
 * Re-reads the skills listed for the model and the connected MCP servers.
 * The breakdown is counted locally (`summary`, no request is sent); where
 * there is none, the tool list gives the servers and no skills.
 */
async function refreshInventory($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const breakdown = usage.context.breakdown
    if (breakdown !== undefined) {
      const found = inventoryFrom(breakdown.skills?.skillFrontmatter, breakdown.mcpTools)
      await update($, inventory, () => found)
      return
    }
  } catch {
    // Fall through to the tool list.
  }
  try {
    const found = inventoryFromTools(await $.tool.list())
    await update($, inventory, () => found)
  } catch {
    // Nothing to read: the overview keeps what it had.
  }
}

/** The guard's rules and the directories writes may go to, read once per load. */
type GuardContext = { rules: GuardRules; home: string | undefined; writable: string[]; problems: string[] }

/** How long a noted auto-mode block waits for its call to come back refused. */
const AUTO_BLOCK_MS = 5 * 60_000

/** How long an approval after an auto-mode block stays good for its one retry. */
const APPROVAL_MS = 5 * 60_000

/** The labels of the question asked when auto mode blocks a call. */
const RUN_ONCE = 'Run it once'
const KEEP_BLOCKED = 'Keep it blocked'

/** How much of a call's arguments the question shows. */
const ASK_ARGS_SHOWN = 4000

let guardContext: Promise<GuardContext> | null = null

/**
 * Reads the rules files: the user's own (any rule) and the project's
 * `.claude/cockpit-rules.json` (deny rules only), plus the directories the
 * file tools may write to: the temp directories, Claude Code's plans and
 * memory, the settings' additionalDirectories and the rules file's own.
 */
async function loadGuard($: EngineInterface, rulesFile: string, disabledByConfig: readonly string[]): Promise<GuardContext> {
  const problems: string[] = []
  let home: string | undefined
  let tmp: (string | undefined)[] = []
  let configDir: string | undefined
  try {
    home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    tmp = [await $.env.get('TMPDIR'), await $.env.get('TEMP'), await $.env.get('TMP')]
    configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  } catch {
    // No environment to read: the defaults below go without them.
  }
  if (home !== undefined) home = normalizePath(home, undefined)
  const files: RulesFile[] = []
  const readFile = async (path: string, isUserFile: boolean) => {
    let text: string
    try {
      if (!(await $.fs.exists(path))) return
      text = await $.fs.read(path)
    } catch {
      return
    }
    const parsed = parseRules(text, isUserFile)
    if (parsed.problem) problems.push(`${path}: ${parsed.problem}; its rules are ignored`)
    else files.push(parsed.rules)
  }
  if (rulesFile.trim() !== '') await readFile(normalizePath(rulesFile.trim(), home), true)
  try {
    await readFile((await $.session.root()) + '/.claude/cockpit-rules.json', false)
  } catch {
    // No project root: no project rules.
  }
  const rules = combineRules(files, disabledByConfig)
  let fromSettings: string[] = []
  try {
    const settings = (await $.settings.read()) as { permissions?: { additionalDirectories?: unknown } }
    const dirs = settings.permissions?.additionalDirectories
    if (Array.isArray(dirs)) fromSettings = dirs.filter((dir): dir is string => typeof dir === 'string')
  } catch {
    // No settings to read.
  }
  const writable = [
    ...defaultWritableRoots(home, tmp, configDir),
    ...[...rules.writableRoots, ...fromSettings].map(dir => normalizePath(dir, home)),
  ]
  return { rules, home, writable, problems }
}

/** The guard's context, loaded at session start or on the first call that needs it. */
function guardOf($: EngineInterface, rulesFile: string, disabledByConfig: readonly string[]): Promise<GuardContext> {
  guardContext ??= loadGuard($, rulesFile, disabledByConfig)
  return guardContext
}

/** The real path of `path`, links resolved; for a file not yet written, its directory's real path joined with its name. */
async function realPathOf($: EngineInterface, path: string): Promise<string> {
  try {
    return normalizePath((await $.fs.stat(path, { resolve: true })).realPath ?? path, undefined)
  } catch {
    const slash = path.lastIndexOf('/')
    if (slash <= 0) return path
    try {
      const dir = (await $.fs.stat(path.slice(0, slash), { resolve: true })).realPath
      return dir ? normalizePath(dir, undefined) + path.slice(slash) : path
    } catch {
      return path
    }
  }
}

/** The write-outside-project verdict for a file tool's call, or null when its path is inside a writable root. */
async function writeVerdict($: EngineInterface, tool: string, args: Record<string, unknown>, context: GuardContext): Promise<Verdict | null> {
  if (context.rules.disabled.has('write-outside-project')) return null
  const field = FILE_TOOLS[tool]
  const raw = field === undefined ? undefined : args[field]
  if (typeof raw !== 'string' || raw === '') return null
  const root = await realPathOf($, normalizePath(await $.session.root(), context.home))
  const target = await realPathOf($, resolvePath(root, normalizePath(raw, context.home)))
  const added = (await read($, addedDirs)).map(dir => normalizePath(dir, context.home))
  const roots = [root, ...context.writable, ...added]
  return roots.some(dir => isInside(target, dir)) ? null : outsideProjectVerdict(raw, root)
}

/** Logs one decision in the transcript and appends it to the audit trail in $.store. */
async function recordDecision($: EngineInterface, entry: Omit<AuditEntry, 'at' | 'session'>): Promise<void> {
  let session = ''
  let at = 0
  try {
    session = await $.session.id()
    at = await $.clock.now()
  } catch {
    // Stamped as unknown.
  }
  const full: AuditEntry = { ...entry, subject: entry.subject.slice(0, 300), at, session }
  $.ui.log(auditLine(full))
  try {
    const trail = await $.store.get('audit')
    await $.store.set('audit', appendAudit(trail, full))
  } catch {
    // The transcript line stands; the trail misses this one.
  }
}

/** True for a tool call's result that says it didn't run: refused, or answered as an error. */
function isRefused(result: { deny?: string; isError?: true }): boolean {
  return typeof result.deny === 'string' || result.isError === true
}

/** A file's size and time through `$.fs.stat`, for the snapshots' large-file check. */
function statOf($: EngineInterface): StatFile {
  return async path => {
    try {
      const { size, mtimeMs } = await $.fs.stat(path)
      return { size, mtimeMs }
    } catch {
      return null
    }
  }
}

/** git through `$.process.run`, taking no optional lock so it never blocks the person's own git. */
function gitOf($: EngineInterface): GitRun {
  return (args, options) =>
    $.process.run(['git', ...args], {
      cwd: options?.cwd,
      stdin: options?.stdin,
      env: { GIT_OPTIONAL_LOCKS: '0' },
      timeoutMs: 15_000,
    })
}

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const tracksTurns = config.roundTrace || config.timeline || config.editedFiles

  on('session.start', async ($, e, next) => {
    if (config.gate) {
      guardContext = null
      for (const problem of (await guardOf($, config.gateRulesFile, config.gateDisabledRules)).problems) $.ui.log('cockpit rules file ' + problem)
    }
    try {
      const { version, base } = await $.session.version()
      if (isOlder(base ?? version)) {
        $.ui.toast(`cockpit needs Claude Code ${MIN_CLAUDE_CODE} or later; this is ${version}. Some parts may not work.`)
      }
    } catch {
      // No version to compare against: carry on.
    }
    if (config.timeline) {
      // The pane's running time moves to the minute: a tick every 30s redraws it, and nothing else.
      $.clock.every(30_000, () => void update($, tick, n => (n + 1) % 1_000_000))
      await $.command.register({
        name: 'cockpit',
        description: 'Open the cockpit timeline pane (/cockpit close closes it)',
        argumentHint: '[close]',
      })
      await refreshInventory($)
      // Unasked, the engine seats it only on a wide enough terminal; below that it waits.
      if (config.timelineAutoOpen) await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    }
    return next(e)
  })

  if (tracksTurns) {
    // turn.start fires for the main loop only; a subagent's run raises none.
    on('turn.start', async ($, e, next) => {
      let submitted: readonly string[] = []
      if (config.timeline) {
        // Notifications a turn ended without reading run with this one, if it's a notification's.
        const late = noteOf(e.text) === null ? [] : (await read($, queued)).filter(entry => entry.text.startsWith(NOTE_MARK))
        await update($, queued, current => (current.length === 0 ? current : startQueued(current, e.text)))
        submitted = [...late.map(entry => entry.text.slice(NOTE_MARK.length)), ...(await read($, notes))]
        await update($, notes, current => (current.length === 0 ? current : []))
      }
      const label = noteOf(e.text) === null ? undefined : noteLabel(e.text, await read($, agentStats)) ?? undefined
      const { prompt, isNotification } = promptOf(e.text, submitted, label)
      await update($, live, () => ({ ...startTurn(e.turnId, oneLine(prompt, PROMPT_KEPT)), ...(isNotification ? { isNotification: true as const } : {}) }))
      if (config.editedFiles) {
        const git = await snapshot(gitOf($), statOf($))
        await update($, live, turn => (turn !== null && turn.turnId === e.turnId ? { ...turn, git } : turn))
      }
      return next(e)
    })

    // A prompt the user types while a turn runs, or a subagent's notification
    // that arrives then, waits on that turn. The model reads it within the turn
    // as a delivery (no turn.start of its own); one the turn ended without
    // reading is queued and runs as a turn later.
    if (config.timeline) {
      on('prompt.submit', async ($, e, next) => {
        const entered = await next(e)
        if (entered.drop !== undefined) return entered
        if (e.turnId !== undefined && isPerson(e.origin.kind)) {
          const turnId = e.turnId
          await update($, live, turn => addSteer(turn, turnId, oneLine(entered.text, PROMPT_KEPT)))
        }
        const note = e.origin.kind === 'task-notification' ? noteLabel(entered.text, await read($, agentStats)) : null
        if (note !== null && e.turnId !== undefined) {
          // A subagent finishing while a turn runs: delivered into it, as a typed prompt is.
          const turnId = e.turnId
          await update($, live, turn => addSteer(turn, turnId, NOTE_MARK + oneLine(note, PROMPT_KEPT)))
        } else if (note !== null) {
          // Several finishing close together run as one turn: count each.
          await update($, notes, current => [...current, oneLine(note, PROMPT_KEPT)].slice(-MAX_NOTES))
        }
        return entered
      })

      on('session.append', { door: 'delivery' }, async ($, e, next) => {
        const stored = await next(e)
        if (e.agentId === undefined && e.message.name === 'queued_command' && (isPerson(e.origin.kind) || e.origin.kind === 'task-notification')) {
          const text = e.message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
          await update($, live, turn => readSteer(turn, text))
        }
        return stored
      })
    }

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
      const skills = skillsOf(result.toolUses)
      await update($, live, turn => {
        const ended = endStep(turn, e.turnId, names, skills)
        return { ...ended, tokens: addUsage(ended.tokens, result.usage) }
      })
      return result
    })

    on('turn.complete', async ($, e, next) => {
      const answered = await next(e)
      if (e.agentId !== undefined) return answered

      const turn = await read($, live)
      await update($, live, () => null)
      if (turn === null || turn.turnId !== e.turnId) return answered

      let reply = answered
      if (config.roundTrace) {
        const line = summarize(turn.rounds, e.durationMs, config.roundTraceMaxTools, e.isAborted)
        if (line !== undefined) {
          const short = summarize(turn.rounds, undefined, config.roundTraceMaxTools, e.isAborted) ?? line
          const entry = { durationMs: e.durationMs, text: short }
          await update($, turnLines, lines => [...lines, entry].slice(-KEPT_TURN_LINES))
          if (!(await isTerminalOnly($))) {
            // Keep a line another mod beneath already put under the answer.
            const theirs = answered.text !== e.answer && answered.text !== '' ? answered.text + ' · ' : ''
            reply = { ...answered, text: theirs + line }
          }
        }
      }

      let edits = null
      if (config.editedFiles && turn.git) {
        const run = gitOf($)
        const now = await snapshot(run, statOf($))
        edits = now === null ? null : await diffSnapshots(run, turn.git, now)
        const shown = edits !== null && edits.files.length > 0 ? edits : null
        await update($, lastEdits, () => shown)
        await update($, editsExpanded, () => false)
        await update($, editsDismissed, () => false)
      }

      if (config.timeline) {
        const row = {
          turnId: turn.turnId,
          prompt: turn.prompt,
          rounds: turn.rounds,
          tokens: turn.tokens,
          durationMs: e.durationMs,
          isAborted: e.isAborted,
          edits,
          ...(turn.isNotification ? { isNotification: true as const } : {}),
          ...(turn.steers !== undefined && turn.steers.length > 0 ? { steers: turn.steers } : {}),
          ...(turn.calls !== undefined && turn.calls.length > 0 ? { calls: turn.calls } : {}),
          ...(count(turn.failed) > 0 ? { failed: count(turn.failed) } : {}),
        }
        await update($, timeline, current => addRow(current, row))
        const unread = turn.waiting ?? []
        if (unread.length > 0) await update($, queued, current => [...current, ...unread.map(text => ({ text, passed: 0 }))].slice(-MAX_QUEUED))
        // MCP servers connect and skills load as the session goes: look again after each turn.
        await refreshInventory($)
      }
      return reply
    })
  }

  if (config.roundTrace) {
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

  if (config.timeline) {
    on('command.run', { command: 'cockpit' }, async ($, e) => {
      if (e.args.trim() === 'close') {
        await $.ui.close({ id: PANE_ID })
        return {}
      }
      // Opened because the person asked: it seats at any width.
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      await refreshInventory($)
      return {}
    })

    on('ui.render', { component: 'Pane', requestId: 'cockpit-timeline' }, async ($, e) => {
      // Reading the tick redraws the pane each time it moves, so the running time keeps up.
      await read($, tick)
      let elapsedMs: number | undefined
      let context: { tokens?: number; window?: number; percent?: number } | undefined
      try {
        const usage = await $.session.usage()
        elapsedMs = (await $.clock.now()) - usage.startedAt
        context = usage.context
      } catch {
        // No usage to read: the overview leaves those two out.
      }
      const turns = await read($, timeline)
      const running = await read($, live)
      const onHand = await read($, inventory)
      const waiting = await read($, queued)
      let now: number | undefined
      try {
        now = await $.clock.now()
      } catch {
        // No clock: the checks show without their age.
      }
      return timelineTree($.ui.resolve(e), {
        timeline: turns,
        running,
        queued: waiting.map(entry => entry.text),
        checks: await read($, checks),
        plan: await read($, plan),
        isPlanExpanded: await read($, planExpanded),
        expandedTurn: await read($, expandedTurn),
        agentStats: await read($, agentStats),
        now,
        onToggleTurn: (turnId: string) => update($, expandedTurn, current => (current === turnId ? null : turnId)),
        onTogglePlan: () => update($, planExpanded, shown => !shown),
        skills: describeSkills(onHand, turns, running),
        mcp: describeMcp(onHand, turns, running),
        columns: e.props.bodyColumns,
        maxTools: config.roundTraceMaxTools,
        elapsedMs,
        context,
      })
    })

    // /clear, /resume and /branch reset $.state, the inventory with it: read it again.
    on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
      await refreshInventory($)
      return next(e)
    })

    // A compaction keeps $.state: fold this segment's turns, then count afresh.
    on('classic.SessionStart', { source: 'compact' }, async ($, e, next) => {
      await update($, timeline, current => foldCompacted(current))
      return next(e)
    })
  }

  if (config.editedFiles) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      // Keep what the mods beneath draw in the band: cockpit's rows go under it.
      const theirs = await next(e)
      // Yield to a survey, stay out of the way while a turn runs or a subagent is in view.
      if (e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) return theirs
      const edits = await read($, lastEdits)
      if (edits === null || edits.files.length === 0 || (await read($, editsDismissed))) return theirs
      return editsBandTree(
        $.ui.resolve(e),
        {
          edits,
          isExpanded: await read($, editsExpanded),
          columns: e.props.bodyColumns,
          onToggle: () => update($, editsExpanded, shown => !shown),
          onDismiss: () => update($, editsDismissed, () => true),
        },
        theirs,
      )
    })
  }

  // One tool.call hook for both, as a module may register only one without a matcher.
  // The guard: the deterministic layer, then the classifier seam, then the call;
  // and when auto mode blocked it, the one question this guard ever asks. The
  // timeline: every answer the hook returns is recorded on its way out.
  if (config.gate || config.timeline) {
    on('tool.call', async ($, e, next) => {
      // The model's own calls, by any loop; not another plugin's $.tool.call.
      const isRecorded = config.timeline && next.origin.plugin === 'engine'
      if (!config.gate) return observed($, e, await next(e), isRecorded)
      const guard = await guardOf($, config.gateRulesFile, config.gateDisabledRules)
      const args = argsOf(e)
      const subject = subjectOf(e.tool, args)
      const verdict = checkCall(e.tool, args, guard.rules) ?? (await writeVerdict($, e.tool, args, guard))
      if (verdict !== null) {
        await recordDecision($, { tool: e.tool, decision: 'deny', rule: verdict.rule, subject, reason: verdict.reason })
        return observed($, e, { deny: 'cockpit blocked this call: ' + verdict.reason }, isRecorded)
      }
      const running = await read($, live)
      const opinion = await stubClassifier({ tool: e.tool, input: args, lastPrompt: running?.prompt ?? '' })
      if (opinion.decision === 'deny') {
        const reason = opinion.reason ?? 'the classifier refused it'
        await recordDecision($, { tool: e.tool, decision: 'deny', rule: 'classifier', subject, reason })
        return observed($, e, { deny: 'cockpit blocked this call: ' + reason + '. Find another way, or ask the user.' }, isRecorded)
      }

      const result = await next(e)
      if (!config.gateAutoModePrompt || !isRefused(result) || e.tool_use_id === undefined) return observed($, e, result, isRecorded)
      // The block auto mode noted for this call: by its id, or else by its tool and subject.
      // A block older than AUTO_BLOCK_MS belongs to some other, earlier call: ignored.
      const checkedAt = await $.clock.now()
      const blocks = Object.entries(await read($, autoBlocks)).filter(([, b]) => checkedAt - (b.at ?? 0) < AUTO_BLOCK_MS)
      const found =
        blocks.find(([key]) => key === e.tool_use_id) ??
        [...blocks]
          .reverse()
          .find(([, b]) => b.tool === e.tool && b.subject === subject)
      if (found === undefined) return observed($, e, result, isRecorded)
      const [blockKey, block] = found
      const id = e.tool_use_id
      await update($, autoBlocks, all =>
        Object.fromEntries(Object.entries(all).filter(([key, b]) => key !== blockKey && checkedAt - (b.at ?? 0) < AUTO_BLOCK_MS)),
      )

      const shown = JSON.stringify(args, null, 2)
      const question =
        `Auto mode blocked a ${e.tool} call` +
        (e.agentId === undefined ? '' : ` from a subagent (${e.agentId})`) +
        `.\nReason: ${block.reason}\n\n${e.tool} arguments:\n` +
        (shown.length > ASK_ARGS_SHOWN ? shown.slice(0, ASK_ARGS_SHOWN) + `\n… (${shown.length - ASK_ARGS_SHOWN} more characters)` : shown) +
        '\n\nRun it once anyway?'
      let answer = KEEP_BLOCKED
      try {
        // The wait is inside $.ui.ask, so it costs this hook none of its time.
        answer = await $.ui.ask(question, { options: [RUN_ONCE, KEEP_BLOCKED], header: 'Auto mode' })
      } catch {
        // Dismissed, "Chat about this", or nobody to ask (claude -p): it stays blocked.
      }
      if (answer !== RUN_ONCE) {
        await recordDecision($, { tool: e.tool, decision: 'kept-auto-block', rule: 'auto-mode', subject, reason: block.reason })
        return observed($, e, result, isRecorded)
      }
      const now = await $.clock.now()
      await update($, approvals, list => [...list.filter(a => now - a.at < APPROVAL_MS), { toolUseId: id, tool: e.tool, subject, at: now }])
      await recordDecision($, { tool: e.tool, decision: 'approved-after-auto-block', rule: 'auto-mode', subject, reason: block.reason })
      // Run it again: this time cockpit's tool.check answers allow, so the classifier isn't asked.
      // The approval lasts exactly this one run.
      try {
        return observed($, e, await next(e), isRecorded)
      } finally {
        await update($, approvals, list => list.filter(a => a.toolUseId !== id))
      }
    }).catch(($, e, next) => {
      // With the guard off this hook only records: whatever happened, the call goes on.
      if (!config.gate) return next(e)
      if (next.error.kind === 're-entry') {
        // Asked beneath this hook's own call: judge from the event alone, no $ call,
        // with every built-in rule on (the rules file can't be read here).
        const verdict = checkCall(e.tool, argsOf(e), NO_RULES)
        return verdict === null ? next(e) : { deny: 'cockpit blocked this call: ' + verdict.reason }
      }
      if (next.called) return next(e)
      try {
        $.ui.log(`guard failed (${next.error.kind}) on ${e.tool}; the call was not run`)
      } catch {
        // The deny below stands without the line.
      }
      return {
        deny:
          `cockpit's tool guard failed (${next.error.kind}) while checking this call, so it was not run. ` +
          'Try the call again; if this keeps happening, tell the user the cockpit guard is failing.',
      }
    })
  }

  if (config.gate) {
    // Runs after the rules, the mode and the settings hooks have decided: let
    // through one call the user approved after an auto-mode block, and calls
    // an allow rule in the user's own rules file names. Never loosens a deny.
    on('tool.check', async ($, e, next) => {
      const decided = await next(e)
      if (decided.decision === 'deny') return decided
      const input = (e.input !== null && typeof e.input === 'object' ? e.input : {}) as Record<string, unknown>
      const subject = subjectOf(e.tool, input)
      const now = await $.clock.now()
      const approved = (await read($, approvals)).find(
        a => now - a.at < APPROVAL_MS && (a.toolUseId === e.tool_use_id || (a.tool === e.tool && a.subject === subject)),
      )
      if (approved !== undefined) {
        // The guard removes the approval once its one re-run is done.
        return { decision: 'allow', reason: 'the user approved this call after auto mode blocked it' }
      }
      if (decided.decision !== 'ask') return decided
      const rule = allowedBy(e.tool, input, (await guardOf($, config.gateRulesFile, config.gateDisabledRules)).rules)
      if (rule === undefined) return decided
      if (e.tool_use_id !== undefined) await recordDecision($, { tool: e.tool, decision: 'allow', rule: rule.id, subject })
      return { decision: 'allow', reason: `allowed by the rule ${rule.id} in the cockpit rules file` }
    })

    if (config.gateAutoModePrompt) {
      // Fires when the auto mode classifier denies a call, before the call's
      // tool.call chain hears it was refused: note it for the guard above.
      on('classic.PermissionDenied', async ($, e, next) => {
        const input = (e.tool_input !== null && typeof e.tool_input === 'object' ? e.tool_input : {}) as Record<string, unknown>
        const block = { tool: e.tool_name, reason: e.reason, subject: subjectOf(e.tool_name, input), at: await $.clock.now() }
        await update($, autoBlocks, blocks => Object.fromEntries([...Object.entries(blocks).slice(-19), [e.tool_use_id, block]]))
        return next(e)
      })
    }

    // A directory added mid-session with /add-dir is writable too.
    on('classic.DirectoryAdded', async ($, e, next) => {
      await update($, addedDirs, dirs => (dirs.includes(e.directory) ? dirs : [...dirs, e.directory]))
      return next(e)
    })
  }
}
