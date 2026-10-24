import { describe, expect, it } from 'vitest'
import { isAtSlaRisk, isOverdue } from './sla'

describe('isAtSlaRisk', () => {
  const now = new Date('2026-08-16T12:00:00Z')

  it('flags urgent work after 15 minutes', () => {
    expect(isAtSlaRisk('urgent', new Date('2026-08-16T11:46:00Z'), now)).toBe(false)
    expect(isAtSlaRisk('urgent', new Date('2026-08-16T11:45:00Z'), now)).toBe(true)
  })

  it('flags high-priority work after 30 minutes', () => {
    expect(isAtSlaRisk('high', new Date('2026-08-16T11:31:00Z'), now)).toBe(false)
    expect(isAtSlaRisk('high', new Date('2026-08-16T11:30:00Z'), now)).toBe(true)
  })

  it('flags normal work after 60 minutes', () => {
    expect(isAtSlaRisk('normal', new Date('2026-08-16T11:01:00Z'), now)).toBe(false)
    expect(isAtSlaRisk('normal', new Date('2026-08-16T11:00:00Z'), now)).toBe(true)
  })
})

describe('isOverdue', () => {
  const now = new Date('2026-08-16T12:00:00Z')

  it('flags any request open 30 minutes or more, regardless of priority', () => {
    expect(isOverdue(new Date('2026-08-16T11:30:01Z'), now)).toBe(false)
    expect(isOverdue(new Date('2026-08-16T11:30:00Z'), now)).toBe(true)
  })
})
