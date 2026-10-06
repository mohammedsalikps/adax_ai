import path from 'node:path'
import {
  DOCUMENT_CONSENT_TYPE,
  DOCUMENT_FILE_KIND,
  DOCUMENT_MAX_BYTES,
  DocumentEnteredInErrorRequest,
  DocumentListQuery,
  DocumentUploadFields,
  type PatientDocument,
  type PatientProcedure,
  ProcedureEnteredInErrorRequest,
  ProcedureInput,
} from '@adaxai/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { Config } from '../config.ts'
import { requireConsent } from '../consents/service.ts'
import { type Db, pgCode } from '../db/client.ts'
import { encounters, files, patientDocuments, patientProcedures, patients, users } from '../db/schema.ts'
import { discardStoredBytes, storeBytes } from '../files/storage.ts'
import { readUpload } from '../files/upload.ts'
import { entryOrigin, recordHistoryEvent } from '../history/service.ts'
import type { RateLimiter } from '../http/rate-limit.ts'
import { badRequest, conflict, deniedNotFound, HttpError } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { facilityToday, getPatientOr404 } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { DOCUMENT_EXT, loadDocument, listDocuments, sniffDocument, toProcedure } from './service.ts'

export interface DocumentRouteDeps {
  db: Db
  /** storageDir, maxUploadBytes and dataOrigin. */
  config: Config
  settings: AppSettings
  limiter: RateLimiter
}

const IdParams = z.object({ id: z.uuid() })

const MAX_MB = Math.round(DOCUMENT_MAX_BYTES / (1024 * 1024))

const futureDate = (p: string) => badRequest('Some fields are invalid', [{ path: p, message: 'Cannot be in the future' }])

/**
 * Patient documents and surgeries (Doctor HERO final; contracts documents.ts; tables patient_documents and patient_procedures, migration 0033).
 *
 *   POST /api/patients/:id/documents                permission 'documents:write' (doctor, nurse) multipart: one PDF/JPEG/PNG file, sniffed by
 *                                                   magic bytes, at most DOCUMENT_MAX_BYTES, + DocumentUploadFields -> PatientDocument (201)
 *   GET  /api/patients/:id/documents                permission 'patients:read' -> PatientDocumentList (?includeErrors=true adds those marked)
 *   POST /api/documents/:id/entered-in-error        permission 'documents:write' -> PatientDocument
 *   POST /api/patients/:id/procedures               permission 'history:write' (doctors) -> PatientProcedure (201)
 *   POST /api/procedures/:id/entered-in-error       permission 'history:write' -> PatientProcedure
 *
 * Consent: storing a document needs the patient's consent to care records (DOCUMENT_CONSENT_TYPE, data_processing), the same rule as every
 * other stored clinical file (photographs need clinical_photography, thermal images thermal_imaging): refused (409, audited) when it is not
 * recorded, was withdrawn or was given under an earlier wording. Surgeries are typed history entries, like conditions: no consent gate.
 *
 * The file is stored with storeBytes as a `files` row of kind DOCUMENT_FILE_KIND with the patient's id and facility (the database refuses a
 * document whose file is another patient's) and opened through the audited GET /api/files/:id. Nothing reads its content (no OCR, no model).
 * Creations and status changes go to patient_history_events (entity 'document' / 'procedure'). Nothing is deleted or edited: a mistake is
 * marked entered in error with a reason, once. Audit details carry ids, categories, sizes and flags only: never the title, the file name, the
 * report text, a procedure's name or a reason.
 */
export function registerDocumentRoutes(app: FastifyInstance, { db, config }: DocumentRouteDeps): void {
  const userName = async (id: string) => (await db.select({ n: users.fullName }).from(users).where(eq(users.id, id)))[0]?.n ?? null

  // ---- Documents ----
  app.post('/api/patients/:id/documents', { config: { permission: 'documents:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const patient = await getPatientOr404(db, me.facilityId, id)
    await requireConsent(db, req, { patientId: id, type: DOCUMENT_CONSENT_TYPE, purpose: 'patient document' })
    const up = await readUpload(req, 'a document')
    const fields = parse(DocumentUploadFields, up.fields)
    if (up.data.length > DOCUMENT_MAX_BYTES) throw new HttpError(413, 'too_large', `The document is larger than ${MAX_MB} MB.`)
    // What the file is, from its bytes: the name and the type the browser declared are not trusted.
    const mimeType = sniffDocument(up.data)
    if (!mimeType) throw new HttpError(415, 'unsupported_document', 'Only PDF, JPEG and PNG files can be added as documents.')
    if (fields.studyDate && fields.studyDate > (await facilityToday(db, me.facilityId))) throw futureDate('studyDate')
    if (fields.encounterId) {
      const e = await db.query.encounters.findFirst({ columns: { id: true }, where: and(eq(encounters.id, fields.encounterId), eq(encounters.patientId, id)) })
      if (!e) throw badRequest('Some fields are invalid', [{ path: 'encounterId', message: 'Not a consultation of this patient' }])
    }
    const stored = await storeBytes(config.storageDir, up.data, DOCUMENT_EXT[mimeType])
    const originalName = path.basename(up.filename || 'document').slice(0, 120)
    let created: string
    try {
      created = await db.transaction(async (tx) => {
        const base = { facilityId: me.facilityId, patientId: id, encounterId: fields.encounterId ?? null, uploadedBy: me.id }
        const [f] = await tx.insert(files).values({ ...base, kind: DOCUMENT_FILE_KIND, storageKey: stored.storageKey, originalName, mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256 }).returning({ id: files.id })
        const [d] = await tx
          .insert(patientDocuments)
          .values({
            ...base,
            category: fields.category,
            modality: fields.modality ?? null,
            title: fields.title,
            studyDate: fields.studyDate ?? null,
            reportText: fields.reportText ?? null,
            fileId: f!.id,
            mimeType,
            dataOrigin: entryOrigin(patient.dataOrigin, config.dataOrigin),
          })
          .returning({ id: patientDocuments.id, status: patientDocuments.status })
        await recordHistoryEvent(tx, { patientId: id, entityType: 'document', entityId: d!.id, action: 'created', toStatus: d!.status, actorUserId: me.id })
        await audit(tx, req, {
          action: 'document.upload',
          entityType: 'patient_document',
          entityId: d!.id,
          patientId: id,
          details: { fileId: f!.id, category: fields.category, modality: fields.modality ?? null, mimeType, sizeBytes: stored.sizeBytes, encounterId: fields.encounterId ?? null, hasReportText: !!fields.reportText, hasStudyDate: !!fields.studyDate },
        })
        return d!.id
      })
    } catch (e) {
      // The bytes were written but never became part of the record.
      await discardStoredBytes(config.storageDir, stored.storageKey)
      throw e
    }
    return reply.code(201).send((await loadDocument(db, created, me.facilityId)) satisfies PatientDocument | null)
  })

  app.get('/api/patients/:id/documents', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const { includeErrors } = parse(DocumentListQuery, req.query ?? {})
    await getPatientOr404(db, me.facilityId, id)
    const documents = await listDocuments(db, id, me.facilityId, includeErrors)
    await audit(db, req, { action: 'document.list', entityType: 'patient', entityId: id, patientId: id, details: { count: documents.length, includeErrors, documentIds: documents.map((d) => d.id) } })
    return { documents }
  })

  app.post('/api/documents/:id/entered-in-error', { config: { permission: 'documents:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(DocumentEnteredInErrorRequest, req.body)
    const reason = body.reason.trim()
    await db.transaction(async (tx) => {
      const [old] = await tx.select().from(patientDocuments).where(and(eq(patientDocuments.id, id), eq(patientDocuments.facilityId, me.facilityId))).for('update')
      if (!old) throw deniedNotFound('Document', { entityType: 'patient_document', entityId: id, reason: 'not_found_or_other_facility' })
      if (old.status === 'entered_in_error') throw conflict('This document was marked as entered in error and cannot be changed.', 'history_entry_locked')
      await tx.update(patientDocuments).set({ status: 'entered_in_error', statusReason: reason, updatedAt: sql`now()` }).where(eq(patientDocuments.id, id))
      await recordHistoryEvent(tx, { patientId: old.patientId, entityType: 'document', entityId: id, action: 'status_changed', fromStatus: old.status, toStatus: 'entered_in_error', reason, actorUserId: me.id })
      await audit(tx, req, { action: 'document.entered_in_error', entityType: 'patient_document', entityId: id, patientId: old.patientId, details: { from: old.status, to: 'entered_in_error', category: old.category, fileId: old.fileId } })
    })
    return (await loadDocument(db, id, me.facilityId))!
  })

  // ---- Surgeries and other past procedures ----
  app.post('/api/patients/:id/procedures', { config: { permission: 'history:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ProcedureInput, req.body)
    const patient = await getPatientOr404(db, me.facilityId, id)
    if (body.performedYear != null) {
      const [year, month] = (await facilityToday(db, me.facilityId)).split('-').map(Number) as [number, number]
      if (body.performedYear > year || (body.performedYear === year && (body.performedMonth ?? 1) > month)) throw futureDate('performedYear')
    }
    const note = body.note?.trim() ? body.note.trim() : null
    try {
      const row = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(patientProcedures)
          .values({ patientId: id, name: body.name.trim(), performedYear: body.performedYear ?? null, performedMonth: body.performedMonth ?? null, note, dataOrigin: entryOrigin(patient.dataOrigin, config.dataOrigin), enteredBy: me.id })
          .returning()
        await recordHistoryEvent(tx, { patientId: id, entityType: 'procedure', entityId: r!.id, action: 'created', toStatus: r!.status, actorUserId: me.id })
        await audit(tx, req, { action: 'history.procedure_add', entityType: 'procedure', entityId: r!.id, patientId: id, details: { status: r!.status, hasYear: r!.performedYear != null } })
        return r!
      })
      return reply.code(201).send(toProcedure(row, me.fullName) satisfies PatientProcedure)
    } catch (e) {
      if (pgCode(e) === '23505') throw conflict('This surgery is already on the list.', 'already_recorded')
      throw e
    }
  })

  app.post('/api/procedures/:id/entered-in-error', { config: { permission: 'history:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ProcedureEnteredInErrorRequest, req.body)
    const reason = body.reason.trim()
    const row = await db.transaction(async (tx) => {
      // Only a procedure of a patient of the caller's facility (the table has no facility of its own).
      const [found] = await tx
        .select({ r: patientProcedures })
        .from(patientProcedures)
        .innerJoin(patients, eq(patients.id, patientProcedures.patientId))
        .where(and(eq(patientProcedures.id, id), eq(patients.facilityId, me.facilityId)))
        .for('update', { of: patientProcedures })
      const old = found?.r
      if (!old) throw deniedNotFound('Surgery', { entityType: 'procedure', entityId: id, reason: 'not_found_or_other_facility' })
      if (old.status === 'entered_in_error') throw conflict('This entry was marked as entered in error and cannot be changed.', 'history_entry_locked')
      const [r] = await tx.update(patientProcedures).set({ status: 'entered_in_error', statusReason: reason, updatedAt: sql`now()` }).where(eq(patientProcedures.id, id)).returning()
      await recordHistoryEvent(tx, { patientId: old.patientId, entityType: 'procedure', entityId: id, action: 'status_changed', fromStatus: old.status, toStatus: 'entered_in_error', reason, actorUserId: me.id })
      await audit(tx, req, { action: 'history.procedure_status', entityType: 'procedure', entityId: id, patientId: old.patientId, details: { from: old.status, to: 'entered_in_error' } })
      return r!
    })
    return toProcedure(row, await userName(row.enteredBy))
  })
}
