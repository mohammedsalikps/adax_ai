import { DOCTOR_DAY_PERIOD_LABELS, DoctorDayPeriod, type Visit } from '@adaxai/contracts'
import { Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DayTrend } from '../../components/doctor/DayTrend.tsx'
import { TodayList } from '../../components/doctor/TodayList.tsx'
import { useReadyCue } from '../../components/doctor/useReadyCue.ts'
import { HeroEmpty } from '../../components/hero/HeroEmpty.tsx'
import { PageTitle } from '../../components/hero/PageTitle.tsx'
import { Panel } from '../../components/hero/Panel.tsx'
import { StatTile } from '../../components/hero/StatTile.tsx'
import { ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { SegmentedControl } from '../../components/ui/SegmentedControl.tsx'
import { useMe } from '../../lib/auth.tsx'
import { facilityDateLine, firstName, greetingAt, periodFrom, tilesFor, useDoctorDay } from '../../lib/doctorDay.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { EarlierDraftsNotice } from './MyConsultationsPage.tsx'

const AT_A_GLANCE: Record<DoctorDayPeriod, string> = { today: 'Today at a glance', week: 'This week at a glance', month: 'This month at a glance' }

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
          <StatTile key={t.testId} as="li" label={t.label} value={t.value} hint={t.hint} testId={t.testId} className={tiles.length === 3 && i === 2 ? 'col-span-2 sm:col-span-1' : ''} />
        ))}
      </ul>

      {period !== 'today' && data?.period === period && <DayTrend period={period} points={data.trend} today={data.today} />}

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
