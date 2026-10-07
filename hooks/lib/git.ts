// What a turn changed in the working tree, by git, without touching the
// index, HEAD, the stash list or any file:
//
// - tracked files: `git stash create` writes a commit of the working tree
//   and stores it nowhere (no stash entry), or HEAD when nothing changed;
// - untracked, unignored files: each one's blob, written with
//   `git hash-object -w`;
// - the change: `git diff --numstat` between the two snapshots' commits, and
//   between the two blobs of each untracked file that changed.
//
// Every git call goes through `run`, so the module holds no `$`.

import type { CockpitEditedFile, CockpitEdits, CockpitGitSnapshot } from '../../types'

export type GitRun = (args: readonly string[], options?: { cwd?: string; stdin?: string }) => Promise<{ exitCode: number; stdout: string }>

/** A file's size and modification time, or null when it can't be read. */
export type StatFile = (path: string) => Promise<{ size: number; mtimeMs: number } | null>

/**
 * Untracked files larger than this aren't hashed into the repository's object
 * store: hashing writes a full copy into .git at every snapshot. Their size
 * and modification time stand in for their content instead.
 */
export const MAX_HASH_BYTES = 2 * 1024 * 1024

/** The stand-in id of a large untracked file: `large:<size>:<mtime>`. */
export function largeId(size: number, mtimeMs: number): string {
  return `large:${size}:${Math.floor(mtimeMs)}`
}

function isLargeId(id: string | null): boolean {
  return id !== null && id.startsWith('large:')
}

/** Past this many untracked files, they're left out of the snapshot. */
export const MAX_UNTRACKED = 500
/** Past this many changed untracked files, their line counts aren't asked for. */
export const MAX_BLOB_DIFFS = 50

/** git's id of the empty tree, for a repository with no commit yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

async function out(run: GitRun, args: readonly string[], options?: { cwd?: string; stdin?: string }): Promise<string | null> {
  try {
    const result = await run(args, options)
    return result.exitCode === 0 ? result.stdout : null
  } catch {
    return null
  }
}

/**
 * The working tree now, or null outside a git repository. With `stat`,
 * untracked files over MAX_HASH_BYTES are recorded by size and time, not
 * hashed; without it, every untracked file is hashed.
 */
export async function snapshot(run: GitRun, stat?: StatFile): Promise<CockpitGitSnapshot | null> {
  const root = (await out(run, ['rev-parse', '--show-toplevel']))?.trim()
  if (!root) return null
  const at = { cwd: root }

  const stashed = (await out(run, ['stash', 'create'], at))?.trim()
  const head = stashed ? null : (await out(run, ['rev-parse', '--verify', '-q', 'HEAD'], at))?.trim()
  const tree = stashed || head || EMPTY_TREE

  let untracked: Record<string, string> | null = {}
  const listed = await out(run, ['ls-files', '--others', '--exclude-standard', '-z'], at)
  // A path with a newline can't go through --stdin-paths: leave it out.
  const paths = (listed ?? '').split('\0').filter(path => path !== '' && !path.includes('\n') && !path.includes('\r'))
  if (paths.length > MAX_UNTRACKED) {
    untracked = null
  } else if (paths.length > 0) {
    const toHash: string[] = []
    for (const path of paths) {
      const info = stat === undefined ? null : await stat(root + '/' + path)
      if (info !== null && info.size > MAX_HASH_BYTES) untracked[path] = largeId(info.size, info.mtimeMs)
      else toHash.push(path)
    }
    if (toHash.length > 0) {
      const hashed = await out(run, ['hash-object', '-w', '--stdin-paths'], { cwd: root, stdin: toHash.join('\n') + '\n' })
      // git for Windows may end lines with \r\n.
      const blobs = (hashed ?? '').split('\n').map(line => line.trim()).filter(Boolean)
      if (blobs.length === toHash.length) {
        toHash.forEach((path, i) => {
          untracked![path] = blobs[i]!
        })
      } else {
        untracked = null
      }
    }
  }
  return { root, tree, untracked }
}

/** Parses `git diff --numstat -z --no-renames`: `added\tremoved\tpath\0`, `-` for binary. */
export function parseNumstat(text: string): CockpitEditedFile[] {
  const files: CockpitEditedFile[] = []
  for (const record of text.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n+/, ''))
    if (!match) continue
    files.push({
      path: match[3]!,
      added: match[1] === '-' ? null : Number(match[1]),
      removed: match[2] === '-' ? null : Number(match[2]),
    })
  }
  return files
}

/** The two counts of numstat's first line (`3\t1\t…`); null for binary or no output. */
export function parseCounts(text: string): { added: number | null; removed: number | null } {
  const match = /^(\d+|-)\t(\d+|-)\t/.exec(text)
  if (!match) return { added: null, removed: null }
  return { added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]) }
}

/** One blob-to-blob change. Without -z: with it, numstat leaves the path field empty for a blob pair. */
async function blobDiff(run: GitRun, root: string, from: string, to: string, path: string): Promise<CockpitEditedFile> {
  const text = await out(run, ['diff', '--numstat', from, to], { cwd: root })
  return { path, ...(text === null ? { added: null, removed: null } : parseCounts(text)) }
}

/** The empty blob's id, writing it first so that diffs can name it. */
async function emptyBlob(run: GitRun, root: string): Promise<string | null> {
  return (await out(run, ['hash-object', '-w', '--stdin'], { cwd: root, stdin: '' }))?.trim() || null
}

/** Sums a list of changed files; a binary file adds no lines. */
export function totalEdits(files: readonly CockpitEditedFile[]): CockpitEdits {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  return {
    files: sorted,
    added: sorted.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: sorted.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  }
}

/** What changed between two snapshots of one repository, or null when they can't be compared. */
export async function diffSnapshots(run: GitRun, from: CockpitGitSnapshot, to: CockpitGitSnapshot): Promise<CockpitEdits | null> {
  if (from.root !== to.root) return null
  const root = from.root
  const numstat = await out(run, ['diff', '--numstat', '-z', '--no-renames', from.tree, to.tree], { cwd: root })
  if (numstat === null) return null
  const byPath = new Map(parseNumstat(numstat).map(file => [file.path, file]))

  if (from.untracked !== null && to.untracked !== null) {
    const before = from.untracked
    const after = to.untracked
    const pairs: Array<[path: string, from: string | null, to: string | null]> = []
    for (const [path, blob] of Object.entries(after)) {
      if (before[path] !== blob) pairs.push([path, before[path] ?? null, blob])
    }
    for (const [path, blob] of Object.entries(before)) {
      if (path in after) continue
      // Untracked before and tracked now (it was added): compare with what was committed.
      if (byPath.has(path)) pairs.push([path, blob, `${to.tree}:${path}`])
      else pairs.push([path, blob, null])
    }
    const empty = pairs.some(([, a, b]) => a === null || b === null) ? await emptyBlob(run, root) : null
    for (const [index, [path, a, b]] of pairs.entries()) {
      // A large file was recorded by size and time: it changed, by how many lines isn't known.
      if (isLargeId(a) || isLargeId(b)) {
        byPath.set(path, { path, added: null, removed: null, large: true })
        continue
      }
      if (index >= MAX_BLOB_DIFFS || (empty === null && (a === null || b === null))) {
        byPath.set(path, { path, added: null, removed: null })
        continue
      }
      byPath.set(path, await blobDiff(run, root, a ?? empty!, b ?? empty!, path))
    }
  }

  const files = [...byPath.values()].filter(file => file.added !== 0 || file.removed !== 0)
  return totalEdits(files)
}
