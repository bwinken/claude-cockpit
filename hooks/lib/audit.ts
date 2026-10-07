// The tool guard's audit trail, kept in $.store across sessions.

/** How many entries the audit keeps; past it the oldest go first. */
export const MAX_AUDIT = 500

export type AuditEntry = {
  /** When, in `$.clock.now()` milliseconds. */
  at: number
  session: string
  tool: string
  /** What cockpit did: `deny`, `allow`, or how a question about an auto-mode block was answered. */
  decision: 'deny' | 'allow' | 'approved-after-auto-block' | 'kept-auto-block' | 'guard-failed'
  rule: string
  /** The command, path or arguments, cut to 300 characters. */
  subject: string
  reason?: string
}

/** The trail with `entry` appended and the oldest dropped past `max`. */
export function appendAudit(trail: unknown, entry: AuditEntry, max = MAX_AUDIT): AuditEntry[] {
  const list = Array.isArray(trail) ? (trail as AuditEntry[]) : []
  return [...list, entry].slice(-Math.max(1, max))
}

/** One line for the transcript: `cockpit denied Bash (rm-rf): rm -rf build`. */
export function auditLine(entry: AuditEntry): string {
  const verb = {
    deny: 'denied',
    allow: 'allowed',
    'approved-after-auto-block': 'ran, approved by the user after auto mode blocked it:',
    'kept-auto-block': 'kept blocked, as auto mode decided:',
    'guard-failed': 'denied, its guard having failed:',
  }[entry.decision]
  const subject = entry.subject.length > 120 ? entry.subject.slice(0, 119) + '…' : entry.subject
  return entry.decision === 'deny' || entry.decision === 'allow'
    ? `${verb} ${entry.tool} (${entry.rule}): ${subject}`
    : `${entry.tool} ${verb} ${subject}`
}
