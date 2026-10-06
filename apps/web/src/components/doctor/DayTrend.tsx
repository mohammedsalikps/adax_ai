import type { DoctorDayPeriod, DoctorDayTrendPoint } from '@adaxai/contracts'
import { ChartColumn } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { longDay, TREND_GAP_REM, trendBars, trendDayLabel, trendGridColumns } from '../../lib/doctorDay.ts'
import { Panel } from '../hero/Panel.tsx'

/**
 * The minimal trend of Week and Month (DESIGN §5.1): one column per day of the period up to today, the number of consultations printed on each
 * (a 0 is a counted 0, never padding), the weekday or day of the month under it, today's column in the full brand colour. One series, so no
 * legend: the panel's label names it. CSS only (no chart library); each column has a tooltip, and a screen reader gets the same numbers as a
 * table (with the patients seen per day too). Bars are capped at 24px wide, square at the baseline with a rounded end.
 *
 * A month's columns shrink to fit the panel (trendGridColumns); only where even that is too wide (a phone) does the trend scroll sideways inside
 * the panel, never the page. While it does, the scroller is a named region in the tab order with the focus ring, so the arrow keys reach every
 * day (WCAG 2.1.1; axe scrollable-region-focusable), and it opens scrolled to today, the last column. When it fits it is a plain box: no extra
 * tab stop.
 */
export function DayTrend({ period, points, today }: { period: Exclude<DoctorDayPeriod, 'today'>; points: readonly DoctorDayTrendPoint[]; today: string }) {
  const bars = trendBars(points, 'consultations')
  const label = period === 'week' ? 'Consultations this week' : 'Consultations this month'
  const scroller = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  const days = bars.length
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || days === 0) return
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth + 1)
    measure()
    // Today is the last column: a period that does not fit opens on it (a no-op when it fits).
    el.scrollLeft = el.scrollWidth
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [days])
  return (
    <Panel label={label} icon={ChartColumn} className="mb-6" testId="doctor-day-trend">
      <div
        ref={scroller}
        className="-mx-1 overflow-x-auto rounded-md px-1 pb-1"
        role={scrolls ? 'region' : undefined}
        aria-label={scrolls ? 'Consultations per day, scrolls sideways' : undefined}
        tabIndex={scrolls ? 0 : undefined}
        data-testid="doctor-day-trend-scroller"
      >
        <ol
          aria-hidden="true"
          className="grid h-40 min-w-full items-end"
          style={{ gridTemplateColumns: trendGridColumns(period, days), columnGap: `${TREND_GAP_REM}rem` }}
        >
          {bars.map((b) => {
            const isToday = b.date === today
            return (
              <li key={b.date} title={`${longDay(b.date)}: ${b.value} ${b.value === 1 ? 'consultation' : 'consultations'}`} className="flex h-full min-w-0 flex-col items-center justify-end gap-1">
                <span className="text-xs font-medium tabular-nums text-ink">{b.value}</span>
                {/* The column grows from the baseline; a counted zero is a hairline on it. */}
                <span className="flex h-24 w-full items-end justify-center border-b border-line-strong">
                  <span className={`block w-full max-w-6 rounded-t ${isToday ? 'bg-brand' : 'bg-brand/45'} motion-safe:transition-[height] motion-safe:duration-200`} style={{ height: b.value > 0 ? `${Math.max(b.percent, 4)}%` : '0' }} />
                </span>
                <span className={`text-[0.6875rem] tabular-nums ${isToday ? 'font-semibold text-ink' : 'text-ink-muted'}`}>{trendDayLabel(b.date, period)}</span>
              </li>
            )
          })}
        </ol>
      </div>
      <table className="sr-only">
        <caption>{label}, per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Consultations</th>
            <th scope="col">Patients seen (completed)</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">
                {longDay(p.date)}
                {p.date === today ? ' (today)' : ''}
              </th>
              <td>{p.consultations}</td>
              <td>{p.seen}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}
