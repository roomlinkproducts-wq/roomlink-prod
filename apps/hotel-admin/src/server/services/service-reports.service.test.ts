import { describe, it, expect, vi } from 'vitest'
import {
  localDate,
  normalizeFilters,
  percentile,
  requireHotelAdmin,
  summarizeServiceDelivery,
  toServiceDeliveryCsv,
  type ServiceDeliveryRow,
} from './service-reports.service'
import { ForbiddenError } from '@/server/hotel-rbac'

vi.mock('@/server/db', () => ({ prisma: {} }))

const NOW = new Date('2026-09-29T12:00:00Z')
const FILTERS = { from: '2026-09-28', to: '2026-09-29', departmentId: null }

function row(overrides: Partial<ServiceDeliveryRow>): ServiceDeliveryRow {
  return {
    requestId: 'r',
    requestType: 'Towels',
    status: 'completed',
    priority: 'normal',
    departmentName: 'Housekeeping',
    staffName: 'Asha',
    roomNumber: '101',
    createdAt: new Date('2026-09-29T08:00:00Z'),
    completedAt: null,
    responseMinutes: 5,
    resolutionMinutes: 20,
    reminders: 0,
    escalated: false,
    localDay: '2026-09-29',
    localHour: 13,
    ...overrides,
  }
}

describe('percentile', () => {
  it('uses nearest rank and ignores input order', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([40, 10, 30, 20], 50)).toBe(20)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
    expect(percentile([7], 90)).toBe(7)
  })
})

describe('summarizeServiceDelivery', () => {
  it('counts on time as completed within 30 min, with compliance over completed requests only', () => {
    const report = summarizeServiceDelivery(
      [
        row({ requestId: 'a', resolutionMinutes: 30 }),
        row({ requestId: 'b', resolutionMinutes: 31, reminders: 1 }),
        row({ requestId: 'c', status: 'cancelled', resolutionMinutes: null }),
        row({ requestId: 'd', status: 'in_progress', resolutionMinutes: null, createdAt: new Date('2026-09-29T11:00:00Z'), reminders: 2 }),
        row({ requestId: 'e', status: 'pending', resolutionMinutes: null, responseMinutes: null, createdAt: new Date('2026-09-29T11:45:00Z') }),
      ],
      FILTERS,
      NOW
    )
    expect(report.totals).toMatchObject({
      total: 5,
      completed: 2,
      onTime: 1,
      compliance: 0.5,
      cancelled: 1,
      open: 2,
      overdueOpen: 1,
      remindedRequests: 2,
      reminders: 3,
    })
  })

  it('fills every day in the range, including empty ones', () => {
    const report = summarizeServiceDelivery([row({})], FILTERS, NOW)
    expect(report.daily).toEqual([
      { day: '2026-09-28', total: 0, completed: 0, onTime: 0, compliance: null },
      { day: '2026-09-29', total: 1, completed: 1, onTime: 1, compliance: 1 },
    ])
    expect(report.byHour).toHaveLength(24)
    expect(report.byHour[13]).toMatchObject({ total: 1, compliance: 1 })
  })

  it('groups by staff only for assigned requests and ranks slowest by resolution or current age', () => {
    const report = summarizeServiceDelivery(
      [
        row({ requestId: 'fast', resolutionMinutes: 10 }),
        row({ requestId: 'slow', resolutionMinutes: 90 }),
        row({ requestId: 'stuck', status: 'assigned', staffName: null, resolutionMinutes: null, createdAt: new Date('2026-09-29T10:00:00Z') }),
        row({ requestId: 'gone', status: 'cancelled', resolutionMinutes: null }),
      ],
      FILTERS,
      NOW
    )
    expect(report.byStaff.map((g) => [g.key, g.total])).toEqual([['Asha', 3]])
    expect(report.slowest.map((r) => [r.requestId, r.minutes])).toEqual([
      ['stuck', 120],
      ['slow', 90],
      ['fast', 10],
    ])
  })

  it('reports null stats (not zero) when nothing is completed', () => {
    const report = summarizeServiceDelivery([], FILTERS, NOW)
    expect(report.totals.compliance).toBeNull()
    expect(report.resolution).toEqual({ avg: null, median: null, p90: null })
  })
})

describe('normalizeFilters', () => {
  it('defaults to the last 7 days in the hotel time zone', () => {
    // 2026-09-29 20:00 UTC is already 30 Sep in India.
    const at = new Date('2026-09-29T20:00:00Z')
    expect(localDate('Asia/Kolkata', at)).toBe('2026-09-30')
    expect(normalizeFilters({}, 'Asia/Kolkata', at)).toEqual({ from: '2026-09-24', to: '2026-09-30', departmentId: null })
  })

  it('clamps future, reversed, and over-long ranges and drops a non-uuid department', () => {
    expect(normalizeFilters({ from: '2026-09-20', to: '2027-01-01', departmentId: "x' OR 1=1" }, 'UTC', NOW)).toEqual({
      from: '2026-09-20',
      to: '2026-09-29',
      departmentId: null,
    })
    expect(normalizeFilters({ from: '2026-09-29', to: '2026-09-01' }, 'UTC', NOW).from).toBe('2026-09-01')
    expect(normalizeFilters({ from: '2025-01-01', to: '2026-09-29' }, 'UTC', NOW).from).toBe('2026-06-30')
  })
})

describe('toServiceDeliveryCsv', () => {
  it('quotes commas and neutralizes spreadsheet formulas', () => {
    const csv = toServiceDeliveryCsv([row({ requestType: '=HYPERLINK("x")', roomNumber: '1,2' })])
    const [, line] = csv.trim().split('\r\n')
    expect(line).toContain(`"'=HYPERLINK(""x"")"`)
    expect(line).toContain('"1,2"')
    expect(line).toContain(',yes,0,no')
  })
})

describe('requireHotelAdmin', () => {
  it('rejects every non-admin role', () => {
    expect(() => requireHotelAdmin({ userType: 'hotel_staff', roleName: 'Reception' } as never)).toThrow(ForbiddenError)
    expect(() => requireHotelAdmin({ userType: 'hotel_admin' } as never)).not.toThrow()
  })
})
