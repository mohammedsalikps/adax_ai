import { FileStack } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { TodayList, TodayListHeader } from '../../components/doctor/TodayList.tsx'
import { useReadyCue } from '../../components/doctor/useReadyCue.ts'
import { HeroEmpty } from '../../components/hero/HeroEmpty.tsx'
import { PageTitle } from '../../components/hero/PageTitle.tsx'
import { ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { SegmentedControl } from '../../components/ui/SegmentedControl.tsx'
import { completedFrom, facilityDateLine, filterCounts, filterTimeline, QUEUE_FILTER_EMPTY, QUEUE_FILTER_LABELS, QUEUE_FILTERS, type QueueFilter, useDoctorDay } from '../../lib/doctorDay.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { EarlierDraftsNotice } from './MyConsultationsPage.tsx'

/**
 * My consultations (`/doctor/queue`; DESIGN §5.2): the doctor's working queue. Today's patients in time order (time · patient · status · one
 * action), the same rows as Home (TodayRow) including those yet to see (no action) and completed (Open), filtered All · Waiting · Completed.
 * A quiet link leads to the drafts and signed records (/doctor/consultations), and unsigned drafts from earlier days are flagged above. The
 * list keeps `aria-label="Visits"` and its rows stay list items (e2e). Polled every 30 s while visible; a patient who becomes ready is
 * announced; coming back from completing a consultation, its row is highlighted. No booking, day picker, whole-clinic view or admin row menus
 * here (the nurse's queue keeps them).
 */
export function MyConsultationsQueuePage() {
  useDocumentTitle('My consultations')
  const day = useDoctorDay('today')
  const data = day.data
  useReadyCue(data?.timeline)
  const [filter, setFilter] = useState<QueueFilter>('all')
  const location = useLocation()
  const completedId = completedFrom(location.state)
  const highlightKey = (completedId && data?.timeline.find((r) => r.encounterId === completedId)?.key) || null
  const counts = data ? filterCounts(data.timeline) : null
  const rows = data ? filterTimeline(data.timeline, filter) : []

  // The completed row is brought into view once, when it first appears.
  useEffect(() => {
    if (!highlightKey) return
    document.querySelector(`[data-row-key="${CSS.escape(highlightKey)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [highlightKey])

  return (
    <>
      <PageTitle
        title="My consultations"
        subtitle={data ? facilityDateLine(data.today) : undefined}
        actions={
          <Link to="/doctor/consultations" className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-surface hover:underline">
            <FileStack aria-hidden="true" className="size-4" />
            Drafts and signed records
          </Link>
        }
      />
      <EarlierDraftsNotice />
      <div className="mb-4">
        <SegmentedControl
          label="Show"
          value={filter}
          onChange={setFilter}
          options={QUEUE_FILTERS.map((f) => ({
            value: f,
            label: (
              <>
                {QUEUE_FILTER_LABELS[f]}
                {counts && <span className="ml-1.5 text-xs tabular-nums opacity-80">{counts[f]}</span>}
              </>
            ),
          }))}
        />
      </div>
      {day.isPending && !data && <LoadingState rows={4} label="Loading today’s patients…" />}
      {day.isError && !data && <ErrorState title="Today’s patients could not be loaded" error={day.error} onRetry={() => void day.refetch()} retrying={day.isFetching} />}
      {day.isError && data && <p className="mb-3 text-sm text-pending">The latest update failed, so this may be out of date.</p>}
      {data &&
        (rows.length ? (
          <div className="overflow-hidden rounded-2xl border border-line/70 bg-surface pt-2 shadow-card">
            <TodayListHeader />
            <TodayList rows={rows} today={data.today} label="Visits" highlightKey={highlightKey} />
          </div>
        ) : (
          <div className="rounded-2xl border border-line/70 bg-surface px-4 py-3 shadow-card xl:px-5">
            <HeroEmpty>{QUEUE_FILTER_EMPTY[data.timeline.length ? filter : 'all']}</HeroEmpty>
          </div>
        ))}
    </>
  )
}
