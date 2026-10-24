import { prisma } from '@/server/db'
import { isAtSlaRisk } from '@/server/sla'
import { ForbiddenError } from '@/server/hotel-rbac'
import { listOpenReminders, maybeRunReminderSweep } from '@/server/services/sla-reminders.service'
import type { HotelSessionUser } from '@/server/require-hotel-session'

/**
 * The four functions below are hotel-wide aggregates gated, at the route
 * layer, by module flags (`hotel_requests`, `hotel_rooms`, `hotel_staff`,
 * `hotel_guest_sessions`) that Department Manager/Staff *also* hold — for
 * their own, differently-scoped existing screens (their Team page, their
 * request queue). The coarse grant alone isn't precise enough here: it
 * would let a Department Manager/Staff session reach a hotel-wide view
 * these functions were never meant to expose to them. This check is the
 * real gate; call it first, in every one of these functions.
 */
export function requireReceptionOrAdmin(user: HotelSessionUser) {
  if (user.userType === 'hotel_admin') return
  if (user.roleName === 'Reception') return
  throw new ForbiddenError('Reception access only')
}

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

type ReceptionKpiRow = {
  new_today: number
  unassigned: number
  in_progress: number
  escalated: number
  high_priority: number
  completed_today: number
  guests_in_house: number
}

/**
 * Reception PRD §5 — hotel-wide KPI row. Same shape as `getManagerQueueKpis`,
 * without a department filter. The 6 same-table counts collapse into one
 * round trip via conditional subqueries — this runs on every 20s dashboard
 * poll, so cutting round trips here matters more than usual.
 */
export async function getReceptionDashboard(hotelId: string, actor: HotelSessionUser) {
  requireReceptionOrAdmin(actor)
  const today = startOfToday()

  const [kpiRows, openWork, conversations] = await Promise.all([
    prisma.$queryRaw<ReceptionKpiRow[]>`
      SELECT
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND created_at >= ${today})::int AS new_today,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND status = 'pending')::int AS unassigned,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND status = 'in_progress')::int AS in_progress,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND status = 'escalated')::int AS escalated,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND priority IN ('high', 'urgent') AND status IN ('pending', 'pending_acceptance', 'assigned', 'in_progress'))::int AS high_priority,
        (SELECT COUNT(*) FROM requests WHERE hotel_id = ${hotelId}::uuid AND status = 'completed' AND completed_at >= ${today})::int AS completed_today,
        (SELECT COUNT(*) FROM guest_sessions WHERE hotel_id = ${hotelId}::uuid AND status = 'active')::int AS guests_in_house
    `,
    prisma.requests.findMany({
      where: { hotel_id: hotelId, status: { in: ['pending', 'pending_acceptance', 'assigned', 'in_progress'] } },
      select: { priority: true, created_at: true },
    }),
    prisma.conversations.findMany({
      where: { hotel_id: hotelId },
      select: { messages: { orderBy: { sent_at: 'desc' }, take: 1, select: { sender_type: true } } },
    }),
  ])
  const kpis = kpiRows[0]

  const slaAtRisk = openWork.filter((r) => isAtSlaRisk(r.priority, r.created_at)).length
  const unreadMessages = conversations.filter((c) => c.messages[0]?.sender_type === 'guest').length

  return {
    newToday: kpis.new_today,
    unassigned: kpis.unassigned,
    inProgress: kpis.in_progress,
    escalated: kpis.escalated,
    highPriority: kpis.high_priority,
    completedToday: kpis.completed_today,
    guestsInHouse: kpis.guests_in_house,
    slaAtRisk,
    unreadMessages,
  }
}

/**
 * Reception PRD §22 — monitoring only, hotel-wide, one row per department.
 *
 * Fires 3 queries total (grouped/aggregated across all departments at once)
 * instead of 4 per department — a hotel with N enabled departments used to
 * mean 4N concurrent queries here, fired on every 20s dashboard poll.
 */
export async function getDepartmentMonitoring(hotelId: string, actor: HotelSessionUser) {
  requireReceptionOrAdmin(actor)
  const departments = await prisma.departments.findMany({ where: { hotel_id: hotelId, is_enabled: true }, orderBy: { name: 'asc' } })
  if (departments.length === 0) return []

  const departmentIds = departments.map((d) => d.department_id)

  const [openStatusCounts, completedTodayCounts, openWork] = await Promise.all([
    prisma.requests.groupBy({
      by: ['department_id', 'status'],
      where: { hotel_id: hotelId, department_id: { in: departmentIds }, status: { in: ['pending', 'in_progress'] } },
      _count: true,
    }),
    prisma.requests.groupBy({
      by: ['department_id'],
      where: {
        hotel_id: hotelId,
        department_id: { in: departmentIds },
        status: 'completed',
        completed_at: { gte: startOfToday() },
      },
      _count: true,
    }),
    prisma.requests.findMany({
      where: { hotel_id: hotelId, department_id: { in: departmentIds }, status: { in: ['pending', 'pending_acceptance', 'assigned', 'in_progress'] } },
      select: { department_id: true, priority: true, created_at: true },
    }),
  ])

  const newCountByDept = new Map<string, number>()
  const inProgressByDept = new Map<string, number>()
  for (const row of openStatusCounts) {
    if (!row.department_id) continue
    if (row.status === 'pending') newCountByDept.set(row.department_id, row._count)
    if (row.status === 'in_progress') inProgressByDept.set(row.department_id, row._count)
  }

  const completedTodayByDept = new Map<string, number>()
  for (const row of completedTodayCounts) {
    if (row.department_id) completedTodayByDept.set(row.department_id, row._count)
  }

  const delayedByDept = new Map<string, number>()
  for (const r of openWork) {
    if (!r.department_id || !isAtSlaRisk(r.priority, r.created_at)) continue
    delayedByDept.set(r.department_id, (delayedByDept.get(r.department_id) ?? 0) + 1)
  }

  return departments.map((dept) => ({
    department_id: dept.department_id,
    name: dept.name,
    newCount: newCountByDept.get(dept.department_id) ?? 0,
    inProgress: inProgressByDept.get(dept.department_id) ?? 0,
    completedToday: completedTodayByDept.get(dept.department_id) ?? 0,
    delayed: delayedByDept.get(dept.department_id) ?? 0,
  }))
}

/** Reception PRD §23 — limited operational view only (no confidential employee info). */
export async function getStaffStatus(hotelId: string, actor: HotelSessionUser) {
  requireReceptionOrAdmin(actor)
  const staff = await prisma.users.findMany({
    where: { hotel_id: hotelId, user_type: 'hotel_staff', roles: { name: { in: ['Department Staff', 'Department Manager'] } } },
    select: {
      user_id: true,
      full_name: true,
      status: true,
      user_departments: { include: { departments: { select: { name: true } } } },
      requests: { where: { status: { in: ['pending_acceptance', 'assigned', 'in_progress'] } }, select: { request_id: true } },
    },
    orderBy: { full_name: 'asc' },
  })

  return staff.map((s) => ({
    user_id: s.user_id,
    full_name: s.full_name,
    status: s.status,
    departments: s.user_departments.map((ud) => ud.departments.name),
    activeWorkload: s.requests.length,
  }))
}

/** Reception PRD §21 — room number/type/occupancy/active session/open requests. Not a PMS. */
export async function getRoomOverview(hotelId: string, actor: HotelSessionUser) {
  requireReceptionOrAdmin(actor)
  const rooms = await prisma.rooms.findMany({
    where: { hotel_id: hotelId },
    orderBy: [{ floor: 'asc' }, { room_number: 'asc' }],
    include: {
      room_types: { select: { name: true } },
      buildings: { select: { name: true } },
      guest_sessions: {
        where: { status: 'active' },
        take: 1,
        orderBy: { issued_at: 'desc' },
        include: { guests: { select: { full_name: true } } },
      },
      requests: { where: { status: { in: ['pending', 'pending_acceptance', 'assigned', 'in_progress', 'escalated'] } }, select: { request_id: true } },
    },
  })

  return rooms.map((r) => ({
    room_id: r.room_id,
    room_number: r.room_number,
    floor: r.floor,
    building: r.buildings?.name ?? null,
    status: r.status,
    roomType: r.room_types?.name ?? null,
    occupied: r.guest_sessions.length > 0,
    activeGuestSessionId: r.guest_sessions[0]?.session_id ?? null,
    guestName: r.guest_sessions[0]?.guests?.full_name ?? null,
    openRequests: r.requests.length,
  }))
}

/**
 * Backs the layout-level new-request/new-message/staff-activity sound alert
 * (foreground-only, mirrors the voice-call listener's own tradeoff).
 * Deliberately cheap — this polls far more often than the 20s dashboard
 * refresh — and returns the single newest row of each kind (by timestamp,
 * any status) rather than a count: a count alone can miss an arrival that
 * changes state between two polls (e.g. new + assigned cancel out), while
 * the newest row's id changes on every insert regardless of what happens to
 * it after.
 *
 * `latestStaffActivity` is the newest request_status_history row authored
 * by a Department Manager/Staff — i.e. something reception didn't just do
 * themselves — across the hotel: an assignment accepted/rejected, or a
 * status change (started/completed/etc.) on any request. Scoped by role
 * name rather than a "changed by someone other than me" check, since
 * several reception users can be logged in at once and each should still
 * see the alert for actions taken by staff, but never for reception's own.
 */
export async function getNewestRequestSignal(hotelId: string, actor: HotelSessionUser) {
  requireReceptionOrAdmin(actor)
  // This poll is the only thing that runs on a timer here, so it also drives
  // the overdue-reminder sweep (throttled inside; see sla-reminders.service.ts).
  await maybeRunReminderSweep(hotelId)
  const [latestRequest, latestGuestMessage, latestStaffActivity, overdueReminders] = await Promise.all([
    prisma.requests.findFirst({
      where: { hotel_id: hotelId },
      orderBy: { created_at: 'desc' },
      select: {
        request_id: true,
        request_type: true,
        priority: true,
        rooms: { select: { room_number: true } },
      },
    }),
    // Same "unread" convention as listConversations (conversations.service.ts):
    // no read-state field in the schema, so the newest guest-sent message
    // across the hotel's conversations stands in for "a guest chat needs attention".
    prisma.messages.findFirst({
      where: { sender_type: 'guest', conversations: { hotel_id: hotelId } },
      orderBy: { sent_at: 'desc' },
      select: {
        message_id: true,
        conversation_id: true,
        conversations: { select: { rooms: { select: { room_number: true } } } },
      },
    }),
    prisma.request_status_history.findFirst({
      where: {
        requests: { hotel_id: hotelId },
        users_request_status_history_changed_byTousers: { roles: { name: { in: ['Department Manager', 'Department Staff'] } } },
      },
      orderBy: { changed_at: 'desc' },
      select: {
        history_id: true,
        from_status: true,
        to_status: true,
        requests: { select: { request_type: true, rooms: { select: { room_number: true } } } },
        users_request_status_history_changed_byTousers: { select: { full_name: true } },
      },
    }),
    listOpenReminders(hotelId),
  ])

  return {
    latestRequestId: latestRequest?.request_id ?? null,
    requestType: latestRequest?.request_type ?? null,
    priority: latestRequest?.priority ?? null,
    roomNumber: latestRequest?.rooms?.room_number ?? null,
    latestGuestMessageId: latestGuestMessage?.message_id ?? null,
    latestGuestMessageConversationId: latestGuestMessage?.conversation_id ?? null,
    latestGuestMessageRoomNumber: latestGuestMessage?.conversations.rooms?.room_number ?? null,
    latestStaffActivityId: latestStaffActivity?.history_id ?? null,
    staffActivityFromStatus: latestStaffActivity?.from_status ?? null,
    staffActivityToStatus: latestStaffActivity?.to_status ?? null,
    staffActivityRequestType: latestStaffActivity?.requests.request_type ?? null,
    staffActivityRoomNumber: latestStaffActivity?.requests.rooms?.room_number ?? null,
    staffActivityStaffName: latestStaffActivity?.users_request_status_history_changed_byTousers?.full_name ?? null,
    overdueReminders,
  }
}

/** Reception PRD §19 — search by room number / guest name / stay id / request id. Minimal fields only. */
export async function searchGuests(hotelId: string, query: string, actor: HotelSessionUser) {
  requireReceptionOrAdmin(actor)
  const q = query.trim()
  if (!q) return []

  const isUuidLike = /^[0-9a-f-]{8,}$/i.test(q)

  const sessions = await prisma.guest_sessions.findMany({
    where: {
      hotel_id: hotelId,
      OR: [
        ...(isUuidLike ? [{ session_id: q }, { requests: { some: { request_id: q } } }] : []),
        { rooms: { room_number: { contains: q, mode: 'insensitive' as const } } },
        { guests: { full_name: { contains: q, mode: 'insensitive' as const } } },
      ],
    },
    orderBy: { issued_at: 'desc' },
    take: 20,
    include: {
      rooms: { select: { room_number: true } },
      guests: { select: { full_name: true } },
    },
  })

  return Promise.all(
    sessions.map(async (s) => {
      const [activeRequests, recentConversation] = await Promise.all([
        prisma.requests.count({ where: { guest_session_id: s.session_id, status: { in: ['pending', 'assigned', 'in_progress', 'escalated'] } } }),
        prisma.conversations.findFirst({ where: { guest_session_id: s.session_id }, orderBy: { created_at: 'desc' } }),
      ])
      return {
        session_id: s.session_id,
        status: s.status,
        room: s.rooms.room_number,
        guestName: s.guests?.full_name ?? null,
        expiresAt: s.expires_at,
        activeRequests,
        hasRecentConversation: !!recentConversation,
      }
    })
  )
}
