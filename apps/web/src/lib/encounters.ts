import type { DiscardDraftRequest, Encounter, EncounterVerification, MyConsultationsResponse, StatusHistory, TimelineEntry } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api } from './api.ts'
import { isNewConsultationStart, type StartConsultationInput } from './doctorDay.ts'

export const encounterKey = (id: string) => ['encounter', id] as const

export function useEncounter(id: string | undefined) {
  return useQuery({ queryKey: encounterKey(id ?? ''), queryFn: () => api<Encounter>(`/encounters/${id}`), enabled: !!id, staleTime: 0 })
}

export function useTimeline(patientId: string) {
  return useQuery({
    queryKey: ['patient', patientId, 'timeline'],
    queryFn: () => api<{ entries: TimelineEntry[] }>(`/patients/${patientId}/timeline`),
    select: (d) => d.entries,
  })
}

/**
 * Starts the consultation for a visit, or continues the doctor's own paused draft, and opens it. Doctors only. Takes the visit id, or what a
 * row of the doctor's day knows ({visitId, encounterId}: null when the row showed no consultation). Only a NEW start (isNewConsultationStart)
 * opens the workspace with router state `{autoRecord: true}`, so recording starts by itself there; a resume or a read never does.
 */
export function useStartConsultation() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: (input: string | StartConsultationInput) => api<Encounter>(`/visits/${typeof input === 'string' ? input : input.visitId}/encounter`, { method: 'POST' }),
    onSuccess: (e, input) => {
      qc.setQueryData(encounterKey(e.id), e)
      void qc.invalidateQueries({ queryKey: ['visits'] })
      void qc.invalidateQueries({ queryKey: ['appointments'] })
      void qc.invalidateQueries({ queryKey: ['my-consultations'] })
      void qc.invalidateQueries({ queryKey: ['doctor-day'] })
      navigate(`/doctor/encounters/${e.id}`, isNewConsultationStart(input, e) ? { state: { autoRecord: true } } : undefined)
    },
  })
}

/** The doctor's own unsigned drafts (any day) or recently signed records. */
export function useMyConsultations(status: 'in_progress' | 'signed', enabled = true) {
  return useQuery({
    queryKey: ['my-consultations', status],
    queryFn: () => api<MyConsultationsResponse>('/encounters/mine', { query: { status } }),
    enabled,
  })
}

/** Closes an unsigned draft without signing; the draft is kept read-only. */
export function useDiscardDraft(encounterId: string) {
  const qc = useQueryClient()
  return useMutation({
    // A refusal (e.g. the draft changed meanwhile) refreshes what the dialog was based on.
    onError: () => {
      void qc.invalidateQueries({ queryKey: ['my-consultations'] })
      void qc.invalidateQueries({ queryKey: encounterKey(encounterId) })
    },
    mutationFn: (body: DiscardDraftRequest) => api<Encounter>(`/encounters/${encounterId}/discard`, { method: 'POST', body }),
    onSuccess: (e) => {
      qc.setQueryData(encounterKey(e.id), e)
      void qc.invalidateQueries({ queryKey: ['visits'] })
      void qc.invalidateQueries({ queryKey: ['appointments'] })
      void qc.invalidateQueries({ queryKey: ['my-consultations'] })
      void qc.invalidateQueries({ queryKey: ['doctor-day'] })
      void qc.invalidateQueries({ queryKey: ['patient', e.patient.id] })
      void qc.invalidateQueries({ queryKey: ['encounter-history', e.id] })
    },
  })
}

/** Who changed the consultation's and visit's status, when, how and why (loaded on request). */
export function useStatusHistory(encounterId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['encounter-history', encounterId],
    queryFn: () => api<StatusHistory>(`/encounters/${encounterId}/history`),
    enabled,
    select: (d) => d.events,
  })
}

/** Re-checks a signed record against its fingerprints (an explicit, audited action). */
export function useVerifyRecord(encounterId: string) {
  return useMutation({ mutationKey: ['encounter-verify', encounterId], mutationFn: () => api<EncounterVerification>(`/encounters/${encounterId}/verification`) })
}
