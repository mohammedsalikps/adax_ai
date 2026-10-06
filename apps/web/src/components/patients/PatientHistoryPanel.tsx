import { type Encounter, MANA_QUESTIONS, type PatientHistory } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, History, ListTree, Sparkles } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { api } from '../../lib/api.ts'
import { historyKey } from '../../lib/history.ts'
import { openMana } from '../../lib/manaLauncher.ts'
import { localToday, type RecordLine, recordLines } from '../../lib/patientRecord.ts'
import { Panel, SourceTag } from '../hero/index.ts'
import { Button } from '../ui/Button.tsx'
import { RecordLines } from './RecordLines.tsx'

/** Props of the consultation's patient history panel (DESIGN §5.4 column 3, §7). */
export interface PatientHistoryPanelProps {
  encounter: Encounter
  /** [View details]: opens the patient profile drawer on its Details tab. */
  onViewDetails: () => void
  /** [Documents]: opens the patient profile drawer on its Documents tab. */
  onDocuments: () => void
  /**
   * Optional, additive to the DESIGN §7 contract: what follows in the same panel below a divider (the workspace puts the Orders group here,
   * as a `PanelGroup`).
   */
  children?: ReactNode
}

/*
 * The history this panel shows is the one the consultation already reads (and re-reads every two minutes: the header's allergy chips,
 * useAllergies / usePatientHistory({poll: true})), observed with the same key and function and never enabled here. Each read of the history is
 * audited, so this panel asks for none.
 */
const historyQuery = (patientId: string) => ({ queryKey: historyKey(patientId), queryFn: () => api<PatientHistory>(`/patients/${patientId}/history`), enabled: false }) as const

/** The lines, or null when the answer cannot be read (it is then "could not be read", never an empty record). */
function safeLines(h: PatientHistory | undefined): RecordLine[] | null {
  if (!h) return null
  try {
    return recordLines(h, localToday())
  } catch {
    return null
  }
}

/** The text the [Summarize with Mana] button asks: the existing "brief me" suggestion, so the answer is the one Mana already plans for it. */
export const SUMMARIZE_WITH_MANA_ASK = MANA_QUESTIONS.brief_current.label

/**
 * The compact "Patient history" panel inside the consultation: allergies, conditions, surgeries, medicines, recent results and imaging, the
 * last consultation — "From the record" (fixed rules over the record, never AI) — with [View details], [Documents] and [Summarize with Mana]
 * (opens the global Mana, which asks the "brief me" question for this consultation: on demand, never automatically). Missing is said as
 * "Not recorded", never as none.
 *
 * Owner: the Patients unit. Contract (DESIGN §7): `PatientHistoryPanel({encounter, onViewDetails, onDocuments})` (+ optional `children`).
 */
export function PatientHistoryPanel({ encounter, onViewDetails, onDocuments, children }: PatientHistoryPanelProps) {
  const q = useQuery(historyQuery(encounter.patient.id))
  const [manaMissing, setManaMissing] = useState(false)
  const lines = safeLines(q.data)
  const unreadable = (q.data !== undefined && !lines) || (q.isError && !q.data)
  const summarize = () => setManaMissing(!openMana({ ask: SUMMARIZE_WITH_MANA_ASK }))
  return (
    <Panel label="Patient history" icon={History} testId="patient-history-panel" actions={<SourceTag kind="record" />}>
      {!lines && !unreadable && (
        <div aria-busy="true" className="space-y-2 py-1" data-testid="patient-history-loading">
          <p className="sr-only">Reading the patient’s history…</p>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} aria-hidden="true" className="h-4 rounded bg-canvas motion-safe:animate-pulse" style={{ width: `${88 - i * 12}%` }} />
          ))}
        </div>
      )}
      {unreadable && <p className="text-sm text-ink-muted">The patient’s history could not be read just now.</p>}
      {lines && (
        <>
          {q.isError && <p className="mb-2 text-xs text-pending">The latest update failed, so this may be out of date.</p>}
          <RecordLines lines={lines} />
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<ListTree aria-hidden="true" className="size-4" />} onClick={onViewDetails}>
          View details
        </Button>
        <Button size="sm" variant="secondary" icon={<FolderOpen aria-hidden="true" className="size-4" />} onClick={onDocuments}>
          Documents
        </Button>
        <Button size="sm" variant="ghost" icon={<Sparkles aria-hidden="true" className="size-4 text-ai" />} onClick={summarize} data-testid="summarize-with-mana">
          Summarize with Mana
        </Button>
      </div>
      {/* A live region present from the start, so the message is announced when it appears. */}
      <p role="status" className={`text-xs text-ink-muted ${manaMissing ? 'mt-2' : ''}`}>
        {manaMissing ? 'Mana is not available on this page.' : ''}
      </p>
      {children}
    </Panel>
  )
}
