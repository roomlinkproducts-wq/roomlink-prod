import { prisma } from '@/server/db'
import { recordAudit } from '@/server/audit'
import { sendPushToRecipient } from '@/server/push'
import { OPEN_REQUEST_STATUSES, REMINDER_REPEAT_MINUTES, SERVICE_STANDARD_MINUTES } from '@/server/sla'
import { requireReceptionOrAdmin } from '@/server/services/reception.service'
import type { HotelSessionUser } from '@/server/require-hotel-session'
import type { request_status } from '@roomlink/db'

type CreatedReminder = {
  reminder_id: string
  request_id: string
  sequence: number
  status_at_send: request_status
  open_minutes: number
  status_minutes: number
}

/** Upper bound per sweep so a backlog (e.g. the first sweep after deploy) can't turn into one huge insert. */
const MAX_REMINDERS_PER_SWEEP = 50
const SWEEP_THROTTLE_MS = 60_000

/**
 * No scheduler exists in this deployment, so the sweep piggybacks on the
 * reception live-signal poll (every 3s per open Reception/hotel_admin tab).
 * This throttles it to at most once a minute per hotel per server instance;
 * correctness doesn't depend on it, since the (request_id, sequence) unique
 * index already makes concurrent sweeps from several instances harmless.
 */
const lastSweepAt = new Map<string, number>()

export async function maybeRunReminderSweep(hotelId: string, now: Date = new Date()): Promise<void> {
  const last = lastSweepAt.get(hotelId)
  if (last !== undefined && now.getTime() - last < SWEEP_THROTTLE_MS) return
  lastSweepAt.set(hotelId, now.getTime())
  try {
    await runReminderSweep(hotelId, now)
  } catch (error) {
    // Best-effort: the live-signal poll this rides on must keep working even if the sweep doesn't.
    console.error('[sla-reminders] sweep failed', error)
  }
}

/**
 * Creates the next reminder for every open request that has been open for at
 * least SERVICE_STANDARD_MINUTES and hasn't been reminded in the last
 * REMINDER_REPEAT_MINUTES. Each reminder also snapshots how long the request
 * has been open and how long it has sat in its current status, so reception
 * (and later the report) can see where it got stuck.
 */
export async function runReminderSweep(hotelId: string, now: Date = new Date()): Promise<CreatedReminder[]> {
  const overdueBefore = new Date(now.getTime() - SERVICE_STANDARD_MINUTES * 60_000)
  const repeatBefore = new Date(now.getTime() - REMINDER_REPEAT_MINUTES * 60_000)

  const created = await prisma.$queryRaw<CreatedReminder[]>`
    WITH due AS (
      SELECT r.request_id, r.hotel_id, r.status, r.created_at, r.status_changed_at,
             COALESCE(prev.max_sequence, 0) + 1 AS next_sequence
      FROM requests r
      LEFT JOIN LATERAL (
        SELECT MAX(rr.sequence) AS max_sequence, MAX(rr.sent_at) AS last_sent_at
        FROM request_reminders rr
        WHERE rr.request_id = r.request_id
      ) prev ON true
      WHERE r.hotel_id = ${hotelId}::uuid
        AND r.status::text = ANY(${[...OPEN_REQUEST_STATUSES]}::text[])
        AND r.created_at <= ${overdueBefore}
        AND (prev.last_sent_at IS NULL OR prev.last_sent_at <= ${repeatBefore})
      ORDER BY r.created_at ASC
      LIMIT ${MAX_REMINDERS_PER_SWEEP}
    )
    INSERT INTO request_reminders (hotel_id, request_id, sequence, status_at_send, open_minutes, status_minutes, sent_at)
    SELECT hotel_id, request_id, next_sequence, status,
           FLOOR(EXTRACT(EPOCH FROM (${now}::timestamptz - created_at)) / 60)::int,
           FLOOR(EXTRACT(EPOCH FROM (${now}::timestamptz - status_changed_at)) / 60)::int,
           ${now}::timestamptz
    FROM due
    ON CONFLICT (request_id, sequence) DO NOTHING
    RETURNING reminder_id, request_id, sequence, status_at_send, open_minutes, status_minutes
  `

  if (created.length === 0) return created

  // Shows up in each request's own timeline as a "System" entry. from = to
  // (no status change), the same shape addRequestNote uses.
  await prisma.request_status_history.createMany({
    data: created.map((r) => ({
      request_id: r.request_id,
      from_status: r.status_at_send,
      to_status: r.status_at_send,
      changed_by: null,
      changed_at: now,
      note: `Reminder #${r.sequence} sent to reception — open ${r.open_minutes} min, ${r.status_minutes} min in ${r.status_at_send.replace(/_/g, ' ')}`,
    })),
  })

  try {
    await sendPushToRecipient(hotelId, 'reception', {
      title: created.length === 1 ? 'Request overdue' : `${created.length} requests overdue`,
      body: `Open longer than ${SERVICE_STANDARD_MINUTES} minutes`,
      url: '/hotel/requests',
    })
  } catch (error) {
    console.error('[push] failed to send overdue reminder', error)
  }

  return created
}

export type OpenReminder = {
  reminderId: string
  requestId: string
  sequence: number
  requestType: string
  roomNumber: string | null
  departmentName: string | null
  status: request_status
  createdAt: Date
  statusChangedAt: Date
  sentAt: Date
}

/** Unacknowledged reminders for requests that are still open, newest reminder per request, most recently sent first. */
export async function listOpenReminders(hotelId: string): Promise<OpenReminder[]> {
  const rows = await prisma.request_reminders.findMany({
    where: {
      hotel_id: hotelId,
      acknowledged_at: null,
      requests: { status: { in: [...OPEN_REQUEST_STATUSES] } },
    },
    orderBy: { sent_at: 'desc' },
    take: MAX_REMINDERS_PER_SWEEP,
    include: {
      requests: {
        select: {
          request_type: true,
          status: true,
          created_at: true,
          status_changed_at: true,
          rooms: { select: { room_number: true } },
          departments: { select: { name: true } },
        },
      },
    },
  })

  const seen = new Set<string>()
  const reminders: OpenReminder[] = []
  for (const r of rows) {
    if (seen.has(r.request_id)) continue
    seen.add(r.request_id)
    reminders.push({
      reminderId: r.reminder_id,
      requestId: r.request_id,
      sequence: r.sequence,
      requestType: r.requests.request_type,
      roomNumber: r.requests.rooms?.room_number ?? null,
      departmentName: r.requests.departments?.name ?? null,
      status: r.requests.status,
      createdAt: r.requests.created_at,
      statusChangedAt: r.requests.status_changed_at,
      sentAt: r.sent_at,
    })
  }
  return reminders
}

/** Acknowledges every outstanding reminder for one request, or for the whole hotel when requestId is null ("acknowledge all"). */
export async function acknowledgeReminders(hotelId: string, requestId: string | null, actor: HotelSessionUser): Promise<number> {
  requireReceptionOrAdmin(actor)

  const { count } = await prisma.request_reminders.updateMany({
    where: { hotel_id: hotelId, acknowledged_at: null, ...(requestId ? { request_id: requestId } : {}) },
    data: { acknowledged_by: actor.id, acknowledged_at: new Date() },
  })

  if (count > 0) {
    await recordAudit({
      actorId: actor.id,
      actorType: actor.userType,
      action: 'request.reminder_acknowledged',
      entityType: 'request',
      entityId: requestId,
      afterState: { acknowledged: count },
    })
  }

  return count
}
