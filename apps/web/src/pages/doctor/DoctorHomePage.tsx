import { DOCTOR_DAY_PERIOD_LABELS, type DoctorDay, DoctorDayPeriod, type DoctorDayTimelineRow, type Visit } from '@adaxai/contracts'
import { ChartColumn, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DayTrend } from '../../components/doctor/DayTrend.tsx'
import { TodayList } from '../../components/doctor/TodayList.tsx'
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

/** One number of the day (premium design): the count large in its colour, its name, and a short line under it. */
interface DayCount {
  testId: string
  label: string
  sub: ReactNode
  value: number | null
  colour: string
}

/** Today's four numbers (Completed · Waiting · In consultation · Upcoming), each the server's own count. Week and Month keep their tiles. */
function countsFor(period: DoctorDayPeriod, data: DoctorDay | undefined): DayCount[] {
  const c = data && data.period === period ? data.counts : null
  if (period === 'today')
    return [
      { testId: 'day-seen', label: 'Completed', sub: 'Today', value: c?.seen ?? null, colour: 'text-emerald-600' },
      { testId: 'day-waiting', label: 'Waiting', sub: 'In queue', value: c?.waiting ?? null, colour: 'text-orange-500' },
      { testId: 'day-in-consultation', label: 'In consultation', sub: 'Now', value: c?.inConsultation ?? null, colour: 'text-brand' },
      { testId: 'day-yet-to-see', label: 'Upcoming', sub: 'Booked, not arrived', value: c?.yetToSee ?? null, colour: 'text-violet-600' },
    ]
  const colours = ['text-emerald-600', 'text-brand', 'text-violet-600', 'text-orange-500']
  return tilesFor(period, data).map((t, i) => ({ testId: t.testId, label: t.label, sub: t.hint ?? '', value: t.value, colour: colours[i] ?? 'text-ink' }))
}

function CountTile({ t }: { t: DayCount }) {
  const v = statValue(t.value)
  return (
    <li data-testid={t.testId} aria-busy={v.missing || undefined} className="min-w-0 rounded-2xl border border-line/80 bg-surface px-4 py-4 shadow-card">
      <p className={`text-3xl leading-none font-semibold tabular-nums ${t.colour}`}>
        {v.missing ? (
          <>
            <span aria-hidden="true">{v.text}</span>
            <span className="sr-only">{v.spoken}</span>
          </>
        ) : (
          v.text
        )}
      </p>
      <p className="mt-2 text-sm font-semibold text-ink">{t.label}</p>
      <p className="text-xs text-ink-muted">{t.sub}</p>
    </li>
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
          <ol aria-hidden="true" className="flex h-32 items-end gap-1.5">
            {bars.map((b) => (
              <li key={b.hour} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${hourLabel(b.hour)}: ${b.count} patient${b.count === 1 ? '' : 's'}`}>
                <span className="block w-full max-w-5 rounded-t-md bg-gradient-to-t from-brand/70 to-ai/60" style={{ height: b.count ? `${Math.max(8, (b.count / max) * 100)}%` : '3px', opacity: b.count ? 1 : 0.35 }} />
              </li>
            ))}
          </ol>
          <div aria-hidden="true" className="mt-1.5 flex justify-between text-[0.6875rem] text-ink-muted">
            {bars.filter((_, i) => i % 2 === 0).map((b) => (
              <span key={b.hour}>{hourLabel(b.hour)}</span>
            ))}
          </div>
          <p className="sr-only">{bars.filter((b) => b.count).map((b) => `${hourLabel(b.hour)}: ${b.count}`).join(', ')}</p>
        </>
      ) : (
        <HeroEmpty>No patients booked or checked in today.</HeroEmpty>
      )}
    </Panel>
  )
}

/**
 * The doctor's Home (premium design): the greeting and the day, today's four numbers (Completed · Waiting · In consultation · Upcoming; Week and
 * Month their own), the day's activity by hour (Week and Month: the trend per day), and today's patients in time order, each with its one action.
 * Every number is the server's (GET /api/doctor/day), polled every 30 s while visible; a patient who becomes ready is announced.
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
  const longDate = data ? new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${data.today}T00:00:00Z`)) : null

  return (
    <>
      <div className="mb-6 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:items-stretch">
        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">
                {greetingAt(new Date(), data?.timezone)}, Dr. {firstName(me?.fullName)}
              </h1>
              <p className="mt-1 text-sm text-ink-muted">{[longDate, me?.departmentName].filter(Boolean).join(' · ')}</p>
            </div>
            <SegmentedControl
              label="Period"
              value={period}
              onChange={(p) => setParams(p === 'today' ? {} : { period: p }, { replace: true, preventScrollReset: true })}
              options={DoctorDayPeriod.options.map((p) => ({ value: p, label: DOCTOR_DAY_PERIOD_LABELS[p] }))}
            />
          </div>
          {notice ?? <EarlierDraftsNotice />}
          <ul role="list" aria-label={AT_A_GLANCE[period]} className={`mt-5 grid grid-cols-2 gap-3 ${counts.length === 4 ? 'md:grid-cols-4' : 'sm:grid-cols-3'}`}>
            {counts.map((t) => (
              <CountTile key={t.testId} t={t} />
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          {period === 'today' ? data ? <TodayActivity rows={data.timeline} /> : null : data?.period === period ? <DayTrend period={period} points={data.trend} today={data.today} className="h-full" /> : null}
        </div>
      </div>

      <Panel
        label="Today’s patients"
        icon={Users}
        bodyClassName="pt-1 pb-1"
        actions={
          <span className="flex items-center gap-3">
            {data?.period === 'today' && (
              <span className="text-xs text-ink-muted" data-testid="day-total">
                {data.counts.total} today{data.counts.inConsultation > 0 ? ` · ${data.counts.inConsultation} in consultation` : ''}
              </span>
            )}
            <Link to="/doctor/queue" className="inline-flex min-h-9 items-center rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-canvas hover:underline">
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
        {data && data.timeline.length > 0 && <TodayList rows={data.timeline} today={data.today} label="Today’s patients" />}
      </Panel>
    </>
  )
}
