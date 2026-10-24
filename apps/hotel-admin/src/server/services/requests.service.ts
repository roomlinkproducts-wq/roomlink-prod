import { prisma } from '@/server/db'
import { recordAudit } from '@/server/audit'
import { ForbiddenError } from '@/server/hotel-rbac'
import { REQUEST_TRANSITIONS, canTransition } from '@/server/transitions'
import { isAtSlaRisk } from '@/server/sla'
import { InvalidTransitionError } from '@/server/errors'
import { sendPushToRecipient } from '@/server/push'
import type {
  CreateRequestInput,
  EscalateRequestInput,
  RequestFilters,
  UpdateRequestStatusInput,
} from '@/server/validation/request.schema'
import type { HotelSessionUser } from '@/server/require-hotel-session'
import type { request_status } from '@roomlink/db'

const REQUEST_INCLUDE = {
  rooms: { select: { room_number: true } },
  guests: { select: { full_name: true } },
  departments: { select: { department_id: true, name: true, manager_id: true } },
  users: { select: { user_id: true, full_name: true } },
} as const

/**
 * Department-isolation gate (Department Manager PRD §2/§13, Department Staff
 * PRD Rule 3): hotel_admin and Reception see the whole hotel; a Department
 * Manager must only ever see the department(s) they manage, and a Department
 * Staff member must only ever see the department(s) they're a member of
 * (via `user_departments`, not `departments.manager_id` — staff have no
 * managed departments), no matter what the client asks for. Staff visibility
 * stays department-*wide* (not "only my own assigned requests") — the Staff
 * PRD's own worked examples (§6: "Selecting Housekeeping shows only
 * Housekeeping tasks") and Task List filters (§7: All/New/Assigned/In
 * Progress/Completed) both describe seeing the department's queue, not a
 * personal subset; write access to any individual request stays gated by
 * `assertCanWorkRequest` regardless of what's visible here.
 */
async function resolveRequestScope(
  hotelId: string,
  actor: HotelSessionUser
): Promise<{ restricted: boolean; departmentIds: string[] }> {
  if (actor.userType === 'hotel_admin') return { restricted: false, departmentIds: [] }
  if (actor.roleName === 'Department Manager') {
    return { restricted: true, departmentIds: await getManagerDepartmentIds(hotelId, actor.id) }
  }
  if (actor.roleName === 'Department Staff') {
    return { restricted: true, departmentIds: await getStaffDepartmentIds(hotelId, actor.id) }
  }
  return { restricted: false, departmentIds: [] }
}

/** A manager may own more than one department (PRD §5) — reused by the Team/Activity/Alerts screens. */
export async function getManagerDepartmentIds(hotelId: string, userId: string): Promise<string[]> {
  const managed = await prisma.departments.findMany({
    where: { hotel_id: hotelId, manager_id: userId },
    select: { department_id: true },
  })
  return managed.map((d) => d.department_id)
}

/** A staff member may belong to zero, one, or several departments (Staff PRD Rule 2) — reused by the dashboard/tasks/alerts screens. */
export async function getStaffDepartmentIds(hotelId: string, userId: string): Promise<string[]> {
  const memberships = await prisma.user_departments.findMany({
    where: { user_id: userId, departments: { hotel_id: hotelId } },
    select: { department_id: true },
  })
  return memberships.map((m) => m.department_id)
}

export async function listRequests(hotelId: string, filters: RequestFilters, actor: HotelSessionUser) {
  const scope = await resolveRequestScope(hotelId, actor)

  if (scope.restricted) {
    if (filters.departmentId && !scope.departmentIds.includes(filters.departmentId)) {
      throw new ForbiddenError('Not authorized to view that department')
    }
    if (scope.departmentIds.length === 0) return []
  }

  return prisma.requests.findMany({
    where: {
      hotel_id: hotelId,
      ...(scope.restricted ? { department_id: { in: scope.departmentIds } } : {}),
      ...(filters.departmentId ? { department_id: filters.departmentId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.roomId ? { room_id: filters.roomId } : {}),
    },
    orderBy: { created_at: 'desc' },
    include: REQUEST_INCLUDE,
  })
}

/** Single-request read, scoped through the same department-isolation gate as `listRequests` — a Task Detail deep-link can't bypass it. */
export async function getRequestById(hotelId: string, requestId: string, actor: HotelSessionUser) {
  const scope = await resolveRequestScope(hotelId, actor)
  const request = await prisma.requests.findFirstOrThrow({
    where: {
      request_id: requestId,
      hotel_id: hotelId,
      ...(scope.restricted ? { department_id: { in: scope.departmentIds } } : {}),
    },
    include: REQUEST_INCLUDE,
  })
  return request
}

/** Eligible staff for a department = its members via user_departments (§7/§19 of the PRD), active only. */
export async function listEligibleAssignees(hotelId: string, departmentId: string) {
  const department = await prisma.departments.findFirstOrThrow({
    where: { department_id: departmentId, hotel_id: hotelId },
    include: { users: { select: { user_id: true, full_name: true } } },
  })

  const members = await prisma.users.findMany({
    where: {
      hotel_id: hotelId,
      status: 'active',
      user_departments: { some: { department_id: departmentId } },
    },
    select: { user_id: true, full_name: true },
    orderBy: { full_name: 'asc' },
  })

  return { manager: department.users, members }
}

type ManagerQueueKpiRow = {
  new_today: number
  unassigned: number
  assigned: number
  in_progress: number
  completed_today: number
  escalated: number
}

/**
 * PRD §3 — a department manager's queue KPI row. The 6 same-table counts
 * collapse into one round trip via conditional subqueries (see the latency
 * audit — round-trip count matters far more here than query complexity).
 */
export async function getManagerQueueKpis(hotelId: string, departmentIds: string[]) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [kpiRows, openWork] = await Promise.all([
    prisma.$queryRaw<ManagerQueueKpiRow[]>`
      SELECT
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND created_at >= ${startOfDay})::int AS new_today,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND status = 'pending')::int AS unassigned,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND status IN ('assigned', 'pending_acceptance'))::int AS assigned,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND status = 'in_progress')::int AS in_progress,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND status = 'completed' AND completed_at >= ${startOfDay})::int AS completed_today,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND status = 'escalated')::int AS escalated
    `,
    prisma.requests.findMany({
      where: { hotel_id: hotelId, department_id: { in: departmentIds }, status: { in: ['pending', 'pending_acceptance', 'assigned', 'in_progress'] } },
      select: { priority: true, created_at: true },
    }),
  ])
  const kpis = kpiRows[0]

  const atRisk = openWork.filter((r) => isAtSlaRisk(r.priority, r.created_at)).length

  return {
    newToday: kpis.new_today,
    unassigned: kpis.unassigned,
    assigned: kpis.assigned,
    inProgress: kpis.in_progress,
    completedToday: kpis.completed_today,
    delayedOrEscalated: atRisk + kpis.escalated,
  }
}

/** The manager's live work list (PRD §3) — everything still open across their department(s). */
export async function getManagerQueueRequests(hotelId: string, departmentIds: string[]) {
  return prisma.requests.findMany({
    where: { hotel_id: hotelId, department_id: { in: departmentIds }, status: { in: ['pending', 'pending_acceptance', 'assigned', 'in_progress', 'escalated'] } },
    orderBy: [{ created_at: 'asc' }],
    include: REQUEST_INCLUDE,
  })
}

type StaffTaskSummaryRow = { new_available: number; my_active: number; completed_today: number }

/**
 * Staff PRD §5 — the Home dashboard's three tallies, scoped to the caller's
 * own department(s) and own claimed work. All three counts hit `requests`,
 * so one round trip with conditional subqueries replaces three.
 */
export async function getStaffTaskSummary(hotelId: string, userId: string, departmentIds: string[]) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [row] = await prisma.$queryRaw<StaffTaskSummaryRow[]>`
    SELECT
      (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND department_id = ANY(${departmentIds}::uuid[]) AND status = 'pending')::int AS new_available,
      (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND assigned_to = ${userId}::uuid AND status IN ('pending_acceptance', 'assigned', 'in_progress'))::int AS my_active,
      (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND assigned_to = ${userId}::uuid AND status = 'completed' AND completed_at >= ${startOfDay})::int AS completed_today
  `

  return { newAvailable: row.new_available, myActive: row.my_active, completedToday: row.completed_today }
}

/**
 * Reception (or GM) logging a request on a guest's behalf — front-desk call-in
 * is a normal path alongside the guest app. roomId + departmentId are required;
 * guestId is optional since the `guests` model is intentionally lightweight (§9).
 */
export async function createRequest(hotelId: string, input: CreateRequestInput, actor: HotelSessionUser) {
  // roomId/departmentId are client-supplied ids — must be proven to belong
  // to this hotel before use, never trusted by format alone (PRD §25).
  await prisma.rooms.findFirstOrThrow({ where: { room_id: input.roomId, hotel_id: hotelId } })
  await prisma.departments.findFirstOrThrow({ where: { department_id: input.departmentId, hotel_id: hotelId } })

  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.requests.create({
      data: {
        hotel_id: hotelId,
        room_id: input.roomId,
        department_id: input.departmentId,
        request_type: input.requestType,
        priority: input.priority,
        notes: input.notes || null,
        status: 'pending',
      },
    })

    await tx.request_status_history.create({
      data: { request_id: created.request_id, from_status: null, to_status: 'pending', changed_by: actor.id },
    })

    await recordAudit(
      {
        actorId: actor.id,
        actorType: actor.userType,
        action: 'request.created',
        entityType: 'request',
        entityId: created.request_id,
        afterState: { request_type: created.request_type, room_id: created.room_id },
      },
      tx
    )

    return created
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: request.request_id }, include: REQUEST_INCLUDE })
}

/**
 * Assign or reassign — used for both the initial Reception -> Manager/Staff
 * hop and any later reassignment (PRD §19 routing). The initial hop (moving
 * out of `pending`) sets status to `pending_acceptance`, not `assigned`
 * directly — the assignee must accept or reject it (see `acceptAssignment`/
 * `rejectAssignment`) before it can be started. A reassignment mid-flight
 * (the request is already `assigned`/`in_progress`/`escalated`) keeps the
 * current status as before — only the brand-new hand-off is gated, so
 * reassigning work already underway doesn't lose that progress.
 */
export async function assignRequest(hotelId: string, requestId: string, assigneeId: string, actor: HotelSessionUser) {
  const request = await prisma.requests.findFirstOrThrow({
    where: { request_id: requestId, hotel_id: hotelId },
    include: { departments: true },
  })
  await assertCanManageRequest(hotelId, request.department_id, actor)

  // assigneeId is client-supplied — prove hotel membership before trusting it.
  // Also blocks handing new work to a deactivated staff account (Staff PRD §19).
  const assignee = await prisma.users.findFirstOrThrow({ where: { user_id: assigneeId, hotel_id: hotelId } })
  if (assignee.status !== 'active') throw new ForbiddenError('That staff member is not active')

  if (request.departments) {
    const eligible = await prisma.user_departments.findUnique({
      where: { user_id_department_id: { user_id: assigneeId, department_id: request.departments.department_id } },
    })
    if (!eligible) throw new ForbiddenError('That person is not eligible for this department')
  }

  const nextStatus: request_status = request.status === 'pending' ? 'pending_acceptance' : request.status

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.requests.update({
      where: { request_id: requestId },
      data: {
        assigned_to: assigneeId,
        status: nextStatus,
        status_changed_at: nextStatus !== request.status ? new Date() : undefined,
      },
    })
    await tx.request_status_history.create({
      data: {
        request_id: requestId,
        from_status: request.status,
        to_status: nextStatus,
        to_assignee: assigneeId,
        changed_by: actor.id,
      },
    })
    return updated
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.assigned',
    entityType: 'request',
    entityId: requestId,
    beforeState: { assigned_to: request.assigned_to, status: request.status },
    afterState: { assigned_to: after.assigned_to, status: after.status },
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })
}

/**
 * Staff PRD §11 — self-service claim of an unassigned request, for a
 * Department Staff member (or anyone else eligible to work the department;
 * this isn't role-gated beyond the department-membership check itself, since
 * "can this person be assigned this task" is exactly what `user_departments`
 * already encodes). Distinct from `assignRequest`: no `assertCanManageRequest`
 * call, because the actor is claiming work for *themselves*, not directing
 * someone else's — and it must be race-safe, since multiple staff in the
 * same department can see the same pending request at once (Staff PRD §25's
 * 15-room scenario is exactly this: one staff member, several departments,
 * but the general case is several staff in one department).
 */
export async function acceptRequest(hotelId: string, requestId: string, actor: HotelSessionUser) {
  const request = await prisma.requests.findFirstOrThrow({ where: { request_id: requestId, hotel_id: hotelId } })

  if (!request.department_id) throw new ForbiddenError('This request has no department to accept it into')
  const eligible = await prisma.user_departments.findUnique({
    where: { user_id_department_id: { user_id: actor.id, department_id: request.department_id } },
  })
  if (!eligible) throw new ForbiddenError('You are not assigned to this request’s department')

  // Re-read from the DB, not the (up to 8h old) session — an account
  // deactivated mid-shift must stop being able to claim new work immediately.
  const self = await prisma.users.findFirstOrThrow({ where: { user_id: actor.id, hotel_id: hotelId } })
  if (self.status !== 'active') throw new ForbiddenError('Your account is not active')

  if (request.status !== 'pending') {
    throw new InvalidTransitionError('This request has already been claimed or is no longer available to accept')
  }

  const claimed = await prisma.$transaction(async (tx) => {
    // Conditional update: only succeeds if the request is still `pending` at
    // write time, so two staff racing to accept the same request can't both
    // win — the loser gets the "already claimed" error below, not a silently
    // overwritten assignment.
    const result = await tx.requests.updateMany({
      where: { request_id: requestId, hotel_id: hotelId, status: 'pending' },
      data: { assigned_to: actor.id, status: 'assigned', accepted_at: new Date(), status_changed_at: new Date() },
    })
    if (result.count === 0) return null

    await tx.request_status_history.create({
      data: {
        request_id: requestId,
        from_status: 'pending',
        to_status: 'assigned',
        to_assignee: actor.id,
        changed_by: actor.id,
      },
    })
    return true
  })

  if (!claimed) {
    throw new InvalidTransitionError('This request has already been claimed by someone else')
  }

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.accepted',
    entityType: 'request',
    entityId: requestId,
    beforeState: { status: 'pending', assigned_to: null },
    afterState: { status: 'assigned', assigned_to: actor.id },
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })
}

/**
 * The other half of the reception-directed hand-off `assignRequest` starts:
 * the assignee confirming they'll take it on. Distinct from `acceptRequest`
 * (that one is a staff member *choosing* an unclaimed request themselves,
 * which needs no separate confirmation step) — this is responding to work
 * someone else routed to them.
 */
export async function acceptAssignment(hotelId: string, requestId: string, actor: HotelSessionUser) {
  const request = await prisma.requests.findFirstOrThrow({ where: { request_id: requestId, hotel_id: hotelId } })

  if (request.assigned_to !== actor.id) throw new ForbiddenError('This assignment is not yours to accept')
  if (request.status !== 'pending_acceptance') {
    throw new InvalidTransitionError('This request is no longer waiting on your response')
  }

  await prisma.$transaction(async (tx) => {
    const now = new Date()
    await tx.requests.update({
      where: { request_id: requestId },
      data: { status: 'assigned', accepted_at: now, status_changed_at: now },
    })
    await tx.request_status_history.create({
      data: { request_id: requestId, from_status: 'pending_acceptance', to_status: 'assigned', changed_by: actor.id },
    })
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.assignment_accepted',
    entityType: 'request',
    entityId: requestId,
    beforeState: { status: 'pending_acceptance' },
    afterState: { status: 'assigned' },
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })
}

/**
 * Declining a hand-off — sends the request back to `pending`, unassigned,
 * so reception/the manager can route it to someone else, rather than
 * leaving it stuck against a person who won't work it. `reason` is
 * optional (see rejectAssignmentSchema) so this stays a quick action.
 */
export async function rejectAssignment(hotelId: string, requestId: string, reason: string | undefined, actor: HotelSessionUser) {
  const request = await prisma.requests.findFirstOrThrow({ where: { request_id: requestId, hotel_id: hotelId } })

  if (request.assigned_to !== actor.id) throw new ForbiddenError('This assignment is not yours to reject')
  if (request.status !== 'pending_acceptance') {
    throw new InvalidTransitionError('This request is no longer waiting on your response')
  }

  await prisma.$transaction(async (tx) => {
    await tx.requests.update({ where: { request_id: requestId }, data: { status: 'pending', assigned_to: null, status_changed_at: new Date() } })
    await tx.request_status_history.create({
      data: {
        request_id: requestId,
        from_status: 'pending_acceptance',
        to_status: 'pending',
        changed_by: actor.id,
        note: reason || null,
      },
    })
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.assignment_rejected',
    entityType: 'request',
    entityId: requestId,
    beforeState: { status: 'pending_acceptance', assigned_to: actor.id },
    afterState: { status: 'pending', assigned_to: null },
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })
}

/** Backs the staff-side assignment popup (layout-level, mirrors ReceptionAlertListener's polling signal) — every request handed to this person that they haven't responded to yet, oldest first so the popup queue drains in the order things arrived. */
export async function getMyPendingAssignments(hotelId: string, actor: HotelSessionUser) {
  return prisma.requests.findMany({
    where: { hotel_id: hotelId, assigned_to: actor.id, status: 'pending_acceptance' },
    orderBy: { created_at: 'asc' },
    include: REQUEST_INCLUDE,
  })
}

export async function updateRequestStatus(
  hotelId: string,
  requestId: string,
  input: UpdateRequestStatusInput,
  actor: HotelSessionUser
) {
  const request = await prisma.requests.findFirstOrThrow({ where: { request_id: requestId, hotel_id: hotelId } })
  await assertCanWorkRequest(hotelId, request, actor)

  if (request.status === 'pending_acceptance' && input.status !== 'cancelled') {
    throw new ForbiddenError('Accept or reject this assignment before changing its status')
  }
  if (!canTransition(REQUEST_TRANSITIONS, request.status, input.status)) {
    throw new ForbiddenError(`Cannot move a ${request.status} request to ${input.status}`)
  }

  const now = new Date()
  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.requests.update({
      where: { request_id: requestId },
      data: {
        status: input.status,
        started_at: input.status === 'in_progress' && !request.started_at ? now : undefined,
        completed_at: input.status === 'completed' ? now : undefined,
        cancelled_at: input.status === 'cancelled' ? now : undefined,
        status_changed_at: now,
      },
    })
    await tx.request_status_history.create({
      data: { request_id: requestId, from_status: request.status, to_status: input.status, changed_by: actor.id, note: input.note || null },
    })
    return updated
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.status_changed',
    entityType: 'request',
    entityId: requestId,
    beforeState: { status: request.status },
    afterState: { status: after.status },
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })
}

/**
 * urgency/recipient are folded into the stored `note` as structured text
 * rather than new columns (PRD §6 asks for "reason, urgency and recipient"
 * to be stated, not queried/filtered on in V1 — see department-manager-plan.md §7).
 */
export async function escalateRequest(hotelId: string, requestId: string, input: EscalateRequestInput, actor: HotelSessionUser) {
  const request = await prisma.requests.findFirstOrThrow({ where: { request_id: requestId, hotel_id: hotelId } })
  await assertCanManageRequest(hotelId, request.department_id, actor)

  const note = `[Urgency: ${input.urgency} | To: ${input.recipient === 'gm' ? 'Hotel Admin/GM' : 'Reception'}] ${input.reason}`

  const after = await prisma.$transaction(async (tx) => {
    const updated = await tx.requests.update({
      where: { request_id: requestId },
      data: { status: 'escalated', status_changed_at: new Date() },
    })
    await tx.request_status_history.create({
      data: { request_id: requestId, from_status: request.status, to_status: 'escalated', changed_by: actor.id, note },
    })
    return updated
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.escalated',
    entityType: 'request',
    entityId: requestId,
    beforeState: { status: request.status },
  })

  const full = await prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })

  // Best-effort: a notification failure must never fail the escalation
  // itself, which is the actual action the caller asked for.
  try {
    await sendPushToRecipient(hotelId, input.recipient, {
      title: input.urgency === 'urgent' ? 'Request escalated — urgent' : 'Request escalated',
      body: `${full.request_type} — Room ${full.rooms?.room_number ?? '?'}`,
      url: '/hotel/requests',
    })
  } catch (error) {
    console.error('[push] failed to send escalation notification', error)
  }

  return full
}

/**
 * A no-status-change history entry — covers both PRD §9's general "add
 * internal notes to coordinate" quick action and PRD §5's "keep unassigned
 * with a clear reason" case (an unassigned request has no assignee for
 * `assertCanWorkRequest` to match on `self`, so it falls through to the
 * manage-request check, which is exactly who should be making that call).
 */
export async function addRequestNote(hotelId: string, requestId: string, note: string, actor: HotelSessionUser) {
  const request = await prisma.requests.findFirstOrThrow({ where: { request_id: requestId, hotel_id: hotelId } })
  await assertCanWorkRequest(hotelId, request, actor)

  await prisma.request_status_history.create({
    data: { request_id: requestId, from_status: request.status, to_status: request.status, changed_by: actor.id, note },
  })

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'request.note_added',
    entityType: 'request',
    entityId: requestId,
  })

  return prisma.requests.findUniqueOrThrow({ where: { request_id: requestId }, include: REQUEST_INCLUDE })
}

/**
 * Scoped through the same department-isolation gate as `listRequests`/
 * `getRequestById` — a request's history is exactly as department-sensitive
 * as the request itself (Staff PRD Rule 3), so a Department Manager or
 * Department Staff caller can't read another department's timeline just by
 * knowing/guessing a `requestId`.
 */
export async function getRequestHistory(hotelId: string, requestId: string, actor: HotelSessionUser) {
  const scope = await resolveRequestScope(hotelId, actor)
  await prisma.requests.findFirstOrThrow({
    where: {
      request_id: requestId,
      hotel_id: hotelId,
      ...(scope.restricted ? { department_id: { in: scope.departmentIds } } : {}),
    },
  })
  return prisma.request_status_history.findMany({
    where: { request_id: requestId },
    orderBy: { changed_at: 'asc' },
    include: {
      users_request_status_history_changed_byTousers: { select: { full_name: true } },
      users_request_status_history_to_assigneeTousers: { select: { full_name: true } },
    },
  })
}

/** Assign/reassign/escalate: hotel_admin, Reception (hotel-wide), or the department's own manager. */
async function assertCanManageRequest(hotelId: string, departmentId: string | null, actor: HotelSessionUser) {
  if (actor.userType === 'hotel_admin') return

  const role = await prisma.roles.findUnique({ where: { role_id: actor.roleId } })
  if (role?.name === 'Reception') return
  if (role?.name === 'Department Manager' && departmentId) {
    const managed = await prisma.departments.findFirst({
      where: { hotel_id: hotelId, department_id: departmentId, manager_id: actor.id },
    })
    if (managed) return
  }
  throw new ForbiddenError('Not authorized to manage this request')
}

/** Status transitions (start/complete/cancel): the above, or the staff member the task is actually assigned to. */
async function assertCanWorkRequest(hotelId: string, request: { department_id: string | null; assigned_to: string | null }, actor: HotelSessionUser) {
  if (request.assigned_to === actor.id) return
  await assertCanManageRequest(hotelId, request.department_id, actor)
}
