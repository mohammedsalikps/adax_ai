import type { DoctorDayTimelineRow } from '@adaxai/contracts'
import { todayAction } from '../../lib/doctorDay.ts'
import { TodayAction } from './TodayAction.tsx'
import { TodayRow } from './TodayRow.tsx'

/**
 * Today's patients as a list (Home: "Today’s patients"; My consultations: "Visits"): one TodayRow per patient in the order given (the
 * server's time order), each with its one action when it has one. `role="list"` is explicit (a list without bullets loses it in some browsers).
 */
export function TodayList({ rows, today, label, highlightKey }: { rows: readonly DoctorDayTimelineRow[]; today: string; label: string; highlightKey?: string | null }) {
  return (
    <ul role="list" aria-label={label} className="divide-y divide-line/70">
      {rows.map((r) => (
        <TodayRow key={r.key} row={r} today={today} action={todayAction(r) ? <TodayAction row={r} /> : undefined} highlighted={!!highlightKey && r.key === highlightKey} />
      ))}
    </ul>
  )
}

/**
 * UI/UX redesign: the list's column names, from 1280px where the rows are five columns (TodayRow's grid). Visual only: every row says what it
 * is in its own words, so assistive technology reads the list, not a table.
 */
export function TodayListHeader() {
  return (
    <div aria-hidden="true" className="mx-3 mt-1 hidden grid-cols-[4.5rem_minmax(0,1.25fr)_minmax(0,1fr)_10rem_11.5rem] gap-x-4 rounded-xl bg-canvas px-2 py-2.5 text-xs font-semibold text-ink-muted xl:grid">
      <span>Time</span>
      <span className="pl-13">Patient</span>
      <span>Reason</span>
      <span>Status</span>
      <span className="text-right">Action</span>
    </div>
  )
}
