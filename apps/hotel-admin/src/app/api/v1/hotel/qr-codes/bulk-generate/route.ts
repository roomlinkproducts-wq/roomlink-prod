import { NextRequest, NextResponse } from 'next/server'
import { requireHotelSession } from '@/server/require-hotel-session'
import { requireCanHotel } from '@/server/hotel-rbac'
import { toErrorResponse } from '@/server/api-error'
import { bulkGenerateQrCodes } from '@/server/services/qr-codes.service'
import { listRooms } from '@/server/services/rooms.service'
import { getHotelProfile } from '@/server/services/hotel-profile.service'
import { floorKey, groupByBuilding, groupByFloor } from '@/lib/floor'

/**
 * POST generates a QR for every room on one floor of one building (skipping
 * rooms that already have an active QR — see bulkGenerateQrCodes). The
 * building/floor selection is identified the same way the QR list UI groups
 * rooms client-side (effectiveBuildingName + normalizeFloor), so the two
 * never drift apart.
 */
export async function POST(req: NextRequest) {
  try {
    const { user } = await requireHotelSession(req)
    await requireCanHotel(user, 'hotel_qr_codes', 'create')

    const { searchParams } = new URL(req.url)
    const buildingParam = searchParams.get('building')
    const floorParam = searchParams.get('floor')
    if (buildingParam === null || floorParam === null) {
      return NextResponse.json({ error: 'building and floor are required' }, { status: 400 })
    }

    const [hotel, rooms] = await Promise.all([getHotelProfile(user.hotelId), listRooms(user.hotelId, {})])
    const mapped = rooms.map((r) => ({ room_id: r.room_id, floor: r.floor, building: r.buildings?.name ?? null }))

    const buildingGroup = groupByBuilding(mapped, hotel.name).find(
      (g) => g.building === buildingParam
    )
    if (!buildingGroup) {
      return NextResponse.json({ error: 'Building not found' }, { status: 404 })
    }

    const floorGroup = groupByFloor(buildingGroup.items).find((g) => floorKey(g.floor) === floorParam)
    if (!floorGroup) {
      return NextResponse.json({ error: 'Floor not found' }, { status: 404 })
    }

    const result = await bulkGenerateQrCodes(
      user.hotelId,
      floorGroup.items.map((r) => r.room_id),
      user
    )

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
