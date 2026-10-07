import { DOCTOR_DAY_PERIOD_LABELS, type DoctorDay, DoctorDayPeriod, type DoctorDayTimelineRow, type Visit } from '@adaxai/contracts'
import { CalendarClock, ChartColumn, CircleCheck, Clock3, type LucideIcon, Moon, Stethoscope, Sun, SunMedium, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DayTrend } from '../../components/doctor/DayTrend.tsx'
import { TodayList, TodayListHeader } from '../../components/doctor/TodayList.tsx'
import { useReadyCue } from '../../components/doctor/useReadyCue.ts'
import { HeroEmpty } from '../../components/hero/HeroEmpty.tsx'
import { Panel } from '../../components/hero/Panel.tsx'
import { statValue } from '../../components/hero/spec.ts'
import { ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { SegmentedControl } from '../../components/ui/SegmentedControl.tsx'
import { useMe } from '../../lib/auth.tsx'
import { firstName, greetingAt, periodFrom, tilesFor, useDoctorDay } from '../../lib/doctorDay.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { EarlierDraftsNotice } from './MyConsultationsPage.tsx'

const AT_A_GLANCE: Record<DoctorDayPeriod, string> = { today: 'Today at a glance', week: 'This week at a glance', month: 'This month at a glance' }

/** One number of the day (premium design): the count, its name, a short line under it, and (UI/UX redesign) an icon disc. */
interface DayCount {
  testId: string
  label: string
  sub: ReactNode
  value: number | null
  icon: LucideIcon
  disc: string
}

/** The tiles' icon discs (decorative; the number and its name carry the meaning). */
const DISCS = {
  green: 'from-emerald-400 to-teal-500',
  teal: 'from-teal-400 to-emerald-500',
  amber: 'from-amber-300 to-orange-400',
  violet: 'from-violet-400 to-indigo-500',
  blue: 'from-sky-400 to-brand',
} as const

/** Today's four numbers (Completed · Waiting · In consultation · Upcoming), each the server's own count. Week and Month keep their tiles. */
function countsFor(period: DoctorDayPeriod, data: DoctorDay | undefined): DayCount[] {
  const c = data && data.period === period ? data.counts : null
  if (period === 'today')
    return [
      { testId: 'day-seen', label: 'Completed', sub: 'Today', value: c?.seen ?? null, icon: CircleCheck, disc: DISCS.green },
      { testId: 'day-waiting', label: 'Waiting', sub: 'In queue', value: c?.waiting ?? null, icon: Clock3, disc: DISCS.teal },
      { testId: 'day-in-consultation', label: 'In consultation', sub: 'Now', value: c?.inConsultation ?? null, icon: Stethoscope, disc: DISCS.amber },
      { testId: 'day-yet-to-see', label: 'Upcoming', sub: 'Booked, not arrived', value: c?.yetToSee ?? null, icon: CalendarClock, disc: DISCS.violet },
    ]
  const looks: { icon: LucideIcon; disc: string }[] = [
    { icon: CircleCheck, disc: DISCS.green },
    { icon: Users, disc: DISCS.blue },
    { icon: CalendarClock, disc: DISCS.violet },
    { icon: Clock3, disc: DISCS.amber },
  ]
  return tilesFor(period, data).map((t, i) => ({ testId: t.testId, label: t.label, sub: t.hint ?? '', value: t.value, ...(looks[i] ?? looks[0]!) }))
}

function CountTile({ t }: { t: DayCount }) {
  const v = statValue(t.value)
  const Icon = t.icon
  // The number stays the tile's first paragraph (what reads a tile, e2e included, takes its first <p>); the disc is decorative.
  return (
    <li data-testid={t.testId} aria-busy={v.missing || undefined} className="flex min-w-0 items-center gap-3.5 rounded-2xl border border-line/70 bg-surface px-4 py-4 shadow-card xl:px-5">
      <span aria-hidden="true" className={`inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-white shadow-[0_8px_18px_-10px_rgb(30_58_138/0.6)] ${t.disc}`}>
        <Icon className="size-6" />
      </span>
      <span className="min-w-0">
        <p className="text-[1.75rem] leading-none font-semibold tracking-tight text-ink tabular-nums">
          {v.missing ? (
            <>
              <span aria-hidden="true">{v.text}</span>
              <span className="sr-only">{v.spoken}</span>
            </>
          ) : (
            v.text
          )}
        </p>
        <p className="mt-1.5 text-sm font-semibold text-ink">{t.label}</p>
        <p className="text-xs text-ink-muted">{t.sub}</p>
      </span>
    </li>
  )
}

/** The greeting's picture (decorative): the sun in the morning and afternoon, the moon in the evening. */
function GreetingIcon({ greeting }: { greeting: string }) {
  const Icon = greeting === 'Good morning' ? Sun : greeting === 'Good afternoon' ? SunMedium : Moon
  const tint = greeting === 'Good evening' ? 'from-indigo-100 to-violet-100 text-indigo-500' : 'from-amber-100 to-orange-100 text-amber-500'
  return (
    <span aria-hidden="true" className={`hidden size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br sm:inline-flex ${tint}`}>
      <Icon className="size-8" />
    </span>
  )
}

/** Today's patients by hour of their appointment or check-in (the queue's own times): the day's activity, from the timeline. */
function hourlyActivity(rows: readonly DoctorDayTimelineRow[]): { hour: number; count: number }[] {
  const hours = rows.map((r) => (r.time ? Number(r.time.slice(0, 2)) : null)).filter((h): h is number => h !== null && Number.isFinite(h))
  if (!hours.length) return []
  const from = Math.min(8, ...hours)
  const to = Math.max(17, ...hours)
  return Array.from({ length: to - from + 1 }, (_, i) => ({ hour: from + i, count: hours.filter((h) => h === from + i).length }))
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`

function TodayActivity({ rows }: { rows: readonly DoctorDayTimelineRow[] }) {
  const bars = hourlyActivity(rows)
  const max = Math.max(1, ...bars.map((b) => b.count))
  return (
    <Panel label="Today’s activity" icon={ChartColumn} testId="home-activity" className="h-full">
      {bars.length ? (
        <>
          <ol aria-hidden="true" className="flex h-36 items-end gap-1.5 border-b border-line/70">
            {bars.map((b) => (
              <li key={b.hour} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${hourLabel(b.hour)}: ${b.count} patient${b.count === 1 ? '' : 's'}`}>
                <span className="block w-full max-w-6 rounded-t-lg bg-gradient-to-t from-brand/85 via-indigo-400/80 to-violet-400/70" style={{ height: b.count ? `${Math.max(8, (b.count / max) * 100)}%` : '3px', opacity: b.count ? 1 : 0.35 }} />
              </li>
            ))}
          </ol>
          <div aria-hidden="true" className="mt-1.5 flex justify-between text-[0.6875rem] text-ink-muted">
            {bars.filter((_, i) => i % 2 === 0).map((b) => (
              <span key={b.hour}>{hourLabel(b.hour)}</span>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-muted">Patients by the hour of their appointment or check-in.</p>
          <p className="sr-only">{bars.filter((b) => b.count).map((b) => `${hourLabel(b.hour)}: ${b.count}`).join(', ')}</p>
        </>
      ) : (
        <HeroEmpty>No patients booked or checked in today.</HeroEmpty>
      )}
    </Panel>
  )
}

/**
 * The doctor's Home (premium design; UI/UX redesign): the greeting and the day, today's four numbers (Completed · Waiting · In consultation ·
 * Upcoming; Week and Month their own), today's patients in time order, each with its one action, and beside them the day's activity by hour
 * (Week and Month: the trend per day). Every number is the server's (GET /api/doctor/day), polled every 30 s while visible; a patient who
 * becomes ready is announced.
 */
export function DoctorHomePage({
  notice,
}: {
  /** Ignored: kept so the route element in App.tsx compiles unchanged. Each row's action is TodayAction (components/doctor). */
  consultationAction?: (v: Visit) => ReactNode
  /** Shown under the title; defaults to the earlier-unsigned-drafts notice. */
  notice?: ReactNode
}) {
  const { data: me } = useMe()
  useDocumentTitle('Home')
  const [params, setParams] = useSearchParams()
  const period = periodFrom(params.get('period'))
  const day = useDoctorDay(period)
  const data = day.data
  useReadyCue(data?.timeline)
  const counts = countsFor(period, data)
  const greeting = greetingAt(new Date(), data?.timezone)
  const longDate = data ? new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${data.today}T00:00:00Z`)) : null

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <GreetingIcon greeting={greeting} />
          <div className="min-w-0">
            <h1 className="text-[2rem] leading-tight font-semibold tracking-tight">
              {greeting}, Dr. {firstName(me?.fullName)}
            </h1>
            <p className="mt-1 text-[0.9375rem] text-ink-muted">{[longDate, me?.departmentName].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <SegmentedControl
          label="Period"
          value={period}
          onChange={(p) => setParams(p === 'today' ? {} : { period: p }, { replace: true, preventScrollReset: true })}
          options={DoctorDayPeriod.options.map((p) => ({ value: p, label: DOCTOR_DAY_PERIOD_LABELS[p] }))}
        />
      </div>
      {notice ?? <EarlierDraftsNotice />}
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] xl:items-stretch">
        <ul role="list" aria-label={AT_A_GLANCE[period]} className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {counts.map((t) => (
            <CountTile key={t.testId} t={t} />
          ))}
        </ul>
        <div className="min-w-0">
          {period === 'today' ? data ? <TodayActivity rows={data.timeline} /> : null : data?.period === period ? <DayTrend period={period} points={data.trend} today={data.today} className="h-full" /> : null}
        </div>
      </div>
      <div className="mt-5">
        <div className="min-w-0">
          <Panel
            label="Today’s patients"
            icon={Users}
            bodyClassName="pt-1 pb-1"
            actions={
              <span className="flex items-center gap-3">
                {data?.period === 'today' && (
                  <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand-strong" data-testid="day-total">
                    {data.counts.total} today{data.counts.inConsultation > 0 ? ` · ${data.counts.inConsultation} in consultation` : ''}
                  </span>
                )}
                <Link to="/doctor/queue" className="inline-flex min-h-9 items-center rounded-lg border border-line px-3 text-sm font-medium text-brand-strong hover:bg-brand-soft/60">
                  View all
                </Link>
              </span>
            }
          >
            {day.isPending && !data && (
              <div className="px-4 pb-3 xl:px-5">
                <LoadingState label="Loading today’s patients…" />
              </div>
            )}
            {day.isError && !data && (
              <div className="px-4 pb-3 xl:px-5">
                <ErrorState title="Today’s patients could not be loaded" error={day.error} onRetry={() => void day.refetch()} retrying={day.isFetching} />
              </div>
            )}
            {day.isError && data && <p className="px-4 pb-2 text-sm text-pending xl:px-5">The latest update failed, so this may be out of date.</p>}
            {data && !data.timeline.length && <HeroEmpty className="px-4 pb-3 xl:px-5">Nobody is booked or checked in for you today.</HeroEmpty>}
            {data && data.timeline.length > 0 && (
              <>
                <TodayListHeader />
                <TodayList rows={data.timeline} today={data.today} label="Today’s patients" />
              </>
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}
