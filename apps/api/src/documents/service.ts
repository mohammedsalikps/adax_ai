import { type DocumentCategory, type DocumentMimeType, type DocumentModality, type DocumentsSummary, type PatientDocument, type PatientProcedure, type RecordOrigin } from '@adaxai/contracts'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../db/client.ts'
import { files, patientDocuments, patientProcedures, users } from '../db/schema.ts'

/**
 * Patient documents (laboratory reports, imaging, other papers) and surgeries: how a row reads, what a file is from its first bytes, and the
 * documents line of the history read model. Nothing here reads a document's content: no OCR, no image model, no DICOM.
 */

/** How many of the latest documents the history read model names (titles only, never the report text). */
export const HISTORY_DOCUMENTS_LATEST = 5

/**
 * What an uploaded document actually is, from its first bytes, never from its name or the type the browser said it has. Only the three
 * accepted kinds are recognised; anything else (a Word file, a GIF, HTML, a script, a DICOM file) is null and is refused before it is stored.
 */
export function sniffDocument(b: Buffer): DocumentMimeType | null {
  // PDF: "%PDF-" at the very start (the header the format requires).
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf'
  // JPEG: SOI marker followed by the start of the next marker.
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // PNG: the eight-byte signature.
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  return null
}

/** The file extension a stored document gets (the storage key; the original name is kept separately). */
export const DOCUMENT_EXT: Record<DocumentMimeType, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }

type DocumentRow = typeof patientDocuments.$inferSelect
type ProcedureRow = typeof patientProcedures.$inferSelect

export const toDocument = (r: DocumentRow, f: { sizeBytes: number; originalName: string | null }, by: string | null): PatientDocument => ({
  id: r.id,
  patientId: r.patientId,
  encounterId: r.encounterId,
  category: r.category as DocumentCategory,
  modality: (r.modality as DocumentModality | null) ?? null,
  title: r.title,
  studyDate: r.studyDate,
  reportText: r.reportText,
  fileId: r.fileId,
  mimeType: r.mimeType as DocumentMimeType,
  sizeBytes: f.sizeBytes,
  originalName: f.originalName,
  status: r.status,
  statusReason: r.statusReason,
  uploadedByName: by,
  createdAt: r.createdAt.toISOString(),
  dataOrigin: r.dataOrigin as RecordOrigin,
})

export const toProcedure = (r: ProcedureRow, by: string | null): PatientProcedure => ({
  id: r.id,
  name: r.name,
  performedYear: r.performedYear,
  performedMonth: r.performedMonth,
  status: r.status,
  note: r.note,
  enteredByName: by,
  enteredAt: r.enteredAt.toISOString(),
  dataOrigin: r.dataOrigin as RecordOrigin,
})

/** A patient's documents with their file's size and name and who uploaded them; newest first. Entries marked as errors only when asked. */
export async function listDocuments(db: DbOrTx, patientId: string, facilityId: string, includeErrors = false): Promise<PatientDocument[]> {
  const uploader = alias(users, 'document_uploader')
  const rows = await db
    .select({ r: patientDocuments, sizeBytes: files.sizeBytes, originalName: files.originalName, by: uploader.fullName })
    .from(patientDocuments)
    .innerJoin(files, eq(files.id, patientDocuments.fileId))
    .leftJoin(uploader, eq(uploader.id, patientDocuments.uploadedBy))
    .where(and(eq(patientDocuments.patientId, patientId), eq(patientDocuments.facilityId, facilityId), includeErrors ? undefined : ne(patientDocuments.status, 'entered_in_error')))
    .orderBy(desc(patientDocuments.createdAt), desc(patientDocuments.id))
  return rows.map(({ r, sizeBytes, originalName, by }) => toDocument(r, { sizeBytes, originalName }, by))
}

/** One document of the caller's facility, as the API returns it (null when there is none). */
export async function loadDocument(db: DbOrTx, id: string, facilityId: string): Promise<PatientDocument | null> {
  const uploader = alias(users, 'document_uploader')
  const [row] = await db
    .select({ r: patientDocuments, sizeBytes: files.sizeBytes, originalName: files.originalName, by: uploader.fullName })
    .from(patientDocuments)
    .innerJoin(files, eq(files.id, patientDocuments.fileId))
    .leftJoin(uploader, eq(uploader.id, patientDocuments.uploadedBy))
    .where(and(eq(patientDocuments.id, id), eq(patientDocuments.facilityId, facilityId)))
  return row ? toDocument(row.r, { sizeBytes: row.sizeBytes, originalName: row.originalName }, row.by) : null
}

/** Surgeries and procedures on the record (not those marked as errors): the most recent first, those with no date last. */
export async function listProcedures(db: DbOrTx, patientId: string): Promise<PatientProcedure[]> {
  const enteredBy = alias(users, 'procedure_entered_by')
  const rows = await db
    .select({ r: patientProcedures, by: enteredBy.fullName })
    .from(patientProcedures)
    .leftJoin(enteredBy, eq(enteredBy.id, patientProcedures.enteredBy))
    .where(and(eq(patientProcedures.patientId, patientId), ne(patientProcedures.status, 'entered_in_error')))
    .orderBy(sql`${patientProcedures.performedYear} desc nulls last`, sql`${patientProcedures.performedMonth} desc nulls last`, asc(patientProcedures.name))
  return rows.map(({ r, by }) => toProcedure(r, by))
}

/** The documents line of the history read model: how many of each category are on the record, and the latest few (no report text). */
export async function documentsSummary(db: DbOrTx, patientId: string): Promise<DocumentsSummary> {
  const recorded = and(eq(patientDocuments.patientId, patientId), ne(patientDocuments.status, 'entered_in_error'))
  const [counts, latest] = await Promise.all([
    db.select({ category: patientDocuments.category, n: sql<number>`count(*)::int` }).from(patientDocuments).where(recorded).groupBy(patientDocuments.category),
    db
      .select({ r: patientDocuments })
      .from(patientDocuments)
      .where(recorded)
      // The study's own date first (when the test or scan was done), else the day it was added.
      .orderBy(sql`coalesce(${patientDocuments.studyDate}, (${patientDocuments.createdAt})::date) desc`, desc(patientDocuments.createdAt))
      .limit(HISTORY_DOCUMENTS_LATEST),
  ])
  const byCategory: DocumentsSummary['byCategory'] = { lab_report: 0, imaging_report: 0, imaging_image: 0, other: 0 }
  for (const c of counts) if (c.category in byCategory) byCategory[c.category as DocumentCategory] = c.n
  return {
    total: Object.values(byCategory).reduce((a, b) => a + b, 0),
    byCategory,
    latest: latest.map(({ r }) => ({
      id: r.id,
      title: r.title,
      category: r.category as DocumentCategory,
      modality: (r.modality as DocumentModality | null) ?? null,
      studyDate: r.studyDate,
      createdAt: r.createdAt.toISOString(),
      hasReportText: !!r.reportText,
    })),
  }
}
