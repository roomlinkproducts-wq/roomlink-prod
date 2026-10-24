'use client'

import { AlarmClock, Check } from 'lucide-react'

export type OverdueReminder = {
  reminderId: string
  requestId: string
  sequence: number
  requestType: string
  roomNumber: string | null
  departmentName: string | null
  status: string
  createdAt: string
  statusChangedAt: string
  sentAt: string
}

const MAX_VISIBLE = 3

function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}

function formatMinutes(total: number) {
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * Unlike ReceptionAlertListener's banner (which auto-dismisses after one
 * poll), an overdue reminder stays on screen until someone acknowledges it
 * or the request is closed — a request nobody has looked at in 30 minutes is
 * exactly the thing that must not scroll away unnoticed.
 */
export function OverdueReminderPanel({
  reminders,
  onOpen,
  onAcknowledge,
}: {
  reminders: OverdueReminder[]
  onOpen: (reminder: OverdueReminder) => void
  onAcknowledge: (requestId: string | null) => void
}) {
  if (reminders.length === 0) return null

  const visible = reminders.slice(0, MAX_VISIBLE)
  const hidden = reminders.length - visible.length

  return (
    <div
      role="alert"
      className="fixed bottom-16 right-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-lg border border-red-200 bg-white shadow-lg ring-1 ring-black/5"
    >
      <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-4 py-2.5">
        <AlarmClock className="h-4 w-4 text-red-600" aria-hidden />
        <p className="flex-1 text-sm font-semibold text-red-800">
          {reminders.length === 1 ? '1 request overdue' : `${reminders.length} requests overdue`}
        </p>
        {reminders.length > 1 && (
          <button type="button" onClick={() => onAcknowledge(null)} className="text-xs font-medium text-red-700 hover:text-red-900">
            Acknowledge all
          </button>
        )}
      </div>
      <ul className="divide-y divide-slate-100">
        {visible.map((r) => (
          <li key={r.reminderId} className="flex items-start gap-3 px-4 py-2.5">
            <button type="button" onClick={() => onOpen(r)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium text-slate-900">
                {r.roomNumber ? `Room ${r.roomNumber} · ` : ''}
                {r.requestType}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Open {formatMinutes(minutesSince(r.createdAt))} · {formatMinutes(minutesSince(r.statusChangedAt))} in{' '}
                {r.status.replace(/_/g, ' ')}
                {r.departmentName ? ` · ${r.departmentName}` : ''}
                {r.sequence > 1 ? ` · reminder #${r.sequence}` : ''}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onAcknowledge(r.requestId)}
              className="flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              aria-label={`Acknowledge reminder for ${r.requestType}`}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              Ack
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">+{hidden} more</p>}
    </div>
  )
}
