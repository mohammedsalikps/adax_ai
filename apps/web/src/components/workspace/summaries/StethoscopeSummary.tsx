import type { AuscultationRecording, Encounter, PatientDetail } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'
import { patientKey } from '../../../lib/clinical.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { auscultationsKey } from '../../clinical/AuscultationCard.tsx'
import { SimulatedBadge } from '../../clinical/DeviceReadingsCard.tsx'
import { CLOSED_ONLY, OPEN_ONLY } from '../ModuleShell.tsx'
import { consentOf, NOT_UPDATED, safely, STETHOSCOPE_HONESTY, stethoscopeCore, stethoscopeState, stethoscopeView, type SummaryState } from './state.ts'

/*
 * Module 4, the stethoscope: the recordings the "Stethoscope recordings" card already read, and the patient's consents its card and the
 * thermal panel read, both observed with their owners' keys and functions and never enabled: nothing is asked of the server from this file.
 * Nothing here plays, measures or analyses a recording.
 */

const recordingsQuery = (patientId: string) => ({ queryKey: auscultationsKey(patientId), queryFn: () => api<{ recordings: AuscultationRecording[] }>(`/patients/${patientId}/auscultations`), enabled: false }) as const
const patientQuery = (patientId: string) => ({ queryKey: patientKey(patientId), queryFn: () => api<PatientDetail>(`/patients/${patientId}`), enabled: false }) as const

const deviceConsent = (p: PatientDetail) => consentOf(p, 'device_monitoring')

/** For the page: the stethoscope module's chip and what the workflow strip counts (this consultation's recordings, and the simulated ones; null until read). */
export function useStethoscopeModule(encounter: Pick<Encounter, 'id' | 'patient'>): { state: SummaryState; facts: InputModuleFacts['stethoscope'] } {
  const id = encounter.id
  const recordings = useQuery({ ...recordingsQuery(encounter.patient.id), select: (d: { recordings: AuscultationRecording[] } | null) => stethoscopeCore(d?.recordings, id) })
  const consent = useQuery({ ...patientQuery(encounter.patient.id), select: deviceConsent })
  const core = recordings.data
  return { state: stethoscopeState(core, consent.data ?? null, recordings.isError), facts: core ? { recordings: core.recordings, simulated: core.simulated } : null }
}

function useStethoscopeView(encounter: Pick<Encounter, 'id' | 'patient'>) {
  const recordings = useQuery(recordingsQuery(encounter.patient.id))
  const patient = useQuery(patientQuery(encounter.patient.id))
  return safely(() => stethoscopeView({ recordings: recordings.data === undefined ? undefined : (recordings.data?.recordings ?? null), failed: recordings.isError, patient: patient.data, encounterId: encounter.id }), {
    state: NOT_UPDATED,
    facts: null,
    compact: 'The recordings could not be read just now.',
    count: 'The recordings could not be read just now.',
    last: null,
    consentLine: null,
    meta: null,
  })
}

/**
 * The summary of module 4. Closed: how many recordings this consultation has with the newest one's site and length ("1 recording · Mitral
 * area · 0:02"), SIMULATED AUDIO when a simulator made it, and "Not analysed". Open: the same in full (and who timed the length: the browser,
 * a gateway, or nobody), and always that recordings are not analysed and that no stethoscope has been connected to or tested with this system.
 */
export function StethoscopeSummary({ encounter }: { encounter: Pick<Encounter, 'id' | 'patient'> }) {
  const v = useStethoscopeView(encounter)
  return (
    <div data-testid="summary-stethoscope" data-state={v.state.kind}>
      <div className={`space-y-0.5 ${CLOSED_ONLY}`}>
        <p>{v.compact}</p>
        {v.last && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-ink-muted">
            <span>Not analysed</span>
            {v.last.simulated && <SimulatedBadge what="SIMULATED AUDIO" compact />}
          </p>
        )}
        {v.consentLine && <p className="text-pending">{v.consentLine}</p>}
      </div>
      <div className={`space-y-0.5 ${OPEN_ONLY}`}>
        <p>{v.count}</p>
        {v.last && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5" data-testid="summary-stethoscope-last" data-simulated={v.last.simulated}>
            <span>
              Newest: {v.last.site} · {v.last.length}
            </span>
            {v.last.simulated && <SimulatedBadge what="SIMULATED AUDIO" compact />}
          </p>
        )}
        {v.consentLine && <p className="text-pending">{v.consentLine}</p>}
        {/* Said on the screen by the recordings card under it (once); here for whoever reads the summary alone. */}
        <p className="sr-only" data-testid="summary-stethoscope-honesty">
          {STETHOSCOPE_HONESTY}
        </p>
      </div>
    </div>
  )
}

/** Where the newest recording came from and when: how it was captured (browser, file, gateway), who added it, the time. */
export function StethoscopeMeta({ encounter }: { encounter: Pick<Encounter, 'id' | 'patient'> }) {
  const v = useStethoscopeView(encounter)
  return v.meta ? <span data-testid="summary-stethoscope-meta">{v.meta}</span> : null
}
