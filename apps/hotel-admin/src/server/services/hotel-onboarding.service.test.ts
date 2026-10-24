import { describe, it, expect, vi, beforeEach } from 'vitest'
import { goLive } from './hotel-onboarding.service'

const mockPrisma = vi.hoisted(() => ({
  hotels: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
  audit_logs: { create: vi.fn() },
  onboarding_tracker: { updateMany: vi.fn() },
}))

vi.mock('@/server/db', () => ({ prisma: mockPrisma }))

const ACTOR = { id: 'user-1', userType: 'hotel_admin' } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.hotels.update.mockResolvedValue({ hotel_id: 'hotel-1', status: 'trial' })
})

describe('goLive', () => {
  it('flips an onboarding hotel to trial and marks the Review step complete', async () => {
    mockPrisma.hotels.findUniqueOrThrow.mockResolvedValue({ hotel_id: 'hotel-1', status: 'onboarding' })

    await goLive('hotel-1', ACTOR)

    expect(mockPrisma.hotels.update).toHaveBeenCalledWith({ where: { hotel_id: 'hotel-1' }, data: { status: 'trial' } })
    expect(mockPrisma.onboarding_tracker.updateMany).toHaveBeenCalledWith({
      where: { hotel_id: 'hotel-1', step_name: 'Review', status: { not: 'complete' } },
      data: { status: 'complete', updated_at: expect.any(Date) },
    })
  })

  it('is a no-op for a hotel that is already live', async () => {
    mockPrisma.hotels.findUniqueOrThrow.mockResolvedValue({ hotel_id: 'hotel-1', status: 'active' })

    await goLive('hotel-1', ACTOR)

    expect(mockPrisma.hotels.update).not.toHaveBeenCalled()
    expect(mockPrisma.onboarding_tracker.updateMany).not.toHaveBeenCalled()
  })
})
