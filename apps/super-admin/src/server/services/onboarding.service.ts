import { prisma } from '@/server/db'

export type OnboardingRow = {
  hotelId: string
  hotelName: string
  status: string
  percentComplete: number
  currentStep: string | null
  lastActivity: Date | null
  daysSinceActivity: number | null
  implementationOwner: string | null
}

const STALLED_THRESHOLD_HOURS = 48

export async function listOnboardingStatus(): Promise<OnboardingRow[]> {
  const hotels = await prisma.hotels.findMany({
    // 'trial' is excluded: Go Live flips onboarding → trial, so a trial hotel is already live.
    where: { status: { in: ['onboarding', 'pending'] } },
    orderBy: { created_at: 'desc' },
    include: {
      onboarding_tracker: { orderBy: { step_order: 'asc' } },
      users_hotels_implementation_owner_idTousers: { select: { full_name: true } },
    },
  })

  return hotels.map((hotel) => {
    const steps = hotel.onboarding_tracker
    const total = steps.length
    const completed = steps.filter((s) => s.status === 'complete').length
    const currentStep = steps.find((s) => s.status !== 'complete')
    const lastActivity = steps.reduce<Date | null>(
      (latest, s) => (!latest || s.updated_at > latest ? s.updated_at : latest),
      null
    )
    const daysSinceActivity = lastActivity
      ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
      : null

    return {
      hotelId: hotel.hotel_id,
      hotelName: hotel.name,
      status: hotel.status,
      percentComplete: total ? Math.round((completed / total) * 100) : 0,
      currentStep: currentStep?.step_name ?? (total ? 'Go Live' : null),
      lastActivity,
      daysSinceActivity,
      implementationOwner: hotel.users_hotels_implementation_owner_idTousers?.full_name ?? null,
    }
  })
}

export function isStalled(row: OnboardingRow) {
  return row.daysSinceActivity !== null && row.daysSinceActivity * 24 >= STALLED_THRESHOLD_HOURS
}
