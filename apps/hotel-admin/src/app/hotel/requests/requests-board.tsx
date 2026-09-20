'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, Button, Select, StatusBadge, Modal, Textarea, timeAgo, cn } from '@roomlink/ui'

type Department = { department_id: string; name: string }
type Room = { room_id: string; room_number: string }
type RequestRow = {
  request_id: string
  request_type: string
  status: string
  priority: string
  notes: string | null
  created_at: string
  rooms: { room_number: string } | null
  guests: { full_name: string | null } | null
  departments: { department_id: string; name: string; manager_id: string | null } | null
  users: { user_id: string; full_name: string } | null
}
type HistoryEntry = {
  history_id: string
  from_status: string | null
  to_status: string | null
  note: string | null
  changed_at: string
  users_request_status_history_changed_byTousers: { full_name: string } | null
  users_request_status_history_to_assigneeTousers: { full_name: string } | null
}

type SortBy = 'oldest' | 'newest' | 'priority' | 'sla'

const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1 }
const SLA_RISK_MINUTES: Record<string, number> = { urgent: 15, high: 30, normal: 60 }
const OPEN_STATUSES = new Set(['pending', 'pending_acceptance', 'assigned', 'in_progress', 'escalated'])
// Reception (or anyone else with manage rights) can close a request directly from any of these
// states — resolving it at the desk doesn't require walking it through start/in-progress first.
// `pending_acceptance` is excluded: that state has its own accept/reject flow to resolve first.
const CLOSABLE_STATUSES = new Set(['pending', 'assigned', 'in_progress', 'escalated'])

function elapsedMinutes(createdAt: string) {
  return (Date.now() - new Date(createdAt).getTime()) / 60000
}

function isAtSlaRisk(r: RequestRow) {
  if (!OPEN_STATUSES.has(r.status)) return false
  return elapsedMinutes(r.created_at) >= (SLA_RISK_MINUTES[r.priority] ?? 60)
}

function sortRequests(rows: RequestRow[], sortBy: SortBy) {
  const copy = [...rows]
  if (sortBy === 'oldest') return copy.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  if (sortBy === 'newest') return copy.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  if (sortBy === 'priority') return copy.sort((a, b) => (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0))
  // sla risk: most overdue relative to its own threshold first
  return copy.sort((a, b) => {
    const ratioA = elapsedMinutes(a.created_at) / (SLA_RISK_MINUTES[a.priority] ?? 60)
    const ratioB = elapsedMinutes(b.created_at) / (SLA_RISK_MINUTES[b.priority] ?? 60)
    return ratioB - ratioA
  })
}

export function RequestsBoard({
  requests,
  departments,
  rooms,
  canCreateRequests = true,
  initialStatusFilter = '',
  initialDeptFilter = '',
  initialSearch = '',
}: {
  requests: RequestRow[]
  departments: Department[]
  rooms: Room[]
  canCreateRequests?: boolean
  initialStatusFilter?: string
  initialDeptFilter?: string
  initialSearch?: string
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [assigneesFor, setAssigneesFor] = useState<string | null>(null)
  const [assigneeOptions, setAssigneeOptions] = useState<{ user_id: string; full_name: string; isManager: boolean }[]>([])
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter)
  const [deptFilter, setDeptFilter] = useState(initialDeptFilter)
  const [sortBy, setSortBy] = useState<SortBy>('sla')
  const [search, setSearch] = useState(initialSearch)

  // Create-request form state
  const [newRoomId, setNewRoomId] = useState('')
  const [newDeptId, setNewDeptId] = useState('')
  const [newType, setNewType] = useState('')
  const [newPriority, setNewPriority] = useState<'normal' | 'high' | 'urgent'>('normal')
  const [creating, setCreating] = useState(false)

  // Escalate modal
  const [escalateFor, setEscalateFor] = useState<string | null>(null)
  const [escalateUrgency, setEscalateUrgency] = useState<'normal' | 'high' | 'urgent'>('high')
  const [escalateRecipient, setEscalateRecipient] = useState<'reception' | 'gm'>('reception')
  const [escalateReason, setEscalateReason] = useState('')

  // Cancel modal
  const [cancelFor, setCancelFor] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')

  // Note modal
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')

  // History modal
  const [historyFor, setHistoryFor] = useState<string | null>(null)
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  async function openAssign(requestId: string, departmentId: string) {
    setAssigneesFor(requestId)
    const res = await fetch(`/api/v1/hotel/departments/${departmentId}/eligible-assignees`)
    const data = await res.json()
    const options = [
      ...(data.manager ? [{ ...data.manager, isManager: true }] : []),
      ...data.members.filter((m: { user_id: string }) => m.user_id !== data.manager?.user_id).map((m: object) => ({ ...m, isManager: false })),
    ]
    setAssigneeOptions(options)
  }

  async function assign(requestId: string, assigneeId: string) {
    setBusyId(requestId)
    await fetch(`/api/v1/hotel/requests/${requestId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeId }),
    })
    setBusyId(null)
    setAssigneesFor(null)
    router.refresh()
  }

  async function setStatus(requestId: string, status: string) {
    setBusyId(requestId)
    await fetch(`/api/v1/hotel/requests/${requestId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setBusyId(null)
    router.refresh()
  }

  async function submitEscalate() {
    if (!escalateFor || escalateReason.trim().length < 3) return
    setBusyId(escalateFor)
    await fetch(`/api/v1/hotel/requests/${escalateFor}/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urgency: escalateUrgency, recipient: escalateRecipient, reason: escalateReason.trim() }),
    })
    setBusyId(null)
    setEscalateFor(null)
    setEscalateReason('')
    router.refresh()
  }

  async function submitCancel() {
    if (!cancelFor || cancelReason.trim().length === 0) return
    setBusyId(cancelFor)
    await fetch(`/api/v1/hotel/requests/${cancelFor}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled', note: cancelReason.trim() }),
    })
    setBusyId(null)
    setCancelFor(null)
    setCancelReason('')
    router.refresh()
  }

  async function submitNote() {
    if (!noteFor || noteText.trim().length < 2) return
    setBusyId(noteFor)
    await fetch(`/api/v1/hotel/requests/${noteFor}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: noteText.trim() }),
    })
    setBusyId(null)
    setNoteFor(null)
    setNoteText('')
    router.refresh()
  }

  async function openHistory(requestId: string) {
    setHistoryFor(requestId)
    setHistoryLoading(true)
    const res = await fetch(`/api/v1/hotel/requests/${requestId}/history`)
    const data = await res.json()
    setHistoryEntries(data)
    setHistoryLoading(false)
  }

  async function createRequest() {
    if (!newRoomId || !newDeptId || !newType.trim()) return
    setCreating(true)
    await fetch('/api/v1/hotel/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: newRoomId, departmentId: newDeptId, requestType: newType.trim(), priority: newPriority }),
    })
    setCreating(false)
    setNewType('')
    router.refresh()
  }

  const filtered = sortRequests(
    requests.filter((r) => {
      if (statusFilter === '__unassigned__') {
        if (r.users) return false
      } else if (statusFilter === '__pending_or_assigned__') {
        if (r.status !== 'pending' && r.status !== 'assigned') return false
      } else if (statusFilter === '__delayed_or_escalated__') {
        if (r.status !== 'escalated' && !isAtSlaRisk(r)) return false
      } else if (statusFilter && r.status !== statusFilter) {
        return false
      }
      if (deptFilter && r.departments?.department_id !== deptFilter) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const haystack = [r.rooms?.room_number, r.guests?.full_name, r.request_id, r.request_type, r.users?.full_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    }),
    sortBy
  )
  const QUICK_FILTERS: { value: string; label: string }[] = [
    { value: '', label: 'All' },
    { value: 'pending', label: 'New' },
    { value: '__unassigned__', label: 'Unassigned' },
    { value: 'pending_acceptance', label: 'Awaiting accept' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'escalated', label: 'Escalated' },
    { value: 'completed', label: 'Completed' },
  ]

  return (
    <div className="space-y-5">
      {canCreateRequests && (
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Room</label>
              <Select className="h-9 w-32" value={newRoomId} onChange={(e) => setNewRoomId(e.target.value)}>
                <option value="">Room…</option>
                {rooms.map((r) => (
                  <option key={r.room_id} value={r.room_id}>
                    {r.room_number}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Department</label>
              <Select className="h-9 w-40" value={newDeptId} onChange={(e) => setNewDeptId(e.target.value)}>
                <option value="">Department…</option>
                {departments.map((d) => (
                  <option key={d.department_id} value={d.department_id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="mb-1.5 block text-xs font-medium text-slate-500">What does the guest need?</label>
              <input
                className="block h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
                placeholder="e.g. Extra towels, AC repair…"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Priority</label>
              <Select className="h-9 w-28" value={newPriority} onChange={(e) => setNewPriority(e.target.value as typeof newPriority)}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </div>
            <Button disabled={creating || !newRoomId || !newDeptId || !newType.trim()} onClick={createRequest}>
              Log request
            </Button>
          </div>
        </Card>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="h-9 w-full max-w-xs rounded-md border border-slate-300 px-3 text-sm placeholder:text-slate-400"
            placeholder="Search room, guest, request ID or title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {QUICK_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  statusFilter === f.value ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

      <div className="flex flex-wrap gap-3">
        <Select className="h-9 w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">New</option>
          <option value="pending_acceptance">Awaiting acceptance</option>
          <option value="assigned">Assigned</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="escalated">Escalated</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <Select className="h-9 w-40" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.department_id} value={d.department_id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select className="h-9 w-44" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
          <option value="sla">Sort: SLA risk</option>
          <option value="priority">Sort: Priority</option>
          <option value="oldest">Sort: Oldest first</option>
          <option value="newest">Sort: Newest first</option>
        </Select>
      </div>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3 font-medium">Room</th>
                <th className="px-5 py-3 font-medium">Guest</th>
                <th className="px-5 py-3 font-medium">Request</th>
                <th className="px-5 py-3 font-medium">Department</th>
                <th className="px-5 py-3 font-medium">Priority</th>
                <th className="px-5 py-3 font-medium">Elapsed</th>
                <th className="px-5 py-3 font-medium">Assignee</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((r) => {
                const atRisk = isAtSlaRisk(r)
                return (
                  <tr key={r.request_id} className="hover:bg-slate-50 align-top">
                    <td className="px-5 py-3 font-medium text-slate-900">{r.rooms?.room_number ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-600">{r.guests?.full_name ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-700">
                      {r.request_type}
                      {r.notes && <p className="mt-0.5 text-xs text-slate-400">{r.notes}</p>}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{r.departments?.name ?? '—'}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.priority} />
                    </td>
                    <td className="px-5 py-3">
                      <span className={atRisk ? 'font-medium text-red-600' : 'text-slate-500'}>{timeAgo(r.created_at)}</span>
                      {atRisk && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-label="At SLA risk" />}
                    </td>
                    <td className="px-5 py-3">
                      {assigneesFor === r.request_id ? (
                        <div className="space-y-1">
                          {assigneeOptions.map((a) => (
                            <button
                              key={a.user_id}
                              onClick={() => assign(r.request_id, a.user_id)}
                              className="block text-xs text-brand-600 hover:text-brand-700"
                            >
                              {a.full_name} {a.isManager && '(Manager)'}
                            </button>
                          ))}
                          {assigneeOptions.length === 0 && <p className="text-xs text-slate-400">No eligible staff</p>}
                          <button onClick={() => setAssigneesFor(null)} className="text-xs text-slate-400">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => r.departments && openAssign(r.request_id, r.departments.department_id)}
                          className="text-slate-600 hover:text-brand-700"
                        >
                          {r.users?.full_name ?? <span className="text-brand-600 text-xs">Assign…</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {(r.status === 'assigned' || r.status === 'escalated') && (
                          <Button
                            variant="secondary"
                            className="h-7 px-2 text-xs"
                            disabled={busyId === r.request_id}
                            onClick={() => setStatus(r.request_id, 'in_progress')}
                          >
                            Start
                          </Button>
                        )}
                        {CLOSABLE_STATUSES.has(r.status) && (
                          <Button
                            variant="secondary"
                            className="h-7 px-2 text-xs"
                            disabled={busyId === r.request_id}
                            onClick={() => setStatus(r.request_id, 'completed')}
                          >
                            Close
                          </Button>
                        )}
                        {OPEN_STATUSES.has(r.status) && r.status !== 'escalated' && (
                          <Button
                            variant="ghost"
                            className="h-7 px-2 text-xs text-amber-600"
                            disabled={busyId === r.request_id}
                            onClick={() => setEscalateFor(r.request_id)}
                          >
                            Escalate
                          </Button>
                        )}
                        {OPEN_STATUSES.has(r.status) && (
                          <Button
                            variant="ghost"
                            className="h-7 px-2 text-xs text-red-600"
                            disabled={busyId === r.request_id}
                            onClick={() => setCancelFor(r.request_id)}
                          >
                            Cancel
                          </Button>
                        )}
                        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => setNoteFor(r.request_id)}>
                          Note
                        </Button>
                        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => openHistory(r.request_id)}>
                          History
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-10 text-center text-sm text-slate-500">
                    No requests match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {escalateFor && (
        <Modal title="Escalate request" onClose={() => setEscalateFor(null)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Urgency</label>
              <Select value={escalateUrgency} onChange={(e) => setEscalateUrgency(e.target.value as typeof escalateUrgency)}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Recipient</label>
              <Select value={escalateRecipient} onChange={(e) => setEscalateRecipient(e.target.value as typeof escalateRecipient)}>
                <option value="reception">Reception</option>
                <option value="gm">Hotel Admin / GM</option>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Reason</label>
              <Textarea value={escalateReason} onChange={(e) => setEscalateReason(e.target.value)} rows={3} placeholder="What is blocking this, and why now?" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setEscalateFor(null)}>
                Cancel
              </Button>
              <Button disabled={escalateReason.trim().length < 3 || busyId === escalateFor} onClick={submitEscalate}>
                Escalate
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {cancelFor && (
        <Modal title="Cancel request" onClose={() => setCancelFor(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Cancelling is an auditable exception — a reason is required.</p>
            <Textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={3} placeholder="Why is this request being cancelled?" />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setCancelFor(null)}>
                Back
              </Button>
              <Button disabled={cancelReason.trim().length === 0 || busyId === cancelFor} onClick={submitCancel}>
                Confirm cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {noteFor && (
        <Modal title="Add internal note" onClose={() => setNoteFor(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Use this to record why a request is still unassigned, or any other coordination note — visible in the
              activity timeline for this request.
            </p>
            <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} placeholder="e.g. Keeping unassigned — no housekeeping staff free until 3pm" />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setNoteFor(null)}>
                Cancel
              </Button>
              <Button disabled={noteText.trim().length < 2 || busyId === noteFor} onClick={submitNote}>
                Save note
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {historyFor && (
        <Modal title="Activity timeline" onClose={() => setHistoryFor(null)}>
          {historyLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <ul className="space-y-3">
              {historyEntries.map((h) => (
                <li key={h.history_id} className="text-sm">
                  <p className="text-slate-800">
                    {h.from_status && h.to_status && h.from_status !== h.to_status
                      ? `${h.from_status.replace(/_/g, ' ')} → ${h.to_status.replace(/_/g, ' ')}`
                      : 'Note added'}
                    {h.users_request_status_history_to_assigneeTousers && (
                      <> — assigned to {h.users_request_status_history_to_assigneeTousers.full_name}</>
                    )}
                  </p>
                  {h.note && <p className="text-xs text-slate-500">{h.note}</p>}
                  <p className="text-xs text-slate-400">
                    {h.users_request_status_history_changed_byTousers?.full_name ?? 'System'} — {timeAgo(h.changed_at)}
                  </p>
                </li>
              ))}
              {historyEntries.length === 0 && <li className="text-sm text-slate-500">No activity recorded yet.</li>}
            </ul>
          )}
        </Modal>
      )}
    </div>
  )
}
