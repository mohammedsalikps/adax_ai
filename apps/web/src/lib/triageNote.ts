import { TRIAGE_NOTE_MAX, type TriageNoteRequest, type Visit } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from './api.ts'

/**
 * The nurse's triage note on a visit (HERO final; PUT /api/visits/:id/triage-note, nurses and doctors). At most 1000 characters; an empty
 * note clears it. The server keeps who wrote or cleared it and when, and audits it without its text.
 */
export function useSaveTriageNote(visitId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TriageNoteRequest) => api<Visit>(`/visits/${visitId}/triage-note`, { method: 'PUT', body }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['visits'] })
      void qc.invalidateQueries({ queryKey: ['doctor-day'] })
      void qc.invalidateQueries({ queryKey: ['patient', v.patient.id] })
    },
  })
}

/** What the note field holds, compared with what is saved: whether saving would change it, and whether it is too long. Spaces around it are not part of it. */
export function triageNoteDraft(saved: string | null | undefined, draft: string): { changed: boolean; tooLong: boolean; length: number } {
  const text = draft.trim()
  return { changed: text !== (saved ?? '').trim(), tooLong: text.length > TRIAGE_NOTE_MAX, length: text.length }
}
