import type { CompleteEncounterResult, Encounter } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, Printer } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, api, errorMessage } from '../../lib/api.ts'
import { encounterKey } from '../../lib/encounters.ts'
import { Button } from '../ui/Button.tsx'
import { ConfirmationDialog } from '../ui/ConfirmationDialog.tsx'
import { useToast } from '../ui/Toast.tsx'
import { SECONDARY_CONTROL } from './RepeatMedicineMenu.tsx'
import { completionToast } from './rxModel.ts'

/** The printed prescription of a consultation (a new tab: the consultation stays open here). */
export const printUrl = (encounterId: string) => `/print/encounters/${encounterId}`

/**
 * Completes the signed consultation (POST /api/encounters/:id/complete, the signing doctor only): the visit is completed, the record and its
 * prescription reach the patient app, the queue counts the patient as seen. Then the doctor goes back to My consultations with the row
 * highlighted. A second completion (another tab did it) is treated as done.
 */
export function useCompleteConsultation(e: Pick<Encounter, 'id' | 'version' | 'patient'>) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: encounterKey(e.id) })
    void qc.invalidateQueries({ queryKey: ['visits'] })
    void qc.invalidateQueries({ queryKey: ['appointments'] })
    void qc.invalidateQueries({ queryKey: ['doctor-day'] })
    void qc.invalidateQueries({ queryKey: ['my-consultations'] })
    void qc.invalidateQueries({ queryKey: ['patient', e.patient.id] })
  }
  const done = () => navigate('/doctor/queue', { state: { completedEncounterId: e.id } })
  return useMutation({
    mutationFn: () => api<CompleteEncounterResult>(`/encounters/${e.id}/complete`, { method: 'POST', body: { version: e.version } }),
    onSuccess: (r) => {
      refresh()
      toast('success', completionToast(r.patientPortalAccess))
      done()
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'already_completed') {
        refresh()
        toast('success', 'This consultation was already completed')
        done()
      } else if (err instanceof ApiError && err.status === 409) refresh()
    },
  })
}

/**
 * The signed consultation's actions (DESIGN §5.6, §17B): "Prescription signed ✓" · [Print] · [Complete consultation] (primary, only when this
 * doctor can complete it) → "Complete this consultation?" [Cancel] [Complete]. Printing never completes anything. A completed consultation says
 * so, with [Print] only. `print` false: the page already offers the printout beside it (the signed record's header).
 */
export function SignedActions({ encounter, completed = false, print = true }: { encounter: Encounter; completed?: boolean; print?: boolean }) {
  const [asking, setAsking] = useState(false)
  const complete = useCompleteConsultation(encounter)
  const canComplete = !completed && !!encounter.canComplete
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="signed-actions">
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-ok" data-testid="prescription-signed">
        <CircleCheck aria-hidden="true" className="size-4" />
        {completed ? 'Consultation completed' : 'Prescription signed'}
      </p>
      {print && (
        <Link to={printUrl(encounter.id)} target="_blank" rel="noopener" className={SECONDARY_CONTROL} data-testid="print-prescription">
          <Printer aria-hidden="true" className="size-4" />
          Print
          <span className="sr-only"> the prescription (opens in a new tab)</span>
        </Link>
      )}
      {canComplete && (
        <Button onClick={() => setAsking(true)} data-testid="complete-consultation">
          Complete consultation
        </Button>
      )}
      {asking && (
        <ConfirmationDialog
          title="Complete this consultation?"
          keepLabel="Cancel"
          confirmLabel="Complete"
          tone="primary"
          loading={complete.isPending}
          error={complete.isError && !(complete.error instanceof ApiError && complete.error.code === 'already_completed') ? errorMessage(complete.error) : undefined}
          onClose={() => {
            complete.reset()
            setAsking(false)
          }}
          onConfirm={() => complete.mutate()}
        >
          <p>The visit is closed and the patient’s record is updated. The signed prescription becomes available to the patient when they have access to the patient app.</p>
          <p className="text-ink-muted">Printing does not complete a consultation; this does.</p>
        </ConfirmationDialog>
      )}
    </div>
  )
}
