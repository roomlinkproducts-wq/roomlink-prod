export type FloorGroup<T> = { floor: number | null; items: T[] }

/**
 * Existing floor data is free text ("Ground", "Floor 1", "Floor 10", plain
 * "1", etc.), not bare numbers — only new rooms created after the 0-100
 * validation was added are guaranteed plain digits. Ground normalizes to 0;
 * any other string has its first number pulled out (so "Floor 10" groups as
 * floor 10). Anything with no number at all (e.g. "PH") has no sequential
 * position and is grouped with the unassigned/null floors at the end.
 */
export function normalizeFloor(floor: string | null): number | null {
  if (floor === null) return null
  const trimmed = floor.trim()
  if (!trimmed) return null
  if (/^g(round)?(\s*floor)?$/i.test(trimmed)) return 0
  const match = trimmed.match(/\d+/)
  return match ? Number(match[0]) : null
}

export function floorLabel(floor: number | null): string {
  return floor === null ? '—' : String(floor)
}

/** Stable string key for a normalized floor, safe to round-trip through a URL query param. */
export function floorKey(floor: number | null): string {
  return floor === null ? 'unassigned' : String(floor)
}

/** Groups by normalizeFloor(item.floor), sorted ascending with unassigned/unparseable floors last. */
export function groupByFloor<T extends { floor: string | null }>(items: T[]): FloorGroup<T>[] {
  const map = new Map<number | null, T[]>()
  for (const item of items) {
    const key = normalizeFloor(item.floor)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(item)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => {
      if (a === null) return b === null ? 0 : 1
      if (b === null) return -1
      return a - b
    })
    .map(([floor, items]) => ({ floor, items }))
}

export type BuildingGroup<T> = { building: string; items: T[] }

/** A room with no building set falls back to displaying the hotel's own name — display-time only, nothing is stored for it. */
export function effectiveBuildingName(building: string | null, hotelName: string): string {
  return building && building.trim() ? building : hotelName
}

/** Groups by effectiveBuildingName(item.building, hotelName), sorted alphabetically. */
export function groupByBuilding<T extends { building: string | null }>(items: T[], hotelName: string): BuildingGroup<T>[] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = effectiveBuildingName(item.building, hotelName)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(item)
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([building, items]) => ({ building, items }))
}
