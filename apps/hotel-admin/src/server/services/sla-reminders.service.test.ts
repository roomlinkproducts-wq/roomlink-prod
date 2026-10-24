import { describe, it, expect, vi, beforeEach } from 'vitest'
import { acknowledgeReminders, maybeRunReminderSweep, runReminderSweep } from './sla-reminders.service'
import { ForbiddenError } from '@/server/hotel-rbac'

const mockPrisma = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  request_status_history: { createMany: vi.fn() },
  request_reminders: { updateMany: vi.fn(), findMany: vi.fn() },
  audit_logs: { create: vi.fn() },
}))
const mockPush = vi.hoisted(() => vi.fn())

vi.mock('@/server/db', () => ({ prisma: mockPrisma }))
vi.mock('@/server/push', () => ({ sendPushToRecipient: mockPush }))

const NOW = new Date('2026-09-29T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$queryRaw.mockResolvedValue([])
})

/** Prisma.sql template values, in order — lets the test check the cutoffs actually passed to SQL. */
function sqlValues(): unknown[] {
  const [, ...values] = mockPrisma.$queryRaw.mock.calls[0]
  return values
}

describe('runReminderSweep', () => {
  it('asks for requests open ≥30 min and not reminded in the last 30 min', async () => {
    await runReminderSweep('hotel-1', NOW)
    const values = sqlValues()
    expect(values).toContainEqual(new Date('2026-09-29T11:30:00Z'))
    expect(values).toContainEqual(['pending', 'pending_acceptance', 'assigned', 'in_progress', 'escalated'])
  })

  it('does nothing else when no request is due', async () => {
    expect(await runReminderSweep('hotel-1', NOW)).toEqual([])
    expect(mockPrisma.request_status_history.createMany).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('logs each new reminder on the request timeline and notifies reception', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { reminder_id: 'rm-1', request_id: 'req-1', sequence: 2, status_at_send: 'in_progress', open_minutes: 64, status_minutes: 41 },
    ])
    await runReminderSweep('hotel-1', NOW)

    expect(mockPrisma.request_status_history.createMany).toHaveBeenCalledWith({
      data: [
        {
          request_id: 'req-1',
          from_status: 'in_progress',
          to_status: 'in_progress',
          changed_by: null,
          changed_at: NOW,
          note: 'Reminder #2 sent to reception — open 64 min, 41 min in in progress',
        },
      ],
    })
    expect(mockPush).toHaveBeenCalledWith('hotel-1', 'reception', expect.objectContaining({ title: 'Request overdue' }))
  })

  it('still succeeds when the push notification fails', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      { reminder_id: 'rm-1', request_id: 'req-1', sequence: 1, status_at_send: 'pending', open_minutes: 30, status_minutes: 30 },
    ])
    mockPush.mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(runReminderSweep('hotel-1', NOW)).resolves.toHaveLength(1)
  })
})

describe('maybeRunReminderSweep', () => {
  it('runs at most once a minute per hotel and never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockPrisma.$queryRaw.mockRejectedValueOnce(new Error('db down'))
    await expect(maybeRunReminderSweep('hotel-throttle', NOW)).resolves.toBeUndefined()
    await maybeRunReminderSweep('hotel-throttle', new Date(NOW.getTime() + 59_000))
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1)
    await maybeRunReminderSweep('hotel-throttle', new Date(NOW.getTime() + 60_000))
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(2)
  })
})

describe('acknowledgeReminders', () => {
  it('is limited to Reception and Hotel Admin', async () => {
    await expect(
      acknowledgeReminders('hotel-1', null, { id: 'u', userType: 'hotel_staff', roleName: 'Department Staff' } as never)
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('acknowledges one request, scoped to the hotel', async () => {
    mockPrisma.request_reminders.updateMany.mockResolvedValue({ count: 2 })
    const actor = { id: 'u-1', userType: 'hotel_staff', roleName: 'Reception' } as never
    expect(await acknowledgeReminders('hotel-1', 'req-1', actor)).toBe(2)
    expect(mockPrisma.request_reminders.updateMany).toHaveBeenCalledWith({
      where: { hotel_id: 'hotel-1', acknowledged_at: null, request_id: 'req-1' },
      data: { acknowledged_by: 'u-1', acknowledged_at: expect.any(Date) },
    })
    expect(mockPrisma.audit_logs.create).toHaveBeenCalled()
  })
})
