// The tool guard's deterministic rules: pure functions, no `$`.
//
// Built-in rules catch only clearly destructive operations. They read the
// shell command the way a person would, segment by segment, so text that
// merely mentions `rm -rf` (an echo, a commit message) doesn't match. Like
// any pattern on a command line, they're a safety net for honest mistakes,
// not a sandbox: a determined command can always be spelled another way.

export type RuleId = 'rm-rf' | 'git-reset-hard' | 'git-push-force' | 'write-outside-project'

export const BUILTIN_RULES: readonly RuleId[] = ['rm-rf', 'git-reset-hard', 'git-push-force', 'write-outside-project']

/** A rule the person adds in a rules file: `pattern` is a regular expression over the call's subject. */
export type CustomRule = {
  id: string
  tool: string
  pattern: string
  reason?: string
}

export type RulesFile = {
  /** Built-in rules to turn off. Only the user's own rules file can turn one off. */
  disable?: string[]
  deny?: CustomRule[]
  /** Calls to approve without a prompt. Only the user's own rules file can hold these. */
  allow?: CustomRule[]
  /** More directories the file tools may write to, besides the project. */
  writableRoots?: string[]
}

export type GuardRules = {
  disabled: ReadonlySet<string>
  deny: readonly CustomRule[]
  allow: readonly CustomRule[]
  writableRoots: readonly string[]
}

export type Verdict = { rule: string; reason: string }

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
export const FILE_TOOLS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** What a rule's pattern is matched against: the command, the path, the URL, or the arguments as JSON. */
export function subjectOf(tool: string, input: Record<string, unknown>): string {
  const field = SHELL_TOOLS.has(tool) ? 'command' : FILE_TOOLS[tool] ?? (tool === 'WebFetch' ? 'url' : undefined)
  if (field !== undefined && typeof input[field] === 'string') return input[field] as string
  const { description: _description, ...rest } = input
  return JSON.stringify(rest)
}

/** The command's simple commands, split at `;`, `&&`, `||`, `|`, `&` and newlines, each as words. */
export function segments(command: string): string[][] {
  // Quoted text is an argument, never a command: blank it out before splitting.
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q')
  return unquoted
    .split(/\|\||&&|[;|&\n]/)
    .map(part =>
      part
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    )
    .filter(words => words.length > 0)
}

/** The words from the program on: leading `VAR=value`, `sudo`, `command`, `env`, `nohup`, `time` skipped. */
export function program(words: readonly string[]): string[] {
  let i = 0
  while (i < words.length) {
    const word = words[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ['sudo', 'command', 'env', 'nohup', 'time', 'exec'].includes(word)) {
      i += 1
      continue
    }
    break
  }
  const rest = words.slice(i)
  if (rest.length > 0) rest[0] = rest[0]!.replace(/^.*\//, '')
  return rest
}

function isRecursiveForceRm(words: readonly string[]): boolean {
  const [name, ...args] = program(words)
  if (name !== 'rm') return false
  let recursive = false
  let force = false
  for (const arg of args) {
    if (arg === '--') break
    if (arg === '--recursive') recursive = true
    else if (arg === '--force') force = true
    else if (/^-[a-zA-Z]+$/.test(arg)) {
      if (/[rR]/.test(arg)) recursive = true
      if (arg.includes('f')) force = true
    }
  }
  return recursive && force
}

/** git's subcommand and its arguments, past `-C dir`, `-c key=value` and other global options. */
function gitArgs(words: readonly string[]): string[] | null {
  const [name, ...args] = program(words)
  if (name !== 'git') return null
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  return args.slice(i)
}

function isHardReset(words: readonly string[]): boolean {
  const args = gitArgs(words)
  return args !== null && args[0] === 'reset' && args.includes('--hard')
}

function isForcePush(words: readonly string[]): boolean {
  const args = gitArgs(words)
  if (args === null || args[0] !== 'push') return false
  return args.slice(1).some(arg => {
    if (arg === '--force') return true
    // --force-with-lease and --force-if-includes are the safe forms: left alone.
    if (arg.startsWith('--')) return false
    if (/^-[a-zA-Z]+$/.test(arg)) return arg.includes('f')
    // A `+` refspec forces that one ref.
    return arg.startsWith('+') && arg.length > 1
  })
}

function isPowerShellRecursiveForceRemove(command: string): boolean {
  return /\b(Remove-Item|rm|del|rd|rmdir)\b[^\n;|]*-Recurse\b[^\n;|]*-Force\b|\b(Remove-Item|rm|del|rd|rmdir)\b[^\n;|]*-Force\b[^\n;|]*-Recurse\b/i.test(command)
}

/** The built-in rule a shell command breaks, if any. */
export function checkCommand(tool: string, command: string, disabled: ReadonlySet<string>): Verdict | null {
  const parts = segments(command)
  if (!disabled.has('rm-rf')) {
    const hit = tool === 'PowerShell' ? isPowerShellRecursiveForceRemove(command) : parts.some(isRecursiveForceRm)
    if (hit) {
      return {
        rule: 'rm-rf',
        reason:
          'a recursive, forced delete (rm -rf) can wipe files with no way back. Delete the specific files or directories you mean by path, ' +
          'without -f, so mistakes still prompt; or ask the user to run the delete themselves.',
      }
    }
  }
  if (!disabled.has('git-reset-hard') && parts.some(isHardReset)) {
    return {
      rule: 'git-reset-hard',
      reason:
        'git reset --hard throws away uncommitted changes in the working tree. Use `git stash` to set changes aside, ' +
        '`git restore <path>` for specific files, or ask the user before discarding work.',
    }
  }
  if (!disabled.has('git-push-force') && parts.some(isForcePush)) {
    return {
      rule: 'git-push-force',
      reason:
        "a force push rewrites the remote branch and can delete other people's commits. Push without --force, " +
        'use --force-with-lease if a rewrite is really needed, or ask the user to push.',
    }
  }
  return null
}

function regex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/** Whether a custom rule applies to this call: its tool (`*` for any) and its pattern over the subject. */
export function matches(rule: CustomRule, tool: string, subject: string): boolean {
  if (rule.tool !== '*' && rule.tool !== tool) return false
  return regex(rule.pattern)?.test(subject) ?? false
}

/** The deny verdict a call gets from the built-in command rules and the custom deny rules, if any. */
export function checkCall(tool: string, input: Record<string, unknown>, rules: GuardRules): Verdict | null {
  if (SHELL_TOOLS.has(tool) && typeof input.command === 'string') {
    const verdict = checkCommand(tool, input.command, rules.disabled)
    if (verdict) return verdict
  }
  const subject = subjectOf(tool, input)
  const custom = rules.deny.find(rule => matches(rule, tool, subject))
  if (custom) {
    return {
      rule: custom.id,
      reason: (custom.reason ?? 'this call matches a deny rule in the cockpit rules file') + '. Find another way, or ask the user.',
    }
  }
  return null
}

/** The custom allow rule this call matches, if any. */
export function allowedBy(tool: string, input: Record<string, unknown>, rules: GuardRules): CustomRule | undefined {
  const subject = subjectOf(tool, input)
  return rules.allow.find(rule => matches(rule, tool, subject))
}

/** A path with `/` separators, no trailing `/`, `~` expanded; drive letters lower-cased. */
export function normalizePath(path: string, home: string | undefined): string {
  let p = path.replace(/\\/g, '/')
  if (home !== undefined && (p === '~' || p.startsWith('~/'))) p = home.replace(/\\/g, '/') + p.slice(1)
  if (/^[A-Za-z]:\//.test(p)) p = p[0]!.toLowerCase() + p.slice(1)
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** True for a Windows path, `c:/...` or a UNC `//server/share/...`, whose file system ignores case. */
export function isWindowsPath(path: string): boolean {
  return /^[a-z]:\//i.test(path) || /^\/\/[^/]/.test(path)
}

/**
 * Whether `path` is `root` or lies under it. Windows paths compare without
 * regard to case, as NTFS does: `C:/Users/Me/repo` holds `c:/users/me/repo/a.ts`.
 */
export function isInside(path: string, root: string): boolean {
  const ignoreCase = isWindowsPath(path) || isWindowsPath(root)
  const p = ignoreCase ? path.toLowerCase() : path
  const r = ignoreCase ? root.toLowerCase() : root
  return p === r || p.startsWith(r.endsWith('/') ? r : r + '/')
}

/**
 * The directories writes may go to besides the project: temp directories and
 * Claude Code's own configuration directory (`~/.claude`, or CLAUDE_CONFIG_DIR),
 * where global CLAUDE.md, skills, agents, plans and memory live. Claude Code
 * still prompts before writes there, as it does for every protected path.
 */
export function defaultWritableRoots(home: string | undefined, tmp: readonly (string | undefined)[], configDir?: string): string[] {
  const roots = ['/tmp', '/private/tmp', '/var/folders', ...tmp.filter((t): t is string => !!t)]
  if (home !== undefined) roots.push(home + '/.claude')
  if (configDir) roots.push(configDir)
  return roots.map(root => normalizePath(root, home))
}

export function outsideProjectVerdict(path: string, root: string): Verdict {
  return {
    rule: 'write-outside-project',
    reason:
      `${path} is outside the project (${root}), and cockpit only lets the file tools write inside it. ` +
      'Write the file under the project instead, or ask the user to add the directory to writableRoots in their cockpit rules file.',
  }
}

/**
 * Reads a rules file's text. `isUserFile` is false for a project's file,
 * which may only add deny rules: a repository can't approve calls for itself
 * or switch protections off.
 */
export function parseRules(text: string, isUserFile: boolean): { rules: RulesFile; problem?: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { rules: {}, problem: 'not valid JSON: ' + String(error) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { rules: {}, problem: 'not a JSON object' }
  const obj = raw as Record<string, unknown>
  const list = (key: string): CustomRule[] =>
    Array.isArray(obj[key])
      ? (obj[key] as unknown[]).filter(
          (r): r is CustomRule =>
            r !== null &&
            typeof r === 'object' &&
            typeof (r as CustomRule).id === 'string' &&
            typeof (r as CustomRule).tool === 'string' &&
            typeof (r as CustomRule).pattern === 'string' &&
            regex((r as CustomRule).pattern) !== null,
        )
      : []
  const strings = (key: string): string[] => (Array.isArray(obj[key]) ? (obj[key] as unknown[]).filter((s): s is string => typeof s === 'string') : [])
  if (!isUserFile) return { rules: { deny: list('deny') } }
  return { rules: { disable: strings('disable'), deny: list('deny'), allow: list('allow'), writableRoots: strings('writableRoots') } }
}

/** The rules in force: the user's file and the project's together, with the built-in switches. */
export function combineRules(files: readonly RulesFile[], disabledByConfig: readonly string[]): GuardRules {
  return {
    disabled: new Set([...disabledByConfig, ...files.flatMap(file => file.disable ?? [])]),
    deny: files.flatMap(file => file.deny ?? []),
    allow: files.flatMap(file => file.allow ?? []),
    writableRoots: files.flatMap(file => file.writableRoots ?? []),
  }
}

export const NO_RULES: GuardRules = { disabled: new Set(), deny: [], allow: [], writableRoots: [] }

/** `path` made absolute against `base`, `.` and `..` folded; both already normalized. */
export function resolvePath(base: string, path: string): string {
  const isAbsolute = path.startsWith('/') || /^[a-z]:\//i.test(path)
  const joined = isAbsolute ? path : base.replace(/\/+$/, '') + '/' + path
  // A drive (`c:`) or a UNC share's leading `/` stays in front of the folded segments.
  const drive = /^[a-z]:/i.exec(joined)?.[0] ?? (/^\/\/[^/]/.test(joined) ? '/' : '')
  const parts: string[] = []
  for (const part of joined.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return drive + '/' + parts.join('/')
}

/** A tool call's own arguments: its input less the keys the engine adds (`tool`, `tool_use_id`, `agentId`, `consent`). */
export function argsOf(e: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...args } = e
  return args
}
