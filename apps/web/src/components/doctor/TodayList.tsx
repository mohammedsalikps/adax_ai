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
    <ul role="list" aria-label={label} className="divide-y divide-line">
      {rows.map((r) => (
        <TodayRow key={r.key} row={r} today={today} action={todayAction(r) ? <TodayAction row={r} /> : undefined} highlighted={!!highlightKey && r.key === highlightKey} />
      ))}
    </ul>
  )
}
