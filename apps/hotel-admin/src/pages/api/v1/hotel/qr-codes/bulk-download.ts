import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from 'next-auth'
import JSZip from 'jszip'
import { authOptions } from '@/server/auth'
import { HOTEL_PORTAL_USER_TYPES, HotelPortalUserType } from '@/lib/permissions'
import { canHotel } from '@/server/hotel-rbac'
import type { HotelSessionUser } from '@/server/require-hotel-session'
import { listActiveQrCodesForHotel, buildRoomQrUrl } from '@/server/services/qr-codes.service'
import { getHotelProfile } from '@/server/services/hotel-profile.service'
import { generateRoomQrCardImage } from '@/server/services/qr-card-image.service'
import { floorKey, floorLabel, groupByBuilding, groupByFloor } from '@/lib/floor'

/**
 * Pages Router, same reason as card-image.ts: this route calls
 * generateRoomQrCardImage, which depends on sharp, and sharp's platform
 * binary doesn't get bundled by Vercel's build tracer under the App Router
 * in this Next.js version.
 */
function sanitizeFilenamePart(value: string) {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'Unknown'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const session = await getServerSession(req, res, authOptions)
  const userType = session?.user?.userType
  const hotelId = session?.user?.hotelId
  if (!session?.user || !userType || !HOTEL_PORTAL_USER_TYPES.includes(userType as HotelPortalUserType) || !hotelId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const user: HotelSessionUser = {
    id: session.user.id,
    userType: userType as HotelPortalUserType,
    roleId: session.user.roleId,
    roleName: session.user.roleName ?? null,
    hotelId,
  }

  if (!(await canHotel(user, 'hotel_qr_codes', 'view'))) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const buildingParam = req.query.building
  const floorParam = req.query.floor
  if (typeof buildingParam !== 'string' || typeof floorParam !== 'string') {
    res.status(400).json({ error: 'building and floor are required' })
    return
  }

  try {
    const [hotel, activeQrCodes] = await Promise.all([
      getHotelProfile(user.hotelId),
      listActiveQrCodesForHotel(user.hotelId),
    ])

    const mapped = activeQrCodes.map((qr) => ({
      qr_code_id: qr.qr_code_id,
      code_value: qr.code_value,
      room_number: qr.rooms.room_number,
      floor: qr.rooms.floor,
      building: qr.rooms.buildings?.name ?? null,
    }))

    const buildingGroup = groupByBuilding(mapped, hotel.name).find((g) => g.building === buildingParam)
    if (!buildingGroup) {
      res.status(404).json({ error: 'Building not found' })
      return
    }

    const floorGroup = groupByFloor(buildingGroup.items).find((g) => floorKey(g.floor) === floorParam)
    if (!floorGroup || floorGroup.items.length === 0) {
      res.status(404).json({ error: 'No generated QR codes found for that floor yet' })
      return
    }

    const zip = new JSZip()
    for (const qr of floorGroup.items) {
      const png = await generateRoomQrCardImage({
        hotelName: hotel.name,
        roomNumber: qr.room_number,
        qrPayload: buildRoomQrUrl(qr.code_value),
        receptionContact: hotel.reception_contact,
        roomServiceContact: hotel.room_service_contact,
      })
      zip.file(`room-${qr.room_number}-qr-card.png`, png)
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })

    const floorName = floorGroup.floor === null ? 'Unassigned' : floorLabel(floorGroup.floor)
    const zipFilename =
      [sanitizeFilenamePart(hotel.name), sanitizeFilenamePart(buildingGroup.building), `Floor-${sanitizeFilenamePart(floorName)}`, 'QR-Codes'].join(
        '-'
      ) + '.zip'

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(zipBuffer)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Something went wrong' })
  }
}
