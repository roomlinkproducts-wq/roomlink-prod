import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireHotelSession } from '@/server/require-hotel-session'
import { toErrorResponse } from '@/server/api-error'
import { uuid } from '@/server/validation/common'
import { acknowledgeReminders } from '@/server/services/sla-reminders.service'

/** `requestId` omitted/null acknowledges every outstanding reminder in the hotel ("Acknowledge all"). */
const ackSchema = z.object({ requestId: uuid.nullable().optional() })

export async function POST(req: NextRequest) {
  try {
    const { user } = await requireHotelSession(req)
    const input = ackSchema.parse(await req.json().catch(() => ({})))

    const acknowledged = await acknowledgeReminders(user.hotelId, input.requestId ?? null, user)
    return NextResponse.json({ acknowledged })
  } catch (error) {
    return toErrorResponse(error)
  }
}
