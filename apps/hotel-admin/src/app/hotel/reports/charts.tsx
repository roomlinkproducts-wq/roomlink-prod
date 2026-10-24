'use client'

import { useState } from 'react'

// Reference data-viz palette, light mode (this app has no dark theme):
// categorical slots 1 (blue) and 2 (orange) — a validated adjacent pair.
const ON_TIME_COLOR = '#2a78d6'
const LATE_COLOR = '#eb6834'
const OTHER_COLOR = '#b4b2ab'
const CHART_HEIGHT = 160

type Tip = { x: number; y: number; lines: [string, string][]; title: string } | null

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      <p className="mb-1 text-slate-500">{tip.title}</p>
      {tip.lines.map(([label, value]) => (
        <p key={label} className="flex items-baseline justify-between gap-4">
          <span className="text-slate-500">{label}</span>
          <span className="font-semibold tabular-nums text-slate-900">{value}</span>
        </p>
      ))}
    </div>
  )
}

function niceMax(n: number) {
  if (n <= 5) return 5
  const step = Math.pow(10, Math.floor(Math.log10(n)))
  return Math.ceil(n / step) * step
}

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

function formatDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export type DailyPoint = { day: string; total: number; completed: number; onTime: number; compliance: number | null }

/**
 * Completed requests per day, stacked on-time (bottom) vs late — the bar's
 * height is the day's throughput and the orange cap is how much of it missed
 * the standard. Requests still open or cancelled are listed in the tooltip
 * rather than stacked, so the bar only ever shows finished work.
 */
export function DailyComplianceChart({ data, standardMinutes }: { data: DailyPoint[]; standardMinutes: number }) {
  const [tip, setTip] = useState<Tip>(null)
  const max = niceMax(Math.max(0, ...data.map((d) => d.completed)))
  const labelEvery = Math.max(1, Math.ceil(data.length / 10))

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ON_TIME_COLOR }} aria-hidden />
          Completed within {standardMinutes} min
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LATE_COLOR }} aria-hidden />
          Completed late
        </span>
      </div>
      <div className="relative flex gap-2" onPointerLeave={() => setTip(null)}>
        <div className="flex w-8 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-slate-400" style={{ height: CHART_HEIGHT }}>
          <span>{max}</span>
          <span>{max / 2}</span>
          <span>0</span>
        </div>
        <div className="relative flex-1">
          <div className="absolute inset-x-0 top-0 border-t border-slate-100" />
          <div className="absolute inset-x-0 border-t border-slate-100" style={{ top: CHART_HEIGHT / 2 }} />
          <div className="relative flex items-end gap-[2px] border-b border-slate-300" style={{ height: CHART_HEIGHT }}>
            {data.map((d) => {
              const late = d.completed - d.onTime
              const onTimeH = (d.onTime / max) * CHART_HEIGHT
              const lateH = (late / max) * CHART_HEIGHT
              const show = (el: HTMLElement) => {
                const box = el.getBoundingClientRect()
                const parent = el.parentElement!.getBoundingClientRect()
                setTip({
                  x: box.left - parent.left + box.width / 2,
                  y: CHART_HEIGHT - onTimeH - lateH,
                  title: formatDay(d.day),
                  lines: [
                    ['On time', String(d.onTime)],
                    ['Late', String(late)],
                    ['Compliance', pct(d.compliance)],
                    ['Raised', String(d.total)],
                  ],
                })
              }
              return (
                <div
                  key={d.day}
                  tabIndex={0}
                  aria-label={`${formatDay(d.day)}: ${d.onTime} on time, ${late} late`}
                  className="group flex h-full flex-1 cursor-default flex-col justify-end outline-none"
                  onPointerEnter={(e) => show(e.currentTarget)}
                  onFocus={(e) => show(e.currentTarget)}
                  onBlur={() => setTip(null)}
                >
                  {late > 0 && (
                    <div
                      className="mx-auto w-full max-w-[28px] rounded-t-[4px] group-hover:opacity-80 group-focus:opacity-80"
                      style={{ height: lateH, background: LATE_COLOR, marginBottom: d.onTime > 0 ? 2 : 0 }}
                    />
                  )}
                  {d.onTime > 0 && (
                    <div
                      className={`mx-auto w-full max-w-[28px] group-hover:opacity-80 group-focus:opacity-80 ${late > 0 ? '' : 'rounded-t-[4px]'}`}
                      style={{ height: onTimeH, background: ON_TIME_COLOR }}
                    />
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 flex gap-[2px] text-[11px] text-slate-400">
            {data.map((d, i) => (
              <span key={d.day} className="flex-1 truncate text-center">
                {i % labelEvery === 0 ? formatDay(d.day) : ''}
              </span>
            ))}
          </div>
          <Tooltip tip={tip} />
        </div>
      </div>
    </div>
  )
}

export type HourPoint = { hour: number; total: number; compliance: number | null; medianResolution: number | null }

function formatHour(h: number) {
  return `${String(h).padStart(2, '0')}:00`
}

/**
 * Requests raised per hour of day (hotel time), with the hour's compliance
 * in the tooltip — shows when demand peaks and whether those peaks are
 * where the standard slips (i.e. where a shift is under-staffed).
 * Hours below 80% compliance are drawn orange so the problem hours stand
 * out; the legend states the rule, the tooltip gives the exact figure.
 */
export function HourlyDemandChart({ data }: { data: HourPoint[] }) {
  const [tip, setTip] = useState<Tip>(null)
  const max = niceMax(Math.max(0, ...data.map((d) => d.total)))
  const height = 120

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ON_TIME_COLOR }} aria-hidden />
          Requests raised
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: LATE_COLOR }} aria-hidden />
          Hour below 80% on time
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: OTHER_COLOR }} aria-hidden />
          None completed yet
        </span>
      </div>
      <div className="relative" onPointerLeave={() => setTip(null)}>
        <div className="flex items-end gap-[2px] border-b border-slate-300" style={{ height }}>
          {data.map((d) => {
            const h = (d.total / max) * height
            const weak = d.compliance !== null && d.compliance < 0.8
            const show = (el: HTMLElement) => {
              const box = el.getBoundingClientRect()
              const parent = el.parentElement!.getBoundingClientRect()
              setTip({
                x: box.left - parent.left + box.width / 2,
                y: height - h,
                title: `${formatHour(d.hour)}–${formatHour((d.hour + 1) % 24)}`,
                lines: [
                  ['Raised', String(d.total)],
                  ['On time', pct(d.compliance)],
                  ['Median to complete', d.medianResolution === null ? '—' : `${Math.round(d.medianResolution)} min`],
                ],
              })
            }
            return (
              <div
                key={d.hour}
                tabIndex={0}
                aria-label={`${formatHour(d.hour)}: ${d.total} raised, ${pct(d.compliance)} on time`}
                className="group flex h-full flex-1 flex-col justify-end outline-none"
                onPointerEnter={(e) => show(e.currentTarget)}
                onFocus={(e) => show(e.currentTarget)}
                onBlur={() => setTip(null)}
              >
                {d.total > 0 && (
                  <div
                    className="mx-auto w-full max-w-[20px] rounded-t-[4px] group-hover:opacity-80 group-focus:opacity-80"
                    style={{ height: h, background: d.compliance === null ? OTHER_COLOR : weak ? LATE_COLOR : ON_TIME_COLOR }}
                  />
                )}
              </div>
            )
          })}
        </div>
        <div className="mt-1.5 flex gap-[2px] text-[11px] text-slate-400">
          {data.map((d) => (
            <span key={d.hour} className="flex-1 text-center">
              {d.hour % 3 === 0 ? String(d.hour).padStart(2, '0') : ''}
            </span>
          ))}
        </div>
        <Tooltip tip={tip} />
      </div>
    </div>
  )
}
