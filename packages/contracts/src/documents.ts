import { z } from 'zod'
import { IsoDate, NUL_MESSAGE, noNul, OptionalText, RecordOrigin, Text } from './common.ts'
import type { ConsentType } from './patients.ts'

// ---------------------------------------------------------------------------
// Patient documents and surgeries (Doctor HERO final). Documents are laboratory reports, imaging reports and images (MRI, CT, X-ray,
// ultrasound) and other papers, uploaded by staff as PDF, JPEG or PNG; staff may type the report's text. Nothing reads the file itself: no
// OCR, no image model, no DICOM viewer. Surgeries and other past procedures are history entries typed in by staff. Like the rest of the
// history, nothing is deleted or edited: a mistake is marked "entered in error" with a reason and kept (migration 0033).
// ---------------------------------------------------------------------------

export const DocumentCategory = z.enum(['lab_report', 'imaging_report', 'imaging_image', 'other'])
export type DocumentCategory = z.infer<typeof DocumentCategory>
export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  lab_report: 'Laboratory report',
  imaging_report: 'Imaging report',
  imaging_image: 'Imaging image',
  other: 'Other document',
}
/** How the Documents tab groups them. */
export const DOCUMENT_GROUPS: { label: string; categories: DocumentCategory[] }[] = [
  { label: 'Lab reports', categories: ['lab_report'] },
  { label: 'Imaging', categories: ['imaging_report', 'imaging_image'] },
  { label: 'Other', categories: ['other'] },
]

export const DocumentModality = z.enum(['mri', 'ct', 'xray', 'ultrasound', 'other'])
export type DocumentModality = z.infer<typeof DocumentModality>
export const DOCUMENT_MODALITY_LABELS: Record<DocumentModality, string> = { mri: 'MRI', ct: 'CT', xray: 'X-ray', ultrasound: 'Ultrasound', other: 'Other imaging' }
/** Only imaging documents have a modality. */
export const IMAGING_DOCUMENT_CATEGORIES: DocumentCategory[] = ['imaging_report', 'imaging_image']

/** Accepted files, checked by their content (magic bytes), not by name or declared type. */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number]
export const DOCUMENT_MAX_BYTES = 15 * 1024 * 1024
export const DOCUMENT_REPORT_TEXT_MAX = 20_000
/** The `files.kind` of a document's bytes. */
export const DOCUMENT_FILE_KIND = 'patient_document'
/**
 * The consent a document upload needs. The rule for every stored clinical file: the patient's consent to that purpose is on record
 * (photographs: clinical_photography; thermal images: thermal_imaging). A report or a scan from elsewhere is part of the care record, so the
 * purpose is "Care records" (data_processing), with the current wording; without it (not recorded or withdrawn) nothing is stored.
 */
export const DOCUMENT_CONSENT_TYPE = 'data_processing' as const satisfies ConsentType

/** GET /api/patients/:id/documents?includeErrors=true also lists documents marked as entered in error. */
export const DocumentListQuery = z.object({ includeErrors: z.enum(['true', 'false']).optional().transform((v) => v === 'true') })
export type DocumentListQuery = z.input<typeof DocumentListQuery>

/** A multipart field left empty is "not given". */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v)

/** POST /api/patients/:id/documents: the multipart fields beside the one file. */
export const DocumentUploadFields = z
  .object({
    category: DocumentCategory,
    modality: z.preprocess(emptyToUndefined, DocumentModality.nullable().optional()),
    title: Text(160),
    studyDate: z.preprocess(emptyToUndefined, IsoDate.nullable().optional()),
    reportText: OptionalText(DOCUMENT_REPORT_TEXT_MAX),
    /** The consultation it is added in, if any (the patient's own). */
    encounterId: z.preprocess(emptyToUndefined, z.uuid().optional()),
  })
  .superRefine((v, ctx) => {
    if (v.modality && !IMAGING_DOCUMENT_CATEGORIES.includes(v.category)) ctx.addIssue({ code: 'custom', path: ['modality'], message: 'Only imaging documents have a modality' })
  })
export type DocumentUploadFields = z.input<typeof DocumentUploadFields>

export const DocumentStatus = z.enum(['recorded', 'entered_in_error'])
export type DocumentStatus = z.infer<typeof DocumentStatus>

/** A reason for marking an entry as entered in error. */
const errorReason = z.string().trim().min(3, 'Give a short reason (at least 3 characters)').max(200, 'At most 200 characters').refine(noNul, NUL_MESSAGE)

/** POST /api/documents/:id/entered-in-error */
export const DocumentEnteredInErrorRequest = z.object({ reason: errorReason })
export type DocumentEnteredInErrorRequest = z.input<typeof DocumentEnteredInErrorRequest>

export const PatientDocument = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable(),
  category: DocumentCategory,
  modality: DocumentModality.nullable(),
  title: z.string(),
  studyDate: z.string().nullable(),
  /** What staff typed from the report; null when nothing was typed (the file is the document). */
  reportText: z.string().nullable(),
  /** Open through GET /api/files/:id. */
  fileId: z.uuid(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sizeBytes: z.number().int(),
  originalName: z.string().nullable(),
  status: DocumentStatus,
  statusReason: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  createdAt: z.string(),
  dataOrigin: RecordOrigin,
})
export type PatientDocument = z.infer<typeof PatientDocument>

/** GET /api/patients/:id/documents (newest first; entries marked as errors are left out unless asked for). */
export const PatientDocumentList = z.object({ documents: z.array(PatientDocument) })
export type PatientDocumentList = z.infer<typeof PatientDocumentList>

/** The documents line of the history read model: how many of each, and the latest few (no report text). */
export const DocumentsSummary = z.object({
  total: z.number().int().min(0),
  byCategory: z.object({ lab_report: z.number().int().min(0), imaging_report: z.number().int().min(0), imaging_image: z.number().int().min(0), other: z.number().int().min(0) }),
  latest: z.array(
    z.object({ id: z.uuid(), title: z.string(), category: DocumentCategory, modality: DocumentModality.nullable(), studyDate: z.string().nullable(), createdAt: z.string(), hasReportText: z.boolean() }),
  ),
})
export type DocumentsSummary = z.infer<typeof DocumentsSummary>

// --- Surgeries and other past procedures --------------------------------------------------------------------------------------------------

export const ProcedureStatus = z.enum(['recorded', 'entered_in_error'])
export type ProcedureStatus = z.infer<typeof ProcedureStatus>

/** POST /api/patients/:id/procedures */
export const ProcedureInput = z
  .object({
    name: Text(120),
    /** The year it was done, if known (up to this year; the API checks the upper bound). */
    performedYear: z.number().int().min(1900).max(2200).nullable().optional(),
    performedMonth: z.number().int().min(1).max(12).nullable().optional(),
    note: OptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.performedMonth != null && v.performedYear == null) ctx.addIssue({ code: 'custom', path: ['performedMonth'], message: 'Give the year too' })
  })
export type ProcedureInput = z.input<typeof ProcedureInput>

/** POST /api/procedures/:id/entered-in-error */
export const ProcedureEnteredInErrorRequest = z.object({ reason: errorReason })
export type ProcedureEnteredInErrorRequest = z.input<typeof ProcedureEnteredInErrorRequest>

export const PatientProcedure = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Null: when it was done is not recorded (say so; never guess). */
  performedYear: z.number().int().nullable(),
  performedMonth: z.number().int().nullable(),
  status: ProcedureStatus,
  note: z.string().nullable(),
  enteredByName: z.string().nullable(),
  enteredAt: z.string(),
  dataOrigin: RecordOrigin,
})
export type PatientProcedure = z.infer<typeof PatientProcedure>
