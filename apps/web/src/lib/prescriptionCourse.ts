import { type MedicineCourse, medicineCourseLabel } from '@adaxai/contracts'
import { fmtDate } from './format.ts'

/**
 * A medicine's structured course as the printout and the patient app write it: "5 days from 6 Oct 2026". Null when the medicine has no
 * course in days or no first day (prescribed before it existed, "When needed", "Until review"): the written duration is shown as it is.
 */
export function structuredDuration(item: { durationDays?: number | null; startDate?: string | null }): string | null {
  if (!item.durationDays || item.durationDays < 1 || !item.startDate) return null
  return `${item.durationDays} ${item.durationDays === 1 ? 'day' : 'days'} from ${fmtDate(item.startDate)}`
}

/**
 * What a medicine's duration cell says: the structured course when there is one ("5 days from 6 Oct 2026"), else the duration as written.
 * `written` is the written duration too when it says more than the number of days ("1 week", "5 days, then review"), so nothing is lost.
 */
export function durationLines(item: { duration: string; durationDays?: number | null; startDate?: string | null }): { main: string; written: string | null } {
  const structured = structuredDuration(item)
  if (!structured) return { main: item.duration, written: null }
  const plain = new RegExp(`^${item.durationDays} days?$`, 'i').test(item.duration.trim())
  return { main: structured, written: plain || !item.duration.trim() ? null : item.duration }
}

/**
 * The course line the patient reads, from the course the API computed on the clinic's calendar day (never the browser's clock):
 * "Day 3 of 7 · 4 days left", "Day 7 of 7 · Completed", "Completed", "Starts 7 Oct 2026", "Duration not recorded".
 */
export function courseLine(course: MedicineCourse, today: string): string {
  if (course.state === 'not_started' && course.startDate) return `Starts ${fmtDate(course.startDate)}`
  return medicineCourseLabel(course, today)
}

/** How the course line is toned: an active or upcoming course stands out; a finished one, or one without a recorded duration, is muted. */
export function courseTone(course: MedicineCourse): 'active' | 'muted' {
  return course.state === 'active' || course.state === 'not_started' ? 'active' : 'muted'
}
