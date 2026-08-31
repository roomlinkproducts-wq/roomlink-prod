'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, Select, StatusBadge } from '@roomlink/ui'
import { groupByBuilding, groupByFloor, floorLabel, floorKey } from '@/lib/floor'
import { Pager } from '@/components/pager'

type Room = {
  room_id: string
  room_number: string
  floor: string | null
  building: string | null
  status: string
  room_types: { name: string } | null
  qr_codes: { qr_code_id: string; is_active: boolean }[]
}

export function RoomList({ rooms, hotelName, isNative = false }: { rooms: Room[]; hotelName: string; isNative?: boolean }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [buildingPage, setBuildingPage] = useState(0)
  const [floorPage, setFloorPage] = useState(0)

  // Two-level grouping: a hotel with multiple buildings can have the same
  // floor number repeat per building, so floor pagination alone would
  // conflate them.
  const buildingGroups = useMemo(() => groupByBuilding(rooms, hotelName), [rooms, hotelName])
  const currentBuildingPage = Math.min(buildingPage, Math.max(0, buildingGroups.length - 1))
  const currentBuilding = buildingGroups[currentBuildingPage]

  const floorGroups = useMemo(() => groupByFloor(currentBuilding?.items ?? []), [currentBuilding])
  const currentFloorPage = Math.min(floorPage, Math.max(0, floorGroups.length - 1))
  const currentFloor = floorGroups[currentFloorPage]
  const floorRooms = currentFloor?.items ?? []

  useEffect(() => {
    setFloorPage(0)
  }, [currentBuildingPage])

  async function setStatus(roomId: string, status: string) {
    setBusyId(roomId)
    await fetch(`/api/v1/hotel/rooms/${roomId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setBusyId(null)
    router.refresh()
  }

  return (
    <div className="space-y-4">
      {buildingGroups.length > 1 && (
        <Pager
          items={buildingGroups.map((g) => ({ key: g.building, label: g.building }))}
          currentIndex={currentBuildingPage}
          onSelect={setBuildingPage}
        />
      )}

      {currentFloor && (
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {currentBuilding && buildingGroups.length > 1 ? `${currentBuilding.building} · ` : ''}
          {currentFloor.floor === null ? 'Unassigned' : `Floor ${currentFloor.floor}`} ({floorRooms.length})
        </h3>
      )}

      {/* Native-only stacked-card layout — see the mobile-app plan's isolation
          mechanism. Same data and the same setStatus handler as the desktop
          table below; browsers always take the unchanged table path. */}
      {isNative ? (
        <Card className="overflow-hidden">
          {rooms.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-slate-500">No rooms yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {floorRooms.map((room) => (
                <li key={room.room_id} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-slate-900">
                        Room {room.room_number}
                        {room.floor && <span className="font-normal text-slate-500"> · Floor {room.floor}</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        {room.room_types?.name ?? 'No room type'} · {room.building ?? hotelName}
                      </p>
                    </div>
                    <StatusBadge status={room.status} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-500">
                      QR:{' '}
                      {room.qr_codes.some((q) => q.is_active) ? (
                        <span className="text-emerald-600">Active</span>
                      ) : (
                        <span className="text-slate-400">Not generated</span>
                      )}
                    </span>
                    <Select
                      className="h-9 max-w-[150px] text-xs"
                      value={room.status}
                      disabled={busyId === room.room_id}
                      onChange={(e) => setStatus(room.room_id, e.target.value)}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="maintenance">Maintenance</option>
                    </Select>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Room</th>
                  <th className="px-5 py-3 font-medium">Building</th>
                  <th className="px-5 py-3 font-medium">Floor</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">QR</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {floorRooms.map((room) => (
                  <tr key={room.room_id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{room.room_number}</td>
                    <td className="px-5 py-3 text-slate-600">{room.building ?? hotelName}</td>
                    <td className="px-5 py-3 text-slate-600">{room.floor ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-600">{room.room_types?.name ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {room.qr_codes.some((q) => q.is_active) ? (
                        <span className="text-emerald-600">Active</span>
                      ) : (
                        <span className="text-slate-400">Not generated</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <StatusBadge status={room.status} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Select
                        className="h-8 max-w-[140px] text-xs"
                        value={room.status}
                        disabled={busyId === room.room_id}
                        onChange={(e) => setStatus(room.room_id, e.target.value)}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                        <option value="maintenance">Maintenance</option>
                      </Select>
                    </td>
                  </tr>
                ))}
                {rooms.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">
                      No rooms yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {floorGroups.length > 1 && (
        <div className="border-t border-slate-100 pt-4">
          <Pager
            items={floorGroups.map((g) => ({ key: floorKey(g.floor), label: floorLabel(g.floor) }))}
            currentIndex={currentFloorPage}
            onSelect={setFloorPage}
          />
        </div>
      )}
    </div>
  )
}
