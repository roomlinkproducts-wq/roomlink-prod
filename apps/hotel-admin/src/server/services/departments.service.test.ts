import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setDepartmentManager } from './departments.service'

const mockPrisma = vi.hoisted(() => ({
  departments: { findFirstOrThrow: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), count: vi.fn() },
  users: { findFirstOrThrow: vi.fn(), update: vi.fn() },
  user_departments: { upsert: vi.fn() },
  audit_logs: { create: vi.fn() },
  onboarding_tracker: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}))

vi.mock('@/server/db', () => ({ prisma: mockPrisma }))
vi.mock('@/server/services/hotel-roles.service', () => ({
  getOrCreateHotelRole: vi.fn(async (_hotelId: string, name: string) => ({ role_id: `role-${name}` })),
}))

const ACTOR = { id: 'user-1', userType: 'hotel_admin' } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma))
  mockPrisma.departments.findFirstOrThrow.mockResolvedValue({ department_id: 'dept-1', hotel_id: 'hotel-1', manager_id: null })
  mockPrisma.departments.findUniqueOrThrow.mockResolvedValue({ department_id: 'dept-1' })
  mockPrisma.users.findFirstOrThrow.mockResolvedValue({ user_id: 'staff-1' })
})

describe('setDepartmentManager', () => {
  it('marks the Department Managers onboarding step complete when a manager is assigned', async () => {
    await setDepartmentManager('hotel-1', 'dept-1', 'staff-1', ACTOR)

    expect(mockPrisma.onboarding_tracker.updateMany).toHaveBeenCalledWith({
      where: { hotel_id: 'hotel-1', step_name: 'Department Managers', status: { not: 'complete' } },
      data: { status: 'complete', updated_at: expect.any(Date) },
    })
  })

  it('does not mark the step when a manager is removed', async () => {
    await setDepartmentManager('hotel-1', 'dept-1', null, ACTOR)

    expect(mockPrisma.onboarding_tracker.updateMany).not.toHaveBeenCalled()
  })
})
