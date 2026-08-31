import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateQrCode, bulkGenerateQrCodes, buildRoomQrUrl } from './qr-codes.service'
import { ConfigurationError } from '@/server/errors'

const mockPrisma = vi.hoisted(() => ({
  rooms: { findFirstOrThrow: vi.fn(), findMany: vi.fn() },
  qr_codes: { updateMany: vi.fn(), create: vi.fn() },
  audit_logs: { create: vi.fn() },
  onboarding_tracker: { updateMany: vi.fn() },
}))

vi.mock('@/server/db', () => ({ prisma: mockPrisma }))

const ACTOR = { id: 'user-1', userType: 'hotel_admin' } as never

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.rooms.findFirstOrThrow.mockResolvedValue({ room_id: 'room-1', hotel_id: 'hotel-1' })
  mockPrisma.qr_codes.create.mockResolvedValue({ qr_code_id: 'qr-1', code_value: 'abc123' })
})

describe('generateQrCode', () => {
  it('deactivates any existing active QR for the room before creating a new one', async () => {
    await generateQrCode('hotel-1', 'room-1', ACTOR)

    expect(mockPrisma.qr_codes.updateMany).toHaveBeenCalledWith({
      where: { room_id: 'room-1', is_active: true },
      data: { is_active: false },
    })
    const updateManyOrder = mockPrisma.qr_codes.updateMany.mock.invocationCallOrder[0]
    const createOrder = mockPrisma.qr_codes.create.mock.invocationCallOrder[0]
    expect(updateManyOrder).toBeLessThan(createOrder)
  })

  it('generates a fresh opaque code_value for the new QR', async () => {
    await generateQrCode('hotel-1', 'room-1', ACTOR)
    const createArgs = mockPrisma.qr_codes.create.mock.calls[0][0]
    expect(createArgs.data.code_value).toMatch(/^[0-9a-f]{32}$/)
    expect(createArgs.data.room_id).toBe('room-1')
  })
})

describe('bulkGenerateQrCodes', () => {
  it('only generates for rooms that do not already have an active QR', async () => {
    mockPrisma.rooms.findMany.mockResolvedValue([
      { room_id: 'room-1', qr_codes: [] },
      { room_id: 'room-2', qr_codes: [{ qr_code_id: 'qr-existing' }] },
      { room_id: 'room-3', qr_codes: [] },
    ])

    const result = await bulkGenerateQrCodes('hotel-1', ['room-1', 'room-2', 'room-3'], ACTOR)

    expect(mockPrisma.rooms.findFirstOrThrow).toHaveBeenCalledTimes(2)
    expect(mockPrisma.rooms.findFirstOrThrow).toHaveBeenCalledWith({ where: { room_id: 'room-1', hotel_id: 'hotel-1' } })
    expect(mockPrisma.rooms.findFirstOrThrow).toHaveBeenCalledWith({ where: { room_id: 'room-3', hotel_id: 'hotel-1' } })
    expect(result).toEqual({ generated: 2, skipped: 1 })
  })
})

describe('buildRoomQrUrl / getGuestAppUrl', () => {
  const original = process.env.NEXT_PUBLIC_APP_URL

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = original
  })

  it('builds an https link to the guest app carrying only the opaque code_value', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://guest.roomlink.example'
    expect(buildRoomQrUrl('abc123')).toBe('https://guest.roomlink.example/r/abc123')
  })

  it('normalizes a trailing slash on the configured base URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://guest.roomlink.example/'
    expect(buildRoomQrUrl('abc123')).toBe('https://guest.roomlink.example/r/abc123')
  })

  it('throws a ConfigurationError instead of building a broken URL when unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(() => buildRoomQrUrl('abc123')).toThrow(ConfigurationError)
  })

  it('throws a ConfigurationError instead of building a broken URL when empty', () => {
    process.env.NEXT_PUBLIC_APP_URL = '   '
    expect(() => buildRoomQrUrl('abc123')).toThrow(ConfigurationError)
  })

  it('throws a ConfigurationError for a malformed URL rather than crashing', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'not-a-url'
    expect(() => buildRoomQrUrl('abc123')).toThrow(ConfigurationError)
  })
})
