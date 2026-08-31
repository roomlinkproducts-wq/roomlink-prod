import { requireHotelPageSession } from '@/server/require-hotel-page-session'
import { listRooms } from '@/server/services/rooms.service'
import { SectionTabs } from '@/components/layout/section-tabs'
import { QrList } from './qr-list'

export default async function QrCodesPage() {
  const session = await requireHotelPageSession()
  const rooms = await listRooms(session.user.hotelId, {})

  return (
    <div className="space-y-5">
      <SectionTabs section="hotel" />
      <h1 className="text-xl font-semibold text-slate-900">QR Codes</h1>
      <QrList
        hotelName={session.user.hotelName ?? 'this hotel'}
        rooms={rooms.map((r) => ({
          room_id: r.room_id,
          room_number: r.room_number,
          floor: r.floor,
          building: r.buildings?.name ?? null,
          status: r.status,
          qr_codes: r.qr_codes.map((q) => ({
            qr_code_id: q.qr_code_id,
            is_active: q.is_active,
            installed_at: q.installed_at ? q.installed_at.toISOString() : null,
          })),
        }))}
      />
    </div>
  )
}
