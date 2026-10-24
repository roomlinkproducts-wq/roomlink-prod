import { prisma } from '@/server/db'
import { recordAudit } from '@/server/audit'
import type { HotelSessionUser } from '@/server/require-hotel-session'

export async function listOnboardingSteps(hotelId: string) {
  return prisma.onboarding_tracker.findMany({
    where: { hotel_id: hotelId },
    orderBy: { step_order: 'asc' },
  })
}

/**
 * Called by each domain page (profile, legal, departments, …) once it saves
 * something meaningful — not a manual checklist the GM ticks by hand. Safe
 * to call for a step_name that isn't tracked for this hotel (older demo
 * hotels seeded before a step existed) — it's a no-op then.
 */
export async function markStepComplete(hotelId: string, stepName: string) {
  await prisma.onboarding_tracker.updateMany({
    where: { hotel_id: hotelId, step_name: stepName, status: { not: 'complete' } },
    data: { status: 'complete', updated_at: new Date() },
  })
}

/**
 * "Go Live" is the terminal onboarding action, not a checklist row (PRD §8
 * step 12) — it flips the hotel out of pending/onboarding into trial/active.
 * V1 deliberately does not gate this on 100% step completion — the PRD says
 * not to force completion of optional sections unnecessarily.
 */
export async function goLive(hotelId: string, actor: HotelSessionUser) {
  const hotel = await prisma.hotels.findUniqueOrThrow({ where: { hotel_id: hotelId } })
  if (hotel.status !== 'pending' && hotel.status !== 'onboarding') {
    return hotel
  }

  const updated = await prisma.hotels.update({
    where: { hotel_id: hotelId },
    data: { status: 'trial' },
  })

  // "Review" has no domain page of its own — confirming Go Live is the review.
  await markStepComplete(hotelId, 'Review')

  await recordAudit({
    actorId: actor.id,
    actorType: actor.userType,
    action: 'hotel.go_live',
    entityType: 'hotel',
    entityId: hotelId,
    beforeState: { status: hotel.status },
    afterState: { status: updated.status },
  })

  return updated
}
