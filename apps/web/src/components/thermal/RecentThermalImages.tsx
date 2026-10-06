import type { ThermalCaptureSource } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Images } from 'lucide-react'
import type { MouseEvent } from 'react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { captureStatusSpec } from '../../lib/thermalStudy.ts'
import { HeroEmpty } from '../hero/HeroEmpty.tsx'
import { Panel } from '../hero/Panel.tsx'
import { Badge, ErrorState, LoadingState } from '../ui/Feedback.tsx'
import { SegmentedControl } from '../ui/SegmentedControl.tsx'
import { Table } from '../ui/Table.tsx'
import { ThermalSourceBadge } from './ThermalSourceBadge.tsx'

/** One row of GET /api/thermal (the facility's recent captures). */
export interface ThermalListItem {
  id: string
  patientId: string
  patientName: string
  mrn: string
  status: 'draft' | 'approved' | 'rejected'
  bodyRegion: string
  createdAt: string
  /** V6: where the image came from (a row without them shows no source rather than a guess). */
  captureSource?: ThermalCaptureSource
  simulated?: boolean
}

type Filter = 'draft' | 'all'

/**
 * "Recent thermal images" on the doctor's Thermal page: the facility's images awaiting a doctor's review (nurse uploads among them), or all
 * recent ones (the latest 50). Each row names the patient and opens the study by its region (`href`); `onOpen` may take the click first (the
 * page asks before unsaved regions are discarded). Simulated images carry their SIMULATED mark.
 */
export function RecentThermalImages({ href, onOpen }: { href: (row: ThermalListItem) => string; onOpen?: ((row: ThermalListItem, e: MouseEvent<HTMLAnchorElement>) => void) | undefined }) {
  const [filter, setFilter] = useState<Filter>('draft')
  const status = filter === 'draft' ? 'draft' : ''
  const q = useQuery({ queryKey: ['thermal', 'list', status], queryFn: () => api<{ captures: ThermalListItem[] }>('/thermal', { query: { status: status || undefined } }), select: (d) => d.captures })
  return (
    <Panel
      label="Recent thermal images"
      icon={Images}
      testId="thermal-recent"
      bodyClassName="pt-2 pb-2"
      actions={
        <SegmentedControl
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'draft', label: 'Awaiting review' },
            { value: 'all', label: 'All recent' },
          ]}
        />
      }
    >
      {q.isPending && (
        <div className="px-4">
          <LoadingState rows={2} label="Loading the thermal images…" />
        </div>
      )}
      {q.isError && (
        <div className="px-4 pb-2">
          <ErrorState title="The thermal images could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      )}
      {q.data && (
        <Table
          caption="Thermal images"
          rows={q.data}
          rowKey={(r) => r.id}
          empty={
            <HeroEmpty className="px-4 xl:px-5">{filter === 'draft' ? 'No thermal image is awaiting review.' : 'No thermal images yet.'}</HeroEmpty>
          }
          columns={[
            {
              key: 'p',
              header: 'Patient',
              cell: (r) => (
                <>
                  <p className="font-medium">{r.patientName}</p>
                  <p className="font-mono text-xs text-ink-muted">{r.mrn}</p>
                </>
              ),
            },
            {
              key: 'r',
              header: 'Region',
              cell: (r) => (
                <Link to={href(r)} onClick={onOpen ? (e) => onOpen(r, e) : undefined} className="font-medium text-brand-strong underline underline-offset-2">
                  {r.bodyRegion}
                </Link>
              ),
            },
            { key: 'src', header: 'Source', cell: (r) => <ThermalSourceBadge capture={r} /> },
            {
              key: 's',
              header: 'Status',
              cell: (r) => {
                const s = captureStatusSpec(r.status)
                return (
                  <Badge tone={s.tone} dot>
                    {s.label}
                  </Badge>
                )
              },
            },
            { key: 'd', header: 'Uploaded', cell: (r) => <span className="whitespace-nowrap tabular-nums">{fmtDateTime(r.createdAt)}</span> },
          ]}
        />
      )}
    </Panel>
  )
}
