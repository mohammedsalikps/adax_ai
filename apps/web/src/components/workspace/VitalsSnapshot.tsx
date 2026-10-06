import type { Encounter, Visit } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.ts'
import { noAdultFlags, previousVitals, type SnapshotItem, vitalsSnapshot } from '../../lib/clinicalInputs.ts'
import { fmtDate, fmtTime } from '../../lib/format.ts'
import { FlagLabel } from '../clinical/Vitals.tsx'
import { SourceTag } from '../hero/SourceTag.tsx'

export interface VitalsSnapshotProps {
  encounter: Encounter
}

/**
 * The patient's earlier visits, read ONCE for the page (each read is audited as visit.list): never polled, never re-read on focus, and under a key
 * of its own so that saving vitals (which refreshes the patient's queries) does not read them again. Only the previous values are kept.
 */
function usePreviousVitals(patientId: string, visit: { id: string; visitDate: string }) {
  return useQuery({
    queryKey: ['vitals-snapshot', patientId, 'visits'],
    queryFn: () => api<{ visits: Visit[] }>(`/patients/${patientId}/visits`),
    select: (d) => previousVitals(d?.visits, visit),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })
}

const sourceWords = (it: SnapshotItem) => (it.device ? 'from a device that is not validated' : 'measured by staff')

function titleOf(it: SnapshotItem): string {
  const now = it.text ? `${it.label} ${it.text}, ${sourceWords(it)}, ${fmtTime(it.at)}` : `${it.label}: not recorded in this visit`
  return it.previous ? `${now}. Previous visit (${fmtDate(it.previous.date)}): ${it.previous.text}` : now
}

/**
 * The header's "Last vitals" line (DESIGN §5.4): "HR 124 · BP 118/76 · SpO₂ 96% · Temp 38.6°C", from the consultation's own vital signs only
 * (Encounter.vitals: what staff measured, else what a device stored with the visit; never a simulator's value). A device's value is marked
 * UNVERIFIED; a kind with no value says "not recorded"; the previous visit's value follows, muted ("prev 110"), when there is one. No reference
 * flag under 18 (none is implemented for children).
 */
export function VitalsSnapshot({ encounter }: VitalsSnapshotProps) {
  const prev = usePreviousVitals(encounter.patient.id, encounter.visit)
  const items = vitalsSnapshot({ vitals: encounter.vitals, previous: prev.data ?? null, paediatric: noAdultFlags(encounter.patient.dateOfBirth) })
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm" data-testid="vitals-snapshot">
      <span className="text-xs font-medium text-ink-muted">Last vitals</span>
      {items.map((it, i) => (
        <span key={it.key} className="inline-flex flex-wrap items-baseline gap-x-1" title={titleOf(it)} data-testid="vitals-snapshot-item" data-kind={it.key} data-source={it.text ? (it.device ? 'device' : 'staff') : 'none'}>
          {i > 0 && (
            <span aria-hidden="true" className="text-ink-muted">
              ·
            </span>
          )}
          <span className="text-ink-muted">{it.short}</span>
          {it.text ? <span className="font-semibold tabular-nums">{it.text}</span> : <span className="text-ink-muted">not recorded</span>}
          {it.flag && <FlagLabel flag={it.flag} />}
          {it.device && (
            <>
              <SourceTag kind="device" />
              <span className="sr-only"> from a device that is not validated</span>
            </>
          )}
          {it.previous && (
            <span className="text-xs text-ink-muted tabular-nums">
              prev {it.previous.text}
              <span className="sr-only"> at the visit of {fmtDate(it.previous.date)}</span>
            </span>
          )}
        </span>
      ))}
    </p>
  )
}
