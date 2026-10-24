import type { request_priority } from '@roomlink/db'

/**
 * "SLA risk" (PRD §4 sort, §3 "delayed" KPI) is a computed heuristic, not a
 * stored field — same "don't overbuild V1 infra" principle already applied
 * to alerts.service.ts's stale-unassigned threshold. Urgent work is flagged
 * sooner than normal work.
 */
export const SLA_RISK_MINUTES: Record<request_priority, number> = {
  urgent: 15,
  high: 30,
  normal: 60,
}

export function minutesElapsed(createdAt: Date, now: Date = new Date()): number {
  return (now.getTime() - createdAt.getTime()) / 60000
}

export function isAtSlaRisk(priority: request_priority, createdAt: Date, now: Date = new Date()): boolean {
  return minutesElapsed(createdAt, now) >= SLA_RISK_MINUTES[priority]
}

/**
 * Service delivery standard: every request, whatever its service or
 * priority, is expected to be closed within this many minutes of being
 * raised. It drives both the reception reminders (sla-reminders.service.ts)
 * and the "on time" figure in the hotel admin's service report
 * (service-reports.service.ts), so the two always agree on what "late" means.
 * Separate from SLA_RISK_MINUTES above, which only orders the request board.
 */
export const SERVICE_STANDARD_MINUTES = 30

/** A still-open request is reminded again every this many minutes until it's closed. */
export const REMINDER_REPEAT_MINUTES = 30

export const OPEN_REQUEST_STATUSES = ['pending', 'pending_acceptance', 'assigned', 'in_progress', 'escalated'] as const

/**
 * Two clocks are tracked for an open request: time since it was raised, and
 * time spent in its current status (e.g. accepted but never started). A
 * status can never be older than the request itself, so the "open" clock is
 * always the one that crosses the standard first; the status clock is what
 * tells reception *where* the request is stuck.
 */
export function isOverdue(createdAt: Date, now: Date = new Date()): boolean {
  return minutesElapsed(createdAt, now) >= SERVICE_STANDARD_MINUTES
}
