import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  addAgentCall,
  addCall,
  checkFailed,
  checkKinds,
  describeAgent,
  describePlan,
  errorLine,
  MAX_CALLS,
  noteLabel,
  noteUsage,
  planBar,
  planFromTaskList,
  planFromTodos,
  planWithCreated,
  planWithUpdate,
  recordChecks,
  relativePath,
  subjectOfCall,
} from '../hooks/lib/activity'
import { startTurn } from '../hooks/lib/rounds'
import { drain, notGit, pane, stepsByTurn, SURFACES } from './helpers'

describe('activity helpers', () => {
  test('a call reads as what it ran on', async () => {
    expect(subjectOfCall('Read', { file_path: '/work/hooks/lib/a.ts' }, '/work')).toBe('hooks/lib/a.ts')
    expect(subjectOfCall('Read', { file_path: '/elsewhere/a.ts' }, '/work')).toBe('/elsewhere/a.ts')
    expect(subjectOfCall('Bash', { command: 'npm   test\n-- --watch=false' })).toBe('npm test -- --watch=false')
    expect(subjectOfCall('Grep', { pattern: 'TODO', path: '/work/src' }, '/work')).toBe('TODO in src')
    expect(subjectOfCall('Agent', { description: 'Read audit.ts', prompt: 'long' })).toBe('Read audit.ts')
    expect(subjectOfCall('TodoWrite', { todos: [{}, {}] })).toBe('2 items')
    expect(subjectOfCall('ToolSearch', { query: 'select:TaskCreate', max_results: 1 })).toBe('select:TaskCreate')
    expect(subjectOfCall('TaskUpdate', { taskId: '3', status: 'completed' })).toBe('#3 → completed')
    expect(subjectOfCall('mcp__github__get_issue', { number: 1 })).toBe('')
    expect(relativePath('/work', '/work/')).toBe('.')
  })

  test("an error reads as its first line, a bare exit code with the line after it", async () => {
    expect(errorLine("Exit code 2\nls: cannot access 'hooks/nope': No such file or directory")).toBe(
      "Exit code 2: ls: cannot access 'hooks/nope': No such file or directory",
    )
    expect(errorLine('<tool_use_error>File does not exist.</tool_use_error>')).toBe('File does not exist.')
    expect(errorLine('')).toBe('failed')
  })

  test('shell commands are sorted into the checks they run', async () => {
    expect(checkKinds('npm test')).toEqual(['tests'])
    expect(checkKinds('cd web && pnpm run lint && pnpm test -- --run')).toEqual(['lint', 'tests'])
    expect(checkKinds('CI=1 npx vitest run src')).toEqual(['tests'])
    expect(checkKinds('python -m pytest -q tests/')).toEqual(['tests'])
    expect(checkKinds('uv run mypy .')).toEqual(['types'])
    expect(checkKinds('npx tsc --noEmit -p .')).toEqual(['types'])
    expect(checkKinds('cargo clippy -- -D warnings && cargo test')).toEqual(['lint', 'tests'])
    expect(checkKinds('./gradlew build')).toEqual(['build'])
    expect(checkKinds('make test')).toEqual(['tests'])
    expect(checkKinds('make')).toEqual(['build'])
    expect(checkKinds('claude plugin validate --strict .')).toEqual(['lint'])
    // Not checks: reading, listing, git, a grep for the word.
    expect(checkKinds('ls -la && git status')).toEqual([])
    expect(checkKinds('grep -rn "npm test" README.md')).toEqual([])
    expect(checkKinds('cat package.json')).toEqual([])
  })

  test('a check failed when the shell says so, or its output does', async () => {
    expect(checkFailed(['tests'], true, '')).toBe(true)
    // `npm test | tail` exits 0: the output still says.
    expect(checkFailed(['tests'], false, ' 101 pass\n 0 fail\n')).toBe(false)
    expect(checkFailed(['tests'], false, 'Tests: 2 failed, 40 passed')).toBe(true)
    expect(checkFailed(['tests'], false, 'FAIL src/a.test.ts')).toBe(true)
    expect(checkFailed(['tests'], false, '0 failed, 12 passed')).toBe(false)
    expect(checkFailed(['types'], false, "src/a.ts(3,1): error TS2322: Type 'x'")).toBe(true)
    expect(checkFailed(['lint'], false, '✖ 3 errors, 0 warnings')).toBe(true)
    expect(checkFailed(['tests'], false, '3 errors were expected and handled')).toBe(false)
    // node --test and TAP, go, cargo, bun: piped through tail, only the output tells.
    expect(checkFailed(['tests'], false, 'not ok 2 - SAVE10 takes 10% off\n# tests 2\n# pass 1\n# fail 1\n')).toBe(true)
    expect(checkFailed(['tests'], false, 'ok 1 - sums\n# tests 1\n# pass 1\n# fail 0\n')).toBe(false)
    expect(checkFailed(['tests'], false, '--- FAIL: TestTotal (0.00s)')).toBe(true)
    expect(checkFailed(['tests'], false, 'test result: FAILED. 3 passed; 1 failed')).toBe(true)
    expect(checkFailed(['tests'], false, ' 117 pass\n 1 fail\n')).toBe(true)
  })

  test("each kind keeps its last run, in a fixed order", async () => {
    let checks = recordChecks([], 'npm test', true, '', 1000)
    checks = recordChecks(checks, 'npm run lint', false, '', 2000)
    checks = recordChecks(checks, 'npm test', false, '', 3000)
    checks = recordChecks(checks, 'git status', false, '', 4000)
    expect(checks).toEqual([
      { kind: 'tests', isPassing: true, command: 'npm test', at: 3000 },
      { kind: 'lint', isPassing: true, command: 'npm run lint', at: 2000 },
    ])
  })

  test('the plan follows TodoWrite and the Task tools', async () => {
    const todos = planFromTodos([
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
      { content: '', status: 'pending', activeForm: '' },
    ])!
    expect(todos).toHaveLength(3)
    expect(describePlan(todos)).toBe('1/3 · Fixing the bug')

    let plan = planWithCreated([], { task: { id: '1', subject: 'Read audit.ts' } }, { subject: 'Read audit.ts', activeForm: 'Reading audit.ts' })
    plan = planWithCreated(plan, { task: { id: '2', subject: 'Summarize' } }, { subject: 'Summarize' })
    plan = planWithUpdate(plan, { taskId: '1', status: 'in_progress' })
    expect(describePlan(plan)).toBe('0/2 · Reading audit.ts')
    plan = planWithUpdate(plan, { taskId: '1', status: 'completed' })
    plan = planWithUpdate(plan, { taskId: '2', status: 'completed', subject: 'Summarize it' })
    expect(describePlan(plan)).toBe('2/2 done')
    expect(planWithUpdate(plan, { taskId: '2', status: 'deleted' }).map(item => item.id)).toEqual(['1'])
    // TaskList replaces the plan and keeps what it doesn't say.
    const listed = planFromTaskList(plan, { tasks: [{ id: '1', subject: 'Read audit.ts', status: 'completed', blockedBy: [] }] })
    expect(listed).toEqual([{ id: '1', text: 'Read audit.ts', active: 'Reading audit.ts', status: 'completed' }])
    expect(planFromTodos('nope')).toBeNull()
  })

  test("the plan's bar: a cell a step, or to scale past PLAN_CELLS", async () => {
    const steps = (done: number, now: number, left: number) => [
      ...Array.from({ length: done }, () => ({ text: 'x', status: 'completed' as const })),
      ...Array.from({ length: now }, () => ({ text: 'x', status: 'in_progress' as const })),
      ...Array.from({ length: left }, () => ({ text: 'x', status: 'pending' as const })),
    ]
    expect(planBar(steps(2, 1, 3))).toEqual([
      { status: 'completed', cells: 2 },
      { status: 'in_progress', cells: 1 },
      { status: 'pending', cells: 3 },
    ])
    const big = planBar(steps(30, 1, 69), 24)
    expect(big.reduce((sum, run) => sum + run.cells, 0)).toBe(24)
    expect(big.find(run => run.status === 'in_progress')?.cells).toBe(1)
    expect(planBar([])).toEqual([])
  })

  test("a subagent's notification and calls read as what it did", async () => {
    const note =
      '<task-notification>\n<task-id>a221</task-id>\n<status>completed</status>\n<summary>Agent "Read audit.ts" finished</summary>\n' +
      '<usage><subagent_tokens>10752</subagent_tokens><tool_uses>3</tool_uses><duration_ms>2100</duration_ms></usage>\n</task-notification>'
    expect(noteUsage(note)).toEqual({ taskId: 'a221', calls: 3, durationMs: 2100 })
    let stats = addAgentCall({}, 'a221', false)
    stats = addAgentCall(stats, 'a221', true)
    expect(noteLabel(note, stats)).toBe('Agent "Read audit.ts" finished · 3 calls · 2.1s · ✗ 1')
    expect(noteLabel(note, {})).toBe('Agent "Read audit.ts" finished · 3 calls · 2.1s')
    expect(noteLabel('fix it', {})).toBeNull()
    expect(describeAgent(undefined, undefined, 0)).toBe('')
  })

  test('a turn keeps its first MAX_CALLS calls and counts every failure', async () => {
    let turn = startTurn('t1')
    for (let i = 0; i < MAX_CALLS + 5; i++) turn = addCall(turn, { tool: 'Bash', subject: 'x', ...(i % 2 === 0 ? { error: 'boom' } : {}) })!
    expect(turn.calls).toHaveLength(MAX_CALLS)
    expect(turn.failed).toBe(Math.ceil((MAX_CALLS + 5) / 2))
    expect(addCall(null, { tool: 'Read', subject: 'x' })).toBeNull()
  })
})

/** The texts of an element and its children, in drawing order; a Button's label is its text. */
function texts(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (node === null || typeof node !== 'object') return []
  const el = node as { type?: string; children?: unknown[]; props?: { label?: string } }
  if (el.type === 'Button') return [el.props?.label ?? '']
  const inner = (el.children ?? []).flatMap(texts)
  return el.type === 'Text' ? [inner.join('')] : inner
}

/** The pane's turn lines, top to bottom, with runs of spaces folded. */
async function turnLines(ui: { find: (q: { key: string }) => Promise<unknown> }): Promise<string[]> {
  const list = await ui.find({ key: 'turn-list' })
  return ((list as { children?: unknown[] } | undefined)?.children ?? []).map(child => texts(child).join(' ').trim().replace(/ +/g, ' '))
}

const USAGE_NOW = { value: { startedAt: 0, context: { tokens: 1000, window: 100_000, percent: 1 }, rateLimits: [] } }

/** A call as a subagent makes it: the engine sets `agentId`, which a plugin's own call can't name. */
function bySubagent<T extends object>(input: T, agentId: string): T {
  return { ...input, agentId } as T
}

/** The world beneath the plugin for a pane test: no git, a session root, a clock. */
function world(on: On, answers: Record<string, (input: Record<string, unknown>) => unknown>) {
  mock.clock(on, { now: 600_000 })
  on('session.usage', () => USAGE_NOW)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.root', () => ({ value: '/work' }))
  on('process.run', notGit())
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    const answer = answers[e.tool]
    return (answer ? answer(e as unknown as Record<string, unknown>) : { result: 'ok', text: 'ok' }) as never
  })
}

describe('timeline pane: what each turn did', () => {
  test('a failed call marks its row, and pressing the row lists the calls', async ($, on) => {
    world(on, {
      Bash: e => (e.command === 'ls hooks/nope' ? { isError: true, result: 'x', text: "Exit code 2\nls: cannot access 'hooks/nope'" } : { result: 'ok', text: 'ok' }),
    })
    on('turn.step', stepsByTurn({ t1: [{ tools: ['Read', 'Bash'] }, { tools: [] }], t2: [{ tools: ['Read'] }, { tools: [] }] }))

    await $.turn.start({ text: 'look around', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({ tool: 'Read', file_path: '/work/hooks/lib/a.ts', tool_use_id: 'toolu_1' })
    await $.tool.call({ tool: 'Bash', command: 'ls hooks/nope', tool_use_id: 'toolu_2' })
    await drain($.turn.step({ turnId: 't1', index: 1, model: 'any-model', messageCount: 3 }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 2_000, isAborted: false, reason: 'answer' })
    await $.turn.start({ text: 'read once more', turnId: 't2' })
    await drain($.turn.step({ turnId: 't2', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({ tool: 'Read', file_path: '/work/README.md', tool_use_id: 'toolu_3' })
    await drain($.turn.step({ turnId: 't2', index: 1, model: 'any-model', messageCount: 3 }))
    await $.turn.complete({ turnId: 't2', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: ' · ✗ 1 failed' })).toBeDefined()
      expect(await turnLines(ui)).toEqual(['#1 look around 2 calls 2.0s ✗ 1', '#2 read once more 1 call 1.0s'])
      await ui.press({ key: 'turn-t1' })
      expect(await turnLines(ui)).toEqual([
        '#1 look around 2 calls 2.0s ✗ 1',
        'Read hooks/lib/a.ts',
        "Bash ✗ ls hooks/nope",
        "Exit code 2: ls: cannot access 'hooks/nope'",
        '#2 read once more 1 call 1.0s',
      ])
      // Another row pressed opens in its place; pressed again, it closes.
      await ui.press({ key: 'turn-t2' })
      expect((await turnLines(ui)).slice(1)).toEqual(['#2 read once more 1 call 1.0s', 'Read README.md'])
      await ui.press({ key: 'turn-t2' })
      expect(await turnLines(ui)).toHaveLength(2)
      await ui.unmount()
    }
  })

  test("a call the guard blocks is the turn's failure too", async ($, on) => {
    world(on, {})
    on('turn.step', stepsByTurn({ t1: [{ tools: ['Bash'] }, { tools: [] }] }))
    await $.turn.start({ text: 'clean up', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'toolu_1' })
    await drain($.turn.step({ turnId: 't1', index: 1, model: 'any-model', messageCount: 3 }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })

    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'turn-t1' })
    const lines = await turnLines(ui)
    expect(lines[0]).toBe('#1 clean up 1 call 1.0s ✗ 1')
    expect(lines[1]).toBe('Bash ✗ rm -rf build')
    expect(lines[2]).toMatch(/^cockpit blocked this call: /)
    await ui.unmount()
  })

  test('a check that failed shows on its call, though a pipe hid the exit code', async ($, on) => {
    world(on, {
      Bash: e =>
        String(e.command).startsWith('npm test 2>&1 | tail')
          ? { result: 'ok', text: 'not ok 2 - SAVE10 takes 10% off\n# pass 1\n# fail 1' }
          : { result: 'ok', text: '# pass 2\n# fail 0' },
    })
    on('turn.step', stepsByTurn({ t1: [{ tools: ['Bash', 'Bash'] }, { tools: [] }] }))
    await $.turn.start({ text: 'fix the tests', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -40; cat src/cart.js', tool_use_id: 'toolu_1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_2' })
    await drain($.turn.step({ turnId: 't1', index: 1, model: 'any-model', messageCount: 3 }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })

    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'turn-t1' })
    // Not the turn's failures: finding a failing test is part of fixing it.
    expect(await turnLines(ui)).toEqual([
      '#1 fix the tests 2 calls 1.0s',
      'Bash npm test 2>&1 | tail -40; cat src/cart.js tests ✗',
      'Bash npm test tests ✓',
    ])
    expect(texts(await ui.find({ key: 'checks' })).join('')).toBe('  checkstests ✓ just now')
    await ui.unmount()
  })

  test('the checks line shows the last run of each kind', async ($, on) => {
    world(on, {
      Bash: e =>
        e.command === 'npm test'
          ? { isError: true, result: 'x', text: 'Exit code 1\nTests: 2 failed, 40 passed' }
          : { result: 'ok', text: 'All files pass linting.' },
    })
    on('turn.step', stepsByTurn({ t1: [{ tools: ['Bash', 'Bash'] }, { tools: [] }] }))
    await $.turn.start({ text: 'check it', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' })
    // A subagent's runs count too: the checks are the repository's.
    await $.tool.call(bySubagent({ tool: 'Bash', command: 'npm run lint', tool_use_id: 'toolu_2' } as const, 'a1'))
    // A run left in the background hasn't finished: no outcome yet.
    await $.tool.call({ tool: 'Bash', command: 'npm run build', run_in_background: true, tool_use_id: 'toolu_3' })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      const line = texts(await ui.find({ key: 'checks' })).join('')
      expect(line).toBe('  checkstests ✗ just now · lint ✓ just now')
      await ui.unmount()
    }
  })

  test("the plan's bar, and pressed, its steps", async ($, on) => {
    world(on, {
      TaskCreate: e => ({ result: { task: { id: String(e.subject).length % 7, subject: e.subject } }, text: 'created' }),
    })
    on('turn.step', stepsByTurn({ t1: [{ tools: ['TodoWrite'] }, { tools: [] }] }))
    await $.turn.start({ text: 'plan it', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
        { content: 'Run the tests', status: 'pending', activeForm: 'Running the tests' },
      ],
      tool_use_id: 'toolu_1',
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(texts(await ui.find({ key: 'plan' })).join('')).toBe('  plan■■□1/3 · Fixing the bug')
      await ui.press({ key: 'plan-toggle' })
      const overview = texts(await ui.find({ key: 'overview' }))
      expect(overview.filter(t => /^ +[✓▶○] /.test(t)).map(t => t.trim())).toEqual(['✓ Read the code', '▶ Fix the bug', '○ Run the tests'])
      await ui.press({ key: 'plan-toggle' })
      await ui.unmount()
    }
  })

  test("a subagent's line says what it did, failures included", async ($, on) => {
    world(on, {
      Agent: () => ({ result: { agentId: 'a221', status: 'async_launched' }, text: 'Async agent launched' }),
      Read: e => (String(e.file_path).includes('missing') ? { isError: true, result: 'x', text: 'File does not exist.' } : { result: 'ok', text: 'ok' }),
    })
    on('turn.step', stepsByTurn({ t1: [{ tools: ['Agent'] }, { tools: [] }], t2: [{ tools: [] }] }))
    await $.turn.start({ text: 'send an agent', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: 'any-model', messageCount: 1 }))
    await $.tool.call({ tool: 'Agent', description: 'Read audit.ts', prompt: 'read it', tool_use_id: 'toolu_1' })
    await $.tool.call(bySubagent({ tool: 'Read', file_path: '/work/audit.ts', tool_use_id: 'toolu_2' } as const, 'a221'))
    await $.tool.call(bySubagent({ tool: 'Read', file_path: '/work/missing.ts', tool_use_id: 'toolu_3' } as const, 'a221'))
    await drain($.turn.step({ turnId: 't1', index: 1, model: 'any-model', messageCount: 3 }))
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })
    await $.turn.start({
      text:
        '<task-notification>\n<task-id>a221</task-id>\n<summary>Agent "Read audit.ts" finished</summary>\n' +
        '<usage><tool_uses>2</tool_uses><duration_ms>2100</duration_ms></usage>\n</task-notification>',
      turnId: 't2',
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      await ui.press({ key: 'turn-t1' })
      const lines = await turnLines(ui)
      // The subagent's own calls are its, not the turn's: the row has no failure.
      expect(lines[0]).toBe('#1 send an agent 1 call 1.0s')
      expect(lines[1]).toBe('Agent Read audit.ts · 2 calls · ✗ 1')
      expect(lines[2]).toMatch(/^▶ #2 ⚙ Agent "Read audit.ts" finished · 2 calls · 2\.1s · ✗ 1/)
      await ui.press({ key: 'turn-t1' })
      await ui.unmount()
    }
  })
})
