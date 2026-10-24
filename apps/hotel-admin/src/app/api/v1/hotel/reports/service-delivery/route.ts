import { NextRequest, NextResponse } from 'next/server'
import { requireHotelSession } from '@/server/require-hotel-session'
import { toErrorResponse } from '@/server/api-error'
import { prisma } from '@/server/db'
import {
  getServiceDeliveryRows,
  normalizeFilters,
  requireHotelAdmin,
  summarizeServiceDelivery,
  toServiceDeliveryCsv,
} from '@/server/services/service-reports.service'

/** `?format=csv` downloads one row per request; otherwise returns the summarized report as JSON. */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireHotelSession(req)
    requireHotelAdmin(user)

    const hotel = await prisma.hotels.findUniqueOrThrow({ where: { hotel_id: user.hotelId }, select: { time_zone: true } })
    const params = req.nextUrl.searchParams
    const filters = normalizeFilters(
      { from: params.get('from'), to: params.get('to'), departmentId: params.get('department') },
      hotel.time_zone
    )
    const { rows } = await getServiceDeliveryRows(user.hotelId, filters)

    if (params.get('format') === 'csv') {
      return new NextResponse(toServiceDeliveryCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="service-delivery_${filters.from}_${filters.to}.csv"`,
        },
      })
    }

    return NextResponse.json({ filters, report: summarizeServiceDelivery(rows, filters, new Date()) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
