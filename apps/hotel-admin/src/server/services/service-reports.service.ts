import { prisma } from '@/server/db'
import { ForbiddenError } from '@/server/hotel-rbac'
import { OPEN_REQUEST_STATUSES, SERVICE_STANDARD_MINUTES } from '@/server/sla'
import type { HotelSessionUser } from '@/server/require-hotel-session'

/** One request, flattened for reporting. Durations are in minutes; `localDay`/`localHour` are in the hotel's own time zone. */
export type ServiceDeliveryRow = {
  requestId: string
  requestType: string
  status: string
  priority: string
  departmentName: string | null
  staffName: string | null
  roomNumber: string | null
  createdAt: Date
  completedAt: Date | null
  /** Raised → first action (accepted, started, or closed directly at the desk). */
  responseMinutes: number | null
  /** Raised → completed. */
  resolutionMinutes: number | null
  reminders: number
  escalated: boolean
  localDay: string
  localHour: number
}

export type ReportFilters = { from: string; to: string; departmentId: string | null }

export type DurationStats = { avg: number | null; median: number | null; p90: number | null }

export type GroupStats = {
  key: string
  total: number
  completed: number
  onTime: number
  compliance: number | null
  medianResolution: number | null
  p90Resolution: number | null
  reminded: number
}

export type ServiceDeliveryReport = {
  standardMinutes: number
  totals: {
    total: number
    completed: number
    cancelled: number
    open: number
    overdueOpen: number
    onTime: number
    compliance: number | null
    remindedRequests: number
    reminders: number
    escalated: number
  }
  response: DurationStats
  resolution: DurationStats
  daily: { day: string; total: number; completed: number; onTime: number; compliance: number | null }[]
  byHour: { hour: number; total: number; compliance: number | null; medianResolution: number | null }[]
  byDepartment: GroupStats[]
  byService: GroupStats[]
  byStaff: GroupStats[]
  slowest: (ServiceDeliveryRow & { minutes: number })[]
}

const MAX_RANGE_DAYS = 92
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPEN = new Set<string>(OPEN_REQUEST_STATUSES)

/** Service delivery reporting is a Hotel Admin (GM) function only. */
export function requireHotelAdmin(user: HotelSessionUser) {
  if (user.userType !== 'hotel_admin') throw new ForbiddenError('Hotel Admin access only')
}

/** Today's date (YYYY-MM-DD) as the hotel sees it. */
export function localDate(timeZone: string, at: Date = new Date()): string {
  // formatToParts, not format(): the 'en-CA' → YYYY-MM-DD shortcut depends on
  // the runtime's ICU data and yields MM/DD/YYYY on some Node builds.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000)
}

/** Defaults to the last 7 days (hotel-local), clamps silly/invalid input rather than erroring — this backs a GET page. */
export function normalizeFilters(
  input: { from?: string | null; to?: string | null; departmentId?: string | null },
  timeZone: string,
  now: Date = new Date()
): ReportFilters {
  const today = localDate(timeZone, now)
  let to = input.to && DATE_RE.test(input.to) ? input.to : today
  if (to > today) to = today
  let from = input.from && DATE_RE.test(input.from) ? input.from : addDays(to, -6)
  if (from > to) from = to
  if (daysBetween(from, to) > MAX_RANGE_DAYS - 1) from = addDays(to, -(MAX_RANGE_DAYS - 1))
  const departmentId = input.departmentId && UUID_RE.test(input.departmentId) ? input.departmentId : null
  return { from, to, departmentId }
}

type RawRow = {
  request_id: string
  request_type: string
  status: string
  priority: string
  department_name: string | null
  staff_name: string | null
  room_number: string | null
  created_at: Date
  completed_at: Date | null
  response_min: number | null
  resolution_min: number | null
  reminders: number
  escalated: boolean
  local_day: string
  local_hour: number
}

export async function getServiceDeliveryRows(hotelId: string, filters: ReportFilters): Promise<{ rows: ServiceDeliveryRow[]; timeZone: string }> {
  const hotel = await prisma.hotels.findUniqueOrThrow({ where: { hotel_id: hotelId }, select: { time_zone: true } })
  const tz = hotel.time_zone
  const toExclusive = addDays(filters.to, 1)

  // Day boundaries are the hotel's local midnights, converted to UTC in SQL
  // (`date::timestamp AT TIME ZONE tz`), so "Monday" means the hotel's Monday
  // regardless of where the server runs.
  const raw = await prisma.$queryRaw<RawRow[]>`
    SELECT
      r.request_id::text AS request_id,
      r.request_type,
      r.status::text AS status,
      r.priority::text AS priority,
      d.name AS department_name,
      u.full_name AS staff_name,
      rm.room_number,
      r.created_at,
      r.completed_at,
      (EXTRACT(EPOCH FROM (COALESCE(r.accepted_at, r.started_at, r.completed_at) - r.created_at)) / 60)::float8 AS response_min,
      (EXTRACT(EPOCH FROM (r.completed_at - r.created_at)) / 60)::float8 AS resolution_min,
      (SELECT COUNT(*) FROM request_reminders rr WHERE rr.request_id = r.request_id)::int AS reminders,
      EXISTS (
        SELECT 1 FROM request_status_history h
        WHERE h.request_id = r.request_id AND h.to_status = 'escalated' AND h.from_status IS DISTINCT FROM h.to_status
      ) AS escalated,
      to_char(r.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS local_day,
      EXTRACT(HOUR FROM r.created_at AT TIME ZONE ${tz})::int AS local_hour
    FROM requests r
    LEFT JOIN departments d ON d.department_id = r.department_id
    LEFT JOIN users u ON u.user_id = r.assigned_to
    LEFT JOIN rooms rm ON rm.room_id = r.room_id
    WHERE r.hotel_id = ${hotelId}::uuid
      AND r.created_at >= (${filters.from}::date)::timestamp AT TIME ZONE ${tz}
      AND r.created_at < (${toExclusive}::date)::timestamp AT TIME ZONE ${tz}
      AND (${filters.departmentId}::uuid IS NULL OR r.department_id = ${filters.departmentId}::uuid)
    ORDER BY r.created_at ASC
  `

  const rows = raw.map((r) => ({
    requestId: r.request_id,
    requestType: r.request_type,
    status: r.status,
    priority: r.priority,
    departmentName: r.department_name,
    staffName: r.staff_name,
    roomNumber: r.room_number,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    responseMinutes: r.response_min,
    resolutionMinutes: r.resolution_min,
    reminders: r.reminders,
    escalated: r.escalated,
    localDay: r.local_day,
    localHour: r.local_hour,
  }))
  return { rows, timeZone: tz }
}

export async function getServiceDeliveryReport(hotelId: string, filters: ReportFilters, actor: HotelSessionUser) {
  requireHotelAdmin(actor)
  const { rows } = await getServiceDeliveryRows(hotelId, filters)
  return summarizeServiceDelivery(rows, filters, new Date())
}

/** Nearest-rank percentile; `values` needn't be sorted. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

function durationStats(values: number[]): DurationStats {
  if (values.length === 0) return { avg: null, median: null, p90: null }
  return {
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    median: percentile(values, 50),
    p90: percentile(values, 90),
  }
}

const isOnTime = (r: ServiceDeliveryRow) =>
  r.status === 'completed' && r.resolutionMinutes !== null && r.resolutionMinutes <= SERVICE_STANDARD_MINUTES

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole
}

function groupStats(rows: ServiceDeliveryRow[], keyOf: (r: ServiceDeliveryRow) => string | null): GroupStats[] {
  const groups = new Map<string, ServiceDeliveryRow[]>()
  for (const r of rows) {
    const key = keyOf(r)
    if (key === null) continue
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  return Array.from(groups.entries())
    .map(([key, list]) => {
      const completed = list.filter((r) => r.status === 'completed')
      const onTime = completed.filter(isOnTime).length
      const resolutions = completed.map((r) => r.resolutionMinutes).filter((m): m is number => m !== null)
      return {
        key,
        total: list.length,
        completed: completed.length,
        onTime,
        compliance: ratio(onTime, completed.length),
        medianResolution: percentile(resolutions, 50),
        p90Resolution: percentile(resolutions, 90),
        reminded: list.filter((r) => r.reminders > 0).length,
      }
    })
    .sort((a, b) => b.total - a.total)
}

/**
 * "On time" = completed within SERVICE_STANDARD_MINUTES of being raised.
 * Compliance is on-time ÷ completed (cancelled and still-open requests
 * aren't in the denominator; still-open overdue ones are reported separately
 * as `overdueOpen` so they can't hide).
 */
export function summarizeServiceDelivery(rows: ServiceDeliveryRow[], filters: ReportFilters, now: Date): ServiceDeliveryReport {
  const completed = rows.filter((r) => r.status === 'completed')
  const open = rows.filter((r) => OPEN.has(r.status))
  const ageMinutes = (r: ServiceDeliveryRow) => (now.getTime() - r.createdAt.getTime()) / 60_000
  const onTime = completed.filter(isOnTime).length

  const days: string[] = []
  for (let d = filters.from; d <= filters.to; d = addDays(d, 1)) days.push(d)
  const daily = days.map((day) => {
    const list = rows.filter((r) => r.localDay === day)
    const done = list.filter((r) => r.status === 'completed')
    const ok = done.filter(isOnTime).length
    return { day, total: list.length, completed: done.length, onTime: ok, compliance: ratio(ok, done.length) }
  })

  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const list = rows.filter((r) => r.localHour === hour)
    const done = list.filter((r) => r.status === 'completed')
    const resolutions = done.map((r) => r.resolutionMinutes).filter((m): m is number => m !== null)
    return { hour, total: list.length, compliance: ratio(done.filter(isOnTime).length, done.length), medianResolution: percentile(resolutions, 50) }
  })

  const slowest = rows
    .filter((r) => r.status !== 'cancelled')
    .map((r) => ({ ...r, minutes: r.status === 'completed' ? r.resolutionMinutes ?? 0 : ageMinutes(r) }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 10)

  return {
    standardMinutes: SERVICE_STANDARD_MINUTES,
    totals: {
      total: rows.length,
      completed: completed.length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
      open: open.length,
      overdueOpen: open.filter((r) => ageMinutes(r) >= SERVICE_STANDARD_MINUTES).length,
      onTime,
      compliance: ratio(onTime, completed.length),
      remindedRequests: rows.filter((r) => r.reminders > 0).length,
      reminders: rows.reduce((sum, r) => sum + r.reminders, 0),
      escalated: rows.filter((r) => r.escalated).length,
    },
    response: durationStats(rows.map((r) => r.responseMinutes).filter((m): m is number => m !== null)),
    resolution: durationStats(completed.map((r) => r.resolutionMinutes).filter((m): m is number => m !== null)),
    daily,
    byHour,
    byDepartment: groupStats(rows, (r) => r.departmentName ?? 'No department'),
    byService: groupStats(rows, (r) => r.requestType),
    byStaff: groupStats(rows, (r) => r.staffName),
    slowest,
  }
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = value instanceof Date ? value.toISOString() : String(value)
  // Leading =,+,-,@ would be evaluated as a formula when opened in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10)

/** One line per request, for spreadsheet analysis beyond what the report page shows. */
export function toServiceDeliveryCsv(rows: ServiceDeliveryRow[]): string {
  const header = [
    'request_id',
    'created_at',
    'local_day',
    'local_hour',
    'room',
    'service',
    'department',
    'assigned_to',
    'priority',
    'status',
    'response_min',
    'resolution_min',
    'on_time',
    'reminders',
    'escalated',
  ]
  const lines = rows.map((r) =>
    [
      r.requestId,
      r.createdAt,
      r.localDay,
      r.localHour,
      r.roomNumber,
      r.requestType,
      r.departmentName,
      r.staffName,
      r.priority,
      r.status,
      round1(r.responseMinutes),
      round1(r.resolutionMinutes),
      r.status === 'completed' ? (isOnTime(r) ? 'yes' : 'no') : '',
      r.reminders,
      r.escalated ? 'yes' : 'no',
    ]
      .map(csvCell)
      .join(',')
  )
  return [header.join(','), ...lines].join('\r\n') + '\r\n'
}
