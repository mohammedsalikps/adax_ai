import type { Encounter, PatientHistory } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'
import { historyKey } from '../../../lib/history.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { CLOSED_ONLY, OPEN_ONLY } from '../ModuleShell.tsx'
import { historyCore, historyState, historyView, NOT_UPDATED, safely, type SummaryState } from './state.ts'

/*
 * Module 2, the patient's history: the record the consultation's banner already reads (and re-reads every two minutes) and the past-history
 * panel shows, observed with the same key and function and never enabled. Each read of the history is audited, so this file asks for none:
 * it only shows what the banner and the panel last read.
 */

const historyQuery = (patientId: string) => ({ queryKey: historyKey(patientId), queryFn: () => api<PatientHistory>(`/patients/${patientId}/history`), enabled: false }) as const

/**
 * For the page: the history module's chip, what the workflow strip counts (entries, and whether the allergy status is recorded; null until read),
 * and how this screen holds the history (for the analysis' list of inputs).
 */
export function useHistoryModule(encounter: Pick<Encounter, 'patient'>): { state: SummaryState; facts: InputModuleFacts['history']; status: 'loaded' | 'loading' | 'error' } {
  const q = useQuery({ ...historyQuery(encounter.patient.id), select: historyCore })
  // An answer the screen cannot read (null here) is "Not updated", as a failed read is.
  return { state: historyState(q.data, q.isError), facts: q.data ?? null, status: q.data ? 'loaded' : q.data === null || q.isError ? 'error' : 'loading' }
}

function useHistoryView(encounter: Pick<Encounter, 'patient' | 'visit'>) {
  const q = useQuery(historyQuery(encounter.patient.id))
  return safely(() => historyView({ history: q.data, failed: q.isError, reasonForVisit: encounter.visit?.reasonForVisit }), {
    state: NOT_UPDATED,
    facts: null,
    status: 'error' as const,
    message: 'The patient’s history could not be read just now.',
    allergies: null,
    conditions: null,
    record: null,
    counts: null,
    reason: null,
    meta: null,
  })
}

const ALLERGY_TONE = { down: 'font-medium text-down', warn: 'font-medium text-pending', neutral: 'font-medium' } as const

/**
 * The summary of module 2: the allergies with their severity (or that none are known, or that the status is not recorded), always. Closed, one
 * more line counts the open conditions and the current medicines; open, the conditions are named (three, then "+n"), with the current
 * medicines, results and the last consultation, and the reason for this visit.
 */
export function HistorySummary({ encounter }: { encounter: Pick<Encounter, 'patient' | 'visit'> }) {
  const v = useHistoryView(encounter)
  return (
    <div className="flex flex-col gap-0.5" data-testid="summary-history" data-state={v.state.kind}>
      {v.message && <p className="text-ink-muted">{v.message}</p>}
      {v.allergies && (
        <p className={ALLERGY_TONE[v.allergies.tone]} data-testid="summary-history-allergies">
          {v.allergies.text}
        </p>
      )}
      {v.counts && <p className={`text-ink-muted ${CLOSED_ONLY}`}>{v.counts}</p>}
      <div className={`space-y-0.5 ${OPEN_ONLY}`}>
        {v.conditions && <p>{v.conditions}</p>}
        {v.record && <p className="text-ink-muted">{v.record}</p>}
        {v.reason && <p className="text-ink-muted">{v.reason}</p>}
      </div>
    </div>
  )
}

/** Where the history came from and when: the patient's record, as of the time the server put it together. */
export function HistoryMeta({ encounter }: { encounter: Pick<Encounter, 'patient' | 'visit'> }) {
  const v = useHistoryView(encounter)
  return v.meta ? <span data-testid="summary-history-meta">{v.meta}</span> : null
}
