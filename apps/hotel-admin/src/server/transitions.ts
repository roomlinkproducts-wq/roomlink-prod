import type { request_status } from '@roomlink/db'

/**
 * PRD §17: NEW(pending) -> ASSIGNED -> IN_PROGRESS -> COMPLETED, plus optional CANCELLED/ESCALATED.
 *
 * `pending_acceptance` (reception assigned someone, awaiting their
 * accept/reject) deliberately has no outbound entries here — the only ways
 * out are the dedicated `acceptAssignment`/`rejectAssignment` actions, not
 * this generic status route, so a task can't be started/completed before
 * the assignee has confirmed it. `cancelled` is the one exception: reception
 * can still pull back a request that's stuck awaiting a response.
 *
 * `completed` is reachable from every other open state, not just
 * `in_progress` — reception routinely resolves a guest's request directly
 * (a call to the room, a quick front-desk fix) without ever routing it
 * through a department's start/in-progress flow, and that's still a closed
 * request, not a cancelled one.
 */
export const REQUEST_TRANSITIONS: Record<request_status, request_status[]> = {
  pending: ['in_progress', 'cancelled', 'escalated', 'completed'],
  pending_acceptance: ['cancelled'],
  assigned: ['in_progress', 'cancelled', 'escalated', 'completed'],
  in_progress: ['completed', 'cancelled', 'escalated'],
  completed: [],
  cancelled: [],
  escalated: ['in_progress', 'cancelled', 'completed'],
}

export function canTransition<T extends string>(map: Record<T, T[]>, from: T, to: T): boolean {
  return map[from]?.includes(to) ?? false
}
