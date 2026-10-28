// The tool guard's deterministic rules: pure functions, no `$`.
//
// Built-in rules catch only clearly destructive operations. They read the
// shell command the way a person would, segment by segment, so text that
// merely mentions `rm -rf` (an echo, a commit message) doesn't match. Like
// any pattern on a command line, they're a safety net for honest mistakes,
// not a sandbox: a determined command can always be spelled another way.

export type RuleId =
  | 'rm-rf'
  | 'git-reset-hard'
  | 'git-push-force'
  | 'git-discard'
  | 'pipe-to-shell'
  | 'chmod-777'
  | 'read-secrets'
  | 'write-outside-project'

export const BUILTIN_RULES: readonly RuleId[] = [
  'rm-rf',
  'git-reset-hard',
  'git-push-force',
  'git-discard',
  'pipe-to-shell',
  'chmod-777',
  'read-secrets',
  'write-outside-project',
]

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

/**
 * `git clean` that deletes (`-f`, not a dry run `-n`), or a checkout or
 * restore of the whole tree (`.`, `:/`, `*`), which throws away every
 * uncommitted change. Restoring a named file is left alone.
 */
function isGitDiscard(words: readonly string[]): boolean {
  const args = gitArgs(words)
  if (args === null || args.length === 0) return false
  const [sub, ...rest] = args
  if (sub === 'clean') {
    const short = rest.filter(arg => /^-[a-zA-Z]+$/.test(arg))
    const isDryRun = rest.includes('--dry-run') || short.some(arg => arg.includes('n'))
    return !isDryRun && (rest.includes('--force') || short.some(arg => arg.includes('f')))
  }
  const isWholeTree = (arg: string) => arg === '.' || arg === ':/' || arg === '*' || arg === './' || arg === ':/:'
  if (sub === 'checkout') {
    const dash = rest.indexOf('--')
    const paths = dash === -1 ? rest.filter(arg => !arg.startsWith('-')) : rest.slice(dash + 1)
    return paths.some(isWholeTree)
  }
  if (sub === 'restore') {
    // --staged alone only unstages: the working tree keeps its changes.
    if (rest.some(arg => arg === '--staged' || arg === '-S') && !rest.some(arg => arg === '--worktree' || arg === '-W')) return false
    return rest.filter(arg => !arg.startsWith('-')).some(isWholeTree)
  }
  return false
}

/** Programs that run whatever script they read on stdin. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'perl', 'ruby', 'node'])
const DOWNLOADERS = new Set(['curl', 'wget'])

/**
 * A download run as a script: `curl … | sh`, `wget -O- … | sudo bash`,
 * `bash <(curl …)`, `sh -c "$(curl …)"`, or PowerShell's `irm … | iex`.
 */
function isPipeToShell(tool: string, command: string): boolean {
  if (/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^\n;]*\|\s*(?:iex|Invoke-Expression)\b/i.test(command)) return true
  if (/\b(?:iex|Invoke-Expression)\b[^\n;]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b/i.test(command)) return true
  if (tool === 'PowerShell') return false
  if (/\b(?:ba|z|da|k)?sh\b[^\n;|&]*<\(\s*(?:curl|wget)\b/.test(command)) return true
  if (/\b(?:ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/.test(command)) return true
  // Pipelines, quoted text blanked as `segments` does: a downloader, then a shell later in the same pipeline.
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q')
  for (const pipeline of unquoted.split(/\|\||&&|[;&\n]/)) {
    const stages = pipeline.split('|').map(stage => program(stage.trim().split(/\s+/).filter(Boolean)))
    const fetched = stages.findIndex(([name]) => name !== undefined && DOWNLOADERS.has(name))
    if (fetched !== -1 && stages.slice(fetched + 1).some(([name]) => name !== undefined && SHELLS.has(name))) return true
  }
  return false
}

/** `chmod 777`, `chmod -R 0777`, `chmod a+rwx`: anyone may write, and run, what it touches. */
function isWorldWritable(words: readonly string[]): boolean {
  const [name, ...args] = program(words)
  if (name !== 'chmod') return false
  return args.some(arg => /^0?777$/.test(arg) || /^(?:a|ugo)\+rwx$/.test(arg))
}

/**
 * A file that holds secrets: `.env` and its variants (not the `.example`,
 * `.sample` or `.template` checked in to show the keys), `.envrc`, SSH private
 * keys, AWS credentials, `.netrc`, `.pgpass`.
 */
export function isSecretFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^["']|["']$/g, '')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (/^\.env(?:\..+)?$/.test(name)) return !/\.(?:example|sample|template|dist|defaults|schema)$/i.test(name)
  if (name === '.envrc' || name === '.netrc' || name === '.pgpass') return true
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(name)) return true
  return /(?:^|\/)\.aws\/credentials$/.test(normalized)
}

/** Programs that print a file's contents, wholly or in part. */
const READERS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'tac', 'nl', 'strings', 'xxd', 'od', 'hexdump', 'base64',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed', 'cut', 'sort', 'uniq', 'jq', 'yq',
  'get-content', 'gc', 'type', 'select-string', 'sls',
])

/** The secret file a shell command prints, if any: `cat .env`, `grep KEY .env.local`, `Get-Content .env`. */
function secretRead(words: readonly string[]): string | undefined {
  const [name, ...args] = program(words)
  if (name === undefined || !READERS.has(name.toLowerCase())) return undefined
  // A redirect's target is written, not read: `cat .env.example > .env` reads the example.
  const read = args.filter((arg, i) => !/^\d*>/.test(arg) && !/^\d*>>?$/.test(args[i - 1] ?? ''))
  return read.map(arg => arg.replace(/^</, '')).find(arg => !arg.startsWith('-') && isSecretFile(arg))
}

/** File tools that read a file's contents, and the argument that names it. */
const READ_TOOLS: Readonly<Record<string, string>> = { Read: 'file_path', Grep: 'path', NotebookRead: 'notebook_path' }

export function secretVerdict(path: string): Verdict {
  return {
    rule: 'read-secrets',
    reason:
      `${path} holds secrets (keys, tokens, passwords), and reading it puts them in the conversation. ` +
      'Read the matching .env.example or the code that uses the values instead, or ask the user for the one value you need.',
  }
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
  if (!disabled.has('git-discard') && parts.some(isGitDiscard)) {
    return {
      rule: 'git-discard',
      reason:
        'this throws away uncommitted work for good: git clean -f deletes untracked files, and a checkout or restore of the whole tree ' +
        'discards every change. Use `git stash -u` to set changes aside, restore the specific files you mean by path, or ask the user.',
    }
  }
  if (!disabled.has('pipe-to-shell') && isPipeToShell(tool, command)) {
    return {
      rule: 'pipe-to-shell',
      reason:
        'this runs a script straight from the network, unread. Download it to a file first, read it, then ask the user ' +
        'before running it; or install the tool with a package manager.',
    }
  }
  if (!disabled.has('chmod-777') && parts.some(isWorldWritable)) {
    return {
      rule: 'chmod-777',
      reason:
        'chmod 777 lets every user on the machine write and run these files. Grant only what is needed, ' +
        'such as `chmod u+x` for a script or `chmod 644` for a file.',
    }
  }
  if (!disabled.has('read-secrets')) {
    const secret = parts.map(secretRead).find(path => path !== undefined)
    if (secret !== undefined) return secretVerdict(secret)
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
  const field = READ_TOOLS[tool]
  const read = field === undefined ? undefined : input[field]
  if (!rules.disabled.has('read-secrets') && typeof read === 'string' && isSecretFile(read)) return secretVerdict(read)
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
