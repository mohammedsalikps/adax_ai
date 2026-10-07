import { DOCTOR_DAY_PERIOD_LABELS, DoctorDayPeriod, type DoctorDayTimelineRow, type Visit } from '@adaxai/contracts'
import { CalendarClock, CircleCheck, Clock, Stethoscope, TriangleAlert, UserRound, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DayTrend } from '../../components/doctor/DayTrend.tsx'
import { TodayAction } from '../../components/doctor/TodayAction.tsx'
import { TodayList } from '../../components/doctor/TodayList.tsx'
import { useReadyCue } from '../../components/doctor/useReadyCue.ts'
import { HeroEmpty } from '../../components/hero/HeroEmpty.tsx'
import { PageTitle } from '../../components/hero/PageTitle.tsx'
import { Panel } from '../../components/hero/Panel.tsx'
import { StatTile, type StatTone } from '../../components/hero/StatTile.tsx'
import { PatientAvatar } from '../../components/ui/PatientAvatar.tsx'
import { ageSex } from '../../components/clinical/PatientBanner.tsx'
import { ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { SegmentedControl } from '../../components/ui/SegmentedControl.tsx'
import { useMe } from '../../lib/auth.tsx'
import { facilityDateLine, firstName, greetingAt, periodFrom, tilesFor, todayAction, useDoctorDay } from '../../lib/doctorDay.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { EarlierDraftsNotice } from './MyConsultationsPage.tsx'

const AT_A_GLANCE: Record<DoctorDayPeriod, string> = { today: 'Today at a glance', week: 'This week at a glance', month: 'This month at a glance' }

type TileIcon = Parameters<typeof StatTile>[0]['icon']
/** Each tile's icon and pastel tone (jury design, screen 1). */
const TILE_LOOK: Record<string, { icon: TileIcon; tone: StatTone }> = {
  'day-seen': { icon: CircleCheck, tone: 'ok' },
  'day-waiting': { icon: Clock, tone: 'pending' },
  'day-yet-to-see': { icon: CalendarClock, tone: 'brand' },
  'day-total': { icon: Users, tone: 'neutral' },
  'day-consultations': { icon: Stethoscope, tone: 'brand' },
  'day-completed': { icon: CircleCheck, tone: 'ok' },
  'day-remaining': { icon: Clock, tone: 'pending' },
}

/** The patient the doctor is with (their own consultation in progress), else the next one waiting (ready for the doctor first). */
function currentPatient(rows: readonly DoctorDayTimelineRow[]): { row: DoctorDayTimelineRow; label: string } | null {
  const withMe = rows.find((r) => r.status === 'in_consultation' && r.encounterMine && !r.signedToComplete)
  if (withMe) return { row: withMe, label: 'In consultation' }
  const ready = rows.find((r) => r.status === 'waiting' && r.visitStatus === 'ready')
  if (ready) return { row: ready, label: 'Next patient · ready for you' }
  const waiting = rows.find((r) => r.status === 'waiting')
  return waiting ? { row: waiting, label: 'Next patient' } : null
}

function CurrentPatientCard({ rows }: { rows: readonly DoctorDayTimelineRow[] }) {
  const cur = currentPatient(rows)
  return (
    <Panel label="Current patient" icon={UserRound} testId="home-current-patient">
      {cur ? (
        <div className="space-y-3">
          <p className="text-xs font-semibold tracking-wide text-brand uppercase">{cur.label}</p>
          <div className="flex items-center gap-3">
            <PatientAvatar name={cur.row.patient.fullName} size="lg" />
            <div className="min-w-0">
              <Link to={`/doctor/patients/${cur.row.patient.id}`} className="text-lg font-semibold hover:underline [overflow-wrap:anywhere]">
                {cur.row.patient.fullName}
              </Link>
              <p className="text-sm text-ink-muted">
                {ageSex(cur.row.patient)} · <span className="font-mono">{cur.row.patient.mrn}</span>
              </p>
            </div>
          </div>
          {cur.row.reason && (
            <p className="text-sm">
              <span className="text-ink-muted">Reason: </span>
              {cur.row.reason}
            </p>
          )}
          {cur.row.patient.activeAllergies.length > 0 && (
            <p className="inline-flex items-center gap-1 rounded-full border border-down/25 bg-down-soft px-2 py-0.5 text-xs font-semibold text-down">
              <TriangleAlert aria-hidden="true" className="size-3" />
              Allergy: {cur.row.patient.activeAllergies.join(', ')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {todayAction(cur.row) && <TodayAction row={cur.row} />}
            <Link to={`/doctor/patients/${cur.row.patient.id}`} className="inline-flex min-h-10 items-center rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-canvas">
              View profile
            </Link>
          </div>
        </div>
      ) : (
        <HeroEmpty>Nobody is waiting for you right now.</HeroEmpty>
      )}
    </Panel>
  )
}

/**
 * The doctor's Home (DESIGN §5.1): the greeting and the facility's date, a Today | Week | Month period (in the URL, `?period=`), the period's
 * numbers from GET /api/doctor/day (Week and Month also a small trend), and always today's patients in time order, each with its one action.
 * Polled every 30 s while visible; a patient who becomes ready is announced. No quick actions, booking, registration or check-in here.
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
  const tiles = tilesFor(period, data)
  // The trend beside today's patients: the period's own, or this week's on Today (the same request Week makes).
  const trendPeriod = period === 'today' ? 'week' : period
  const trendDay = useDoctorDay(trendPeriod)

  const subtitle = [data ? facilityDateLine(data.today) : null, me?.departmentName].filter(Boolean).join(' · ')
  return (
    <>
      <PageTitle
        title={`${greetingAt(new Date(), data?.timezone)}, Dr. ${firstName(me?.fullName)}`}
        subtitle={subtitle || undefined}
        actions={
          <SegmentedControl
            label="Period"
            value={period}
            onChange={(p) => setParams(p === 'today' ? {} : { period: p }, { replace: true, preventScrollReset: true })}
            options={DoctorDayPeriod.options.map((p) => ({ value: p, label: DOCTOR_DAY_PERIOD_LABELS[p] }))}
          />
        }
      />
      {notice ?? <EarlierDraftsNotice />}

      <ul role="list" aria-label={AT_A_GLANCE[period]} className={`mb-6 grid grid-cols-2 gap-3 ${tiles.length === 4 ? 'md:grid-cols-4' : 'sm:grid-cols-3'}`}>
        {tiles.map((t, i) => (
          // Three tiles (Month): the third spans the row on a phone rather than standing alone.
          <StatTile key={t.testId} as="li" label={t.label} value={t.value} hint={t.hint} testId={t.testId} icon={TILE_LOOK[t.testId]?.icon} tone={TILE_LOOK[t.testId]?.tone} className={tiles.length === 3 && i === 2 ? 'col-span-2 sm:col-span-1' : ''} />
        ))}
      </ul>

      {/* The patient the doctor is with (or the next one) beside the period's trend, then today's patients in full width. */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-stretch [&>*]:min-w-0">
        {data && <CurrentPatientCard rows={data.timeline} />}
        {trendDay.data?.period === trendPeriod && <DayTrend period={trendPeriod} points={trendDay.data.trend} today={trendDay.data.today} className="" />}
      </div>
      <Panel
        label="Today’s patients"
        icon={Users}
        bodyClassName="pt-1 pb-1"
        actions={
          <Link to="/doctor/queue" className="inline-flex min-h-9 items-center rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-canvas hover:underline">
            View all
          </Link>
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
        {data && !data.timeline.length && (
          <HeroEmpty className="px-4 pb-3 xl:px-5">Nobody is booked or checked in for you today.</HeroEmpty>
        )}
        {data && data.timeline.length > 0 && <TodayList rows={data.timeline} today={data.today} label="Today’s patients" />}
      </Panel>
    </>
  )
}
