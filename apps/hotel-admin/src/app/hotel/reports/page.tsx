import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlarmClock, BadgeCheck, ClipboardList, Hourglass, Reply, Timer } from 'lucide-react'
import { requireHotelPageSession } from '@/server/require-hotel-page-session'
import { prisma } from '@/server/db'
import { postLoginPath } from '@/lib/permissions'
import {
  getServiceDeliveryRows,
  localDate,
  normalizeFilters,
  summarizeServiceDelivery,
  type GroupStats,
  type ReportFilters,
} from '@/server/services/service-reports.service'
import { Card, CardHeader, CardBody, KpiCard, cn } from '@roomlink/ui'
import { DailyComplianceChart, HourlyDemandChart } from './charts'

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function mins(v: number | null) {
  if (v === null) return '—'
  if (v < 60) return `${Math.round(v)} min`
  const h = Math.floor(v / 60)
  const m = Math.round(v % 60)
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

function query(filters: ReportFilters, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ from: filters.from, to: filters.to, ...extra })
  if (filters.departmentId) q.set('department', filters.departmentId)
  return q.toString()
}

function addDays(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function GroupTable({ title, keyLabel, groups, standardMinutes }: { title: string; keyLabel: string; groups: GroupStats[]; standardMinutes: number }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-2.5 font-medium">{keyLabel}</th>
              <th className="px-5 py-2.5 text-right font-medium">Requests</th>
              <th className="px-5 py-2.5 text-right font-medium">Completed</th>
              <th className="px-5 py-2.5 text-right font-medium" title={`Completed within ${standardMinutes} min`}>
                On time
              </th>
              <th className="px-5 py-2.5 text-right font-medium">Median</th>
              <th className="px-5 py-2.5 text-right font-medium">90th pct</th>
              <th className="px-5 py-2.5 text-right font-medium">Reminded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            {groups.map((g) => (
              <tr key={g.key}>
                <td className="px-5 py-2.5 font-medium text-slate-900">{g.key}</td>
                <td className="px-5 py-2.5 text-right text-slate-700">{g.total}</td>
                <td className="px-5 py-2.5 text-right text-slate-700">{g.completed}</td>
                <td
                  className={cn(
                    'px-5 py-2.5 text-right font-medium',
                    g.compliance === null ? 'text-slate-400' : g.compliance < 0.8 ? 'text-red-600' : 'text-slate-900'
                  )}
                >
                  {pct(g.compliance)}
                </td>
                <td className="px-5 py-2.5 text-right text-slate-700">{mins(g.medianResolution)}</td>
                <td className="px-5 py-2.5 text-right text-slate-700">{mins(g.p90Resolution)}</td>
                <td className="px-5 py-2.5 text-right text-slate-700">{g.reminded}</td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-500">
                  No requests in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default async function ServiceReportPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; department?: string }
}) {
  const session = await requireHotelPageSession()
  // Hotel Admin (GM) only — the page, its API and the CSV export all enforce this.
  if (session.user.userType !== 'hotel_admin') redirect(postLoginPath(session.user.roleName ?? null))
  const hotelId = session.user.hotelId

  const [hotel, departments] = await Promise.all([
    prisma.hotels.findUniqueOrThrow({ where: { hotel_id: hotelId }, select: { time_zone: true } }),
    prisma.departments.findMany({ where: { hotel_id: hotelId }, select: { department_id: true, name: true }, orderBy: { name: 'asc' } }),
  ])
  const filters = normalizeFilters(
    { from: searchParams.from, to: searchParams.to, departmentId: searchParams.department },
    hotel.time_zone
  )
  const { rows } = await getServiceDeliveryRows(hotelId, filters)
  const report = summarizeServiceDelivery(rows, filters, new Date())
  const { totals } = report
  const today = localDate(hotel.time_zone)

  const presets = [
    { label: 'Today', from: today },
    { label: 'Last 7 days', from: addDays(today, -6) },
    { label: 'Last 30 days', from: addDays(today, -29) },
    { label: 'Last 90 days', from: addDays(today, -89) },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Service delivery report</h1>
        <p className="mt-1 text-sm text-slate-500">
          Standard: every request completed within {report.standardMinutes} minutes of being raised. Times in hotel time ({hotel.time_zone}).
        </p>
      </div>

      {/* Filters — one row, scoping everything below. Plain GET form so the URL is shareable/bookmarkable. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1">
          {presets.map((p) => {
            const active = filters.from === p.from && filters.to === today
            return (
              <Link
                key={p.label}
                href={`/hotel/reports?${query({ ...filters, from: p.from, to: today })}`}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm',
                  active ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                )}
              >
                {p.label}
              </Link>
            )
          })}
        </div>
        <form className="flex flex-wrap items-end gap-2" action="/hotel/reports">
          <label className="text-xs text-slate-500">
            From
            <input type="date" name="from" defaultValue={filters.from} max={today} className="mt-1 block rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-800" />
          </label>
          <label className="text-xs text-slate-500">
            To
            <input type="date" name="to" defaultValue={filters.to} max={today} className="mt-1 block rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-800" />
          </label>
          <label className="text-xs text-slate-500">
            Department
            <select name="department" defaultValue={filters.departmentId ?? ''} className="mt-1 block rounded-md border border-slate-200 px-2 py-1.5 text-sm text-slate-800">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.department_id} value={d.department_id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
            Apply
          </button>
        </form>
        <a
          href={`/api/v1/hotel/reports/service-delivery?${query(filters, { format: 'csv' })}`}
          className="ml-auto rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          Download CSV
        </a>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          label={`On time (≤${report.standardMinutes} min)`}
          value={pct(totals.compliance)}
          icon={BadgeCheck}
          tone={totals.compliance !== null && totals.compliance < 0.8 ? 'critical' : 'default'}
        />
        <KpiCard label="Requests" value={String(totals.total)} icon={ClipboardList} />
        <KpiCard label="Median response" value={mins(report.response.median)} icon={Reply} />
        <KpiCard label="Median to complete" value={mins(report.resolution.median)} icon={Timer} />
        <KpiCard label="90% completed within" value={mins(report.resolution.p90)} icon={Hourglass} />
        <KpiCard
          label="Open & overdue"
          value={String(totals.overdueOpen)}
          icon={AlarmClock}
          tone={totals.overdueOpen > 0 ? 'warning' : 'default'}
          href="/hotel/requests?status=__pending_or_assigned__"
        />
      </div>

      <p className="text-sm text-slate-600">
        {totals.completed} completed ({totals.onTime} on time, {totals.completed - totals.onTime} late) · {totals.open} still open ·{' '}
        {totals.cancelled} cancelled · {totals.remindedRequests} needed a reception reminder ({totals.reminders} reminders sent) ·{' '}
        {totals.escalated} escalated
      </p>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">Completed per day</h2>
          </CardHeader>
          <CardBody>
            <DailyComplianceChart data={report.daily} standardMinutes={report.standardMinutes} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-slate-900">Demand by hour of day</h2>
          </CardHeader>
          <CardBody>
            <HourlyDemandChart data={report.byHour} />
          </CardBody>
        </Card>
      </div>

      <GroupTable title="By department" keyLabel="Department" groups={report.byDepartment} standardMinutes={report.standardMinutes} />
      <GroupTable title="By service" keyLabel="Service" groups={report.byService} standardMinutes={report.standardMinutes} />
      <GroupTable title="By staff member (assignee)" keyLabel="Staff" groups={report.byStaff} standardMinutes={report.standardMinutes} />

      <Card className="overflow-hidden">
        <CardHeader>
          <h2 className="text-sm font-semibold text-slate-900">Longest waits</h2>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">Raised</th>
                <th className="px-5 py-2.5 font-medium">Room</th>
                <th className="px-5 py-2.5 font-medium">Service</th>
                <th className="px-5 py-2.5 font-medium">Department</th>
                <th className="px-5 py-2.5 font-medium">Assignee</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.slowest.map((r) => (
                <tr key={r.requestId}>
                  <td className="px-5 py-2.5 text-slate-600">
                    {r.createdAt.toLocaleString('en-GB', { timeZone: hotel.time_zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-5 py-2.5 font-medium text-slate-900">{r.roomNumber ?? '—'}</td>
                  <td className="px-5 py-2.5 text-slate-700">{r.requestType}</td>
                  <td className="px-5 py-2.5 text-slate-600">{r.departmentName ?? '—'}</td>
                  <td className="px-5 py-2.5 text-slate-600">{r.staffName ?? '—'}</td>
                  <td className="px-5 py-2.5 text-slate-600">{r.status === 'completed' ? 'Completed' : `Open (${r.status.replace(/_/g, ' ')})`}</td>
                  <td className="px-5 py-2.5 text-right font-medium tabular-nums text-slate-900">{mins(r.minutes)}</td>
                </tr>
              ))}
              {report.slowest.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-500">
                    No requests in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
