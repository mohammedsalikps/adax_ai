import type { Visit } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'
import { usePatientLookup } from '../../lib/clinical.ts'
import { fmtTime } from '../../lib/format.ts'
import { thermalQuickPicks } from '../../lib/thermalStudy.ts'
import { PanelGroup } from '../hero/Panel.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { TextField } from '../ui/Form.tsx'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'

const MAX_MATCHES = 6

/**
 * Choosing the patient on the Thermal page: one search field (nothing is searched before two characters, and only the current term's matches
 * are shown, as in the appointment dialog's picker) and today's patients of the doctor as quick picks (GET /api/visits?mine=true, the same
 * list as My consultations, read once and kept for 30 seconds; no polling). A thermal image always belongs to one patient.
 */
export function ThermalPatientPicker({ onChoose }: { onChoose: (patientId: string) => void }) {
  const [search, setSearch] = useState('')
  const lookup = usePatientLookup(search)
  const today = useQuery({
    queryKey: ['visits', { mine: true }],
    queryFn: () => api<{ date: string; visits: Visit[] }>('/visits', { query: { mine: 'true' } }),
    staleTime: 30_000,
  })
  const picks = today.data ? thermalQuickPicks(today.data.visits) : []
  return (
    <div className="space-y-1" data-testid="thermal-patient-picker">
      <PanelGroup>
        <TextField
          label="Find the patient"
          hint="Name, MRN or phone number (at least 2 characters)."
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          // The page's one job starts here: the field takes the focus when the page opens without a patient.
          autoFocus
        />
        {lookup.status === 'searching' && (
          <p role="status" className="mt-2 flex items-center gap-2 text-sm text-ink-muted">
            <Search aria-hidden="true" className="size-4" />
            Searching…
          </p>
        )}
        {lookup.status === 'error' && (
          <Alert tone="error" className="mt-2">
            <p>{errorMessage(lookup.error)}</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={lookup.retry}>
              Try again
            </Button>
          </Alert>
        )}
        {lookup.status === 'done' && (
          <p role="status" className="sr-only">
            {lookup.patients.length > MAX_MATCHES ? `${lookup.patients.length} patients found; the first ${MAX_MATCHES} are listed.` : `${lookup.patients.length} patients found.`}
          </p>
        )}
        {lookup.status === 'done' && lookup.patients.length > 0 && (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line" aria-label="Matching patients">
            {lookup.patients.slice(0, MAX_MATCHES).map((p) => (
              <li key={p.id}>
                <button type="button" className="flex min-h-control w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-canvas" onClick={() => onChoose(p.id)}>
                  <PatientAvatar name={p.fullName} size="sm" />
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{p.fullName}</span>
                  <span className="font-mono text-xs text-ink-muted">{p.mrn}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {lookup.status === 'done' && lookup.patients.length > MAX_MATCHES && <p className="mt-1 text-xs text-ink-muted">Showing the first {MAX_MATCHES} matches. Type more to narrow them.</p>}
        {lookup.status === 'done' && !lookup.patients.length && <p className="mt-2 text-sm text-ink-muted">No patient matches “{search.trim()}”.</p>}
      </PanelGroup>
      <PanelGroup label="Today’s patients">
        {today.isPending && <p className="text-sm text-ink-muted">Loading today’s patients…</p>}
        {today.isError && (
          <p className="text-sm text-ink-muted">
            Today’s patients could not be loaded.{' '}
            <Button size="sm" variant="ghost" onClick={() => void today.refetch()}>
              Try again
            </Button>
          </p>
        )}
        {today.data && !picks.length && <p className="text-sm text-ink-muted">No patients on your list today. Search above.</p>}
        {picks.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Today’s patients">
            {picks.map((p) => (
              <li key={p.patientId}>
                <button
                  type="button"
                  onClick={() => onChoose(p.patientId)}
                  className="inline-flex min-h-control items-center gap-2 rounded-full border border-line bg-surface py-1 pr-3.5 pl-1.5 text-sm hover:bg-canvas"
                >
                  <PatientAvatar name={p.fullName} size="sm" />
                  <span className="font-medium">{p.fullName}</span>
                  <span className="text-xs text-ink-muted tabular-nums">{fmtTime(p.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelGroup>
    </div>
  )
}
