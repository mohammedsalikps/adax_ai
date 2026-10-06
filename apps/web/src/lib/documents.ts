import type { DocumentCategory, DocumentModality, PatientDocument, PatientDocumentList, PatientProcedure, ProcedureInput } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api.ts'

/** The patient's documents (lab reports, imaging, others). Under ['patient', id] so every change to the patient refreshes it. */
export const documentsKey = (patientId: string, includeErrors = false) => ['patient', patientId, 'documents', includeErrors] as const

/**
 * The documents of a patient, newest first (each read is audited). Mount it only where the documents are shown (the Documents tab mounts
 * only while it is open), so opening a patient does not read them.
 */
export function usePatientDocuments(patientId: string, { includeErrors = false }: { includeErrors?: boolean } = {}) {
  return useQuery({
    queryKey: documentsKey(patientId, includeErrors),
    queryFn: () => api<PatientDocumentList>(`/patients/${patientId}/documents`, { query: { includeErrors: includeErrors ? 'true' : undefined } }),
    select: (d) => d.documents,
    staleTime: 15_000,
  })
}

/** What the upload dialog sends beside the file. */
export interface DocumentUpload {
  file: File
  category: DocumentCategory
  modality?: DocumentModality | null
  title: string
  studyDate?: string | null
  reportText?: string | null
  encounterId?: string | null
}

/** Uploads one document (multipart; the fields go before the file, as the server reads them). Refreshes the patient's data. */
export function useUploadDocument(patientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (u: DocumentUpload) => {
      const fd = new FormData()
      fd.append('category', u.category)
      if (u.modality) fd.append('modality', u.modality)
      fd.append('title', u.title)
      if (u.studyDate) fd.append('studyDate', u.studyDate)
      if (u.reportText?.trim()) fd.append('reportText', u.reportText)
      if (u.encounterId) fd.append('encounterId', u.encounterId)
      fd.append('file', u.file, u.file.name)
      return api<PatientDocument>(`/patients/${patientId}/documents`, { method: 'POST', body: fd })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })
}

export function useDocumentEnteredInError(patientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) => api<PatientDocument>(`/documents/${v.id}/entered-in-error`, { method: 'POST', body: { reason: v.reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })
}

/** Surgeries are history entries: adding or correcting one refreshes the history (and the rest of the patient's data). */
export function useAddProcedure(patientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ProcedureInput) => api<PatientProcedure>(`/patients/${patientId}/procedures`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })
}

export function useProcedureEnteredInError(patientId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) => api<PatientProcedure>(`/procedures/${v.id}/entered-in-error`, { method: 'POST', body: { reason: v.reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })
}
