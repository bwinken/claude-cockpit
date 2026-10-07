// The oldest Claude Code this mod was tested on. The manifest has no field
// Claude Code enforces, so session.start compares against it.

export const MIN_CLAUDE_CODE = '2.1.292'

function parts(version: string): number[] {
  return (version.match(/\d+/g) ?? []).slice(0, 3).map(Number)
}

/** True when `version` is older than `min`; false when either doesn't parse. */
export function isOlder(version: string | undefined, min: string = MIN_CLAUDE_CODE): boolean {
  if (version === undefined) return false
  const have = parts(version)
  const want = parts(min)
  if (have.length < 3 || want.length < 3) return false
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== want[i]!) return have[i]! < want[i]!
  }
  return false
}
