'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, BellOff, ClipboardList, MessageSquareText, UserCheck, X } from 'lucide-react'
import { OverdueReminderPanel, type OverdueReminder } from './overdue-reminder-panel'

type Signal = {
  latestRequestId: string | null
  requestType: string | null
  priority: string | null
  roomNumber: string | null
  latestGuestMessageId: string | null
  latestGuestMessageConversationId: string | null
  latestGuestMessageRoomNumber: string | null
  latestStaffActivityId: string | null
  staffActivityFromStatus: string | null
  staffActivityToStatus: string | null
  staffActivityRequestType: string | null
  staffActivityRoomNumber: string | null
  staffActivityStaffName: string | null
  overdueReminders: OverdueReminder[]
}

type Alert =
  | { kind: 'request'; roomNumber: string | null; requestType: string | null }
  | { kind: 'message'; roomNumber: string | null; conversationId: string }
  | { kind: 'staff_activity'; roomNumber: string | null; requestType: string | null; staffName: string | null; label: string }

const POLL_INTERVAL_MS = 3000
const BANNER_AUTO_DISMISS_MS = POLL_INTERVAL_MS
const SOUND_MUTED_STORAGE_KEY = 'roomlink:reception-alerts-muted'

/** Reception may be juggling a lot of traffic — sound-only mute (the banner itself still shows) is a per-browser preference, not worth a DB round trip for. */
function readMutedPreference(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SOUND_MUTED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeMutedPreference(muted: boolean) {
  try {
    window.localStorage.setItem(SOUND_MUTED_STORAGE_KEY, muted ? '1' : '0')
  } catch {
    // Best-effort — private browsing / storage-disabled contexts just won't persist the toggle across reloads.
  }
}

/** Turns a staff-authored status_history row into the banner's headline verb — the same row can mean "accepted", "rejected", or any later status change (started/completed/cancelled/escalated). */
function describeStaffActivity(fromStatus: string | null, toStatus: string | null): string {
  if (fromStatus === 'pending_acceptance' && toStatus === 'assigned') return 'accepted the assignment'
  if (fromStatus === 'pending_acceptance' && toStatus === 'pending') return 'rejected the assignment'
  if (toStatus === 'in_progress') return 'started work'
  if (toStatus === 'completed') return 'completed the request'
  if (toStatus === 'cancelled') return 'cancelled the request'
  if (toStatus === 'escalated') return 'escalated the request'
  return 'updated the request'
}

async function fetchSignal(): Promise<Signal> {
  const res = await fetch('/api/v1/hotel/reception/live-signal')
  if (!res.ok) throw new Error(`Failed to fetch reception live signal (${res.status})`)
  return res.json()
}

async function postAcknowledge(requestId: string | null) {
  const res = await fetch('/api/v1/hotel/reception/reminders/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  })
  if (!res.ok) throw new Error(`Failed to acknowledge reminder (${res.status})`)
}

/** One-shot ascending chime (Web Audio API) — distinct from the voice-call Ringtone, which loops. */
function playChime() {
  const ctx = new AudioContext()
  const now = ctx.currentTime
  const notes = [523.25, 659.25]
  for (let i = 0; i < notes.length; i++) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = notes[i]
    const start = now + i * 0.12
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35)
    osc.connect(gain).connect(ctx.destination)
    osc.start(start)
    osc.stop(start + 0.4)
  }
  setTimeout(() => ctx.close().catch(() => {}), 900)
}

/**
 * Mounted once at the hotel portal layout level (hotel/layout.tsx), same
 * place as VoiceCallListener, so Reception/hotel_admin get the alert no
 * matter which /hotel/* page they're on — not just the dashboard.
 *
 * No websocket/SSE infra exists in this codebase (see polling-refresh.tsx),
 * so this follows the same "minimum reliable polling" approach, just on a
 * tighter interval than the 20s dashboard refresh since it backs an audible
 * alert. Tracks the newest request's id and the newest guest-sent message's
 * id separately (not counts) so either one changing state between two polls
 * still triggers exactly one chime.
 *
 * Foreground-only by design, same tradeoff already made for voice calls:
 * this only fires while the tab is open and this component mounted.
 */
export function ReceptionAlertListener({ enabled }: { enabled: boolean }) {
  const router = useRouter()
  const lastSeenRequestIdRef = useRef<string | null | undefined>(undefined)
  const lastSeenMessageIdRef = useRef<string | null | undefined>(undefined)
  const lastSeenStaffActivityIdRef = useRef<string | null | undefined>(undefined)
  // Every reminder id seen so far (undefined until the first poll's baseline),
  // so a *new* reminder chimes once but an outstanding one doesn't re-chime every poll.
  const seenReminderIdsRef = useRef<Set<string> | undefined>(undefined)
  const [reminders, setReminders] = useState<OverdueReminder[]>([])
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [alert, setAlert] = useState<Alert | null>(null)
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)

  // Read the stored preference after mount (not as useState's initializer)
  // so the server-rendered and first-client-rendered markup match — this
  // toggle is purely a client-side, per-browser convenience.
  useEffect(() => {
    const stored = readMutedPreference()
    mutedRef.current = stored
    setMuted(stored)
  }, [])

  const toggleMuted = useCallback(() => {
    setMuted((prev) => {
      const next = !prev
      mutedRef.current = next
      writeMutedPreference(next)
      return next
    })
  }, [])

  const dismiss = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = null
    setAlert(null)
  }, [])

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    function fire(next: Alert) {
      if (!mutedRef.current) playChime()
      setAlert(next)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = setTimeout(dismiss, BANNER_AUTO_DISMISS_MS)
      router.refresh()
    }

    async function poll() {
      const signal = await fetchSignal().catch((error) => {
        console.error('[reception-alert-listener] poll failed', error)
        return null
      })
      if (!signal || cancelled) return

      // First poll after mount just establishes a baseline for each signal —
      // nothing to compare against yet, so none of them must alert.
      const isNewRequest = lastSeenRequestIdRef.current !== undefined && signal.latestRequestId !== lastSeenRequestIdRef.current
      const isNewMessage =
        lastSeenMessageIdRef.current !== undefined && signal.latestGuestMessageId !== lastSeenMessageIdRef.current
      const isNewStaffActivity =
        lastSeenStaffActivityIdRef.current !== undefined && signal.latestStaffActivityId !== lastSeenStaffActivityIdRef.current

      lastSeenRequestIdRef.current = signal.latestRequestId
      lastSeenMessageIdRef.current = signal.latestGuestMessageId
      lastSeenStaffActivityIdRef.current = signal.latestStaffActivityId

      const overdue = signal.overdueReminders ?? []
      const seenReminders = seenReminderIdsRef.current
      const hasNewReminder = seenReminders !== undefined && overdue.some((r) => !seenReminders.has(r.reminderId))
      const nextSeen = new Set(seenReminders)
      for (const r of overdue) nextSeen.add(r.reminderId)
      seenReminderIdsRef.current = nextSeen
      setReminders(overdue)
      if (hasNewReminder && !mutedRef.current) playChime()

      // A request arriving takes priority when more than one changes in the
      // same poll window; the chime already fired either way, and whatever
      // gets dropped here is still there (and still "new") on the next poll.
      if (isNewRequest) {
        fire({ kind: 'request', roomNumber: signal.roomNumber, requestType: signal.requestType })
      } else if (isNewMessage && signal.latestGuestMessageConversationId) {
        fire({ kind: 'message', roomNumber: signal.latestGuestMessageRoomNumber, conversationId: signal.latestGuestMessageConversationId })
      } else if (isNewStaffActivity) {
        fire({
          kind: 'staff_activity',
          roomNumber: signal.staffActivityRoomNumber,
          requestType: signal.staffActivityRequestType,
          staffName: signal.staffActivityStaffName,
          label: describeStaffActivity(signal.staffActivityFromStatus, signal.staffActivityToStatus),
        })
      }
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    }
  }, [enabled, router, dismiss])

  const acknowledge = useCallback((requestId: string | null) => {
    // Optimistic: the next poll re-syncs with the server either way.
    setReminders((prev) => (requestId ? prev.filter((r) => r.requestId !== requestId) : []))
    postAcknowledge(requestId).catch((error) => console.error('[reception-alert-listener] acknowledge failed', error))
  }, [])

  const openReminder = useCallback(
    (r: OverdueReminder) => router.push(`/hotel/requests${r.roomNumber ? `?q=${encodeURIComponent(r.roomNumber)}` : ''}`),
    [router]
  )

  if (!enabled) return null

  const reminderPanel = <OverdueReminderPanel reminders={reminders} onOpen={openReminder} onAcknowledge={acknowledge} />

  const muteToggle = (
    <button
      type="button"
      onClick={toggleMuted}
      className="fixed bottom-5 right-5 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-md hover:bg-slate-50 hover:text-slate-700"
      aria-label={muted ? 'Unmute alert sounds' : 'Mute alert sounds'}
      title={muted ? 'Alert sounds muted' : 'Alert sounds on'}
    >
      {muted ? <BellOff className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
    </button>
  )

  if (!alert)
    return (
      <>
        {muteToggle}
        {reminderPanel}
      </>
    )

  const href =
    alert.kind === 'request'
      ? '/hotel/requests?status=pending'
      : alert.kind === 'message'
        ? `/hotel/reception-desk/conversations/${alert.conversationId}`
        : `/hotel/requests${alert.roomNumber ? `?q=${encodeURIComponent(alert.roomNumber)}` : ''}`

  const icon =
    alert.kind === 'request' ? (
      <ClipboardList className="h-4.5 w-4.5 text-green-700" aria-hidden />
    ) : alert.kind === 'message' ? (
      <MessageSquareText className="h-4.5 w-4.5 text-blue-700" aria-hidden />
    ) : (
      <UserCheck className="h-4.5 w-4.5 text-amber-700" aria-hidden />
    )

  const iconBg = alert.kind === 'request' ? 'bg-green-100' : alert.kind === 'message' ? 'bg-blue-100' : 'bg-amber-100'

  const title = alert.kind === 'request' ? 'New request' : alert.kind === 'message' ? 'New message' : alert.staffName ?? 'Staff update'

  const subtitle =
    alert.kind === 'request'
      ? `${alert.requestType ?? 'Request'}${alert.roomNumber ? ` — Room ${alert.roomNumber}` : ''}`
      : alert.kind === 'message'
        ? `From guest${alert.roomNumber ? ` — Room ${alert.roomNumber}` : ''}`
        : `${alert.label}: ${alert.requestType ?? 'Request'}${alert.roomNumber ? ` — Room ${alert.roomNumber}` : ''}`

  return (
    <>
      {muteToggle}
      {reminderPanel}
      <div className="fixed right-4 top-4 z-50 w-full max-w-sm">
        <button
          type="button"
          onClick={() => {
            dismiss()
            router.push(href)
          }}
          className="flex w-full items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-left shadow-lg ring-1 ring-black/5 hover:bg-slate-50"
        >
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${iconBg}`}>{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">{title}</span>
            <span className="mt-0.5 block truncate text-sm text-slate-600">{subtitle}</span>
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              dismiss()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                dismiss()
              }
            }}
            className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" aria-hidden />
          </span>
        </button>
      </div>
    </>
  )
}
