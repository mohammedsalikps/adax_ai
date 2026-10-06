import {
  HANDWRITING_FILE_KIND,
  HANDWRITING_FORMAT_VERSION,
  HANDWRITING_LIMITS,
  HANDWRITING_MIME,
  HANDWRITING_VERSION_CONFLICT,
  HandwritingDocument,
  type HandwritingLatest,
  type HandwritingSaved,
  HandwritingSaveFields,
} from '@adaxai/contracts'
import { desc, eq, max } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { Config } from '../config.ts'
import { type Db, type DbOrTx, pgCode } from '../db/client.ts'
import { encounterHandwriting, encounters, files, users, visits } from '../db/schema.ts'
import { assertOwnDraft, assertWithDoctor, type EncounterRow, getEncounterOr404 } from '../encounters/service.ts'
import { discardStoredBytes, readStoredBytes, storeBytes } from '../files/storage.ts'
import { readUpload } from '../files/upload.ts'
import { badRequest, conflict, HttpError } from '../http/errors.ts'
import { enforceLimit, type RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import type { AppSettings } from '../settings/schema.ts'

export interface HandwritingRouteDeps {
  db: Db
  /** storageDir and maxUploadBytes. */
  config: Config
  settings: AppSettings
  limiter: RateLimiter
}

const IdParams = z.object({ id: z.uuid() })
/** The pad autosaves at most every 1.5 s while the doctor writes; this is far above that and stops a runaway client. */
const SAVES_PER_MINUTE = 120
/** At most this many format problems are listed back (a broken file could have thousands). */
const MAX_ISSUES = 10

const conflictMessage = 'Your handwritten notes were changed on another screen. Reload the latest version and save again.'

/**
 * The doctor's handwritten notes (Doctor HERO final; contracts handwriting.ts; table encounter_handwriting, migration 0033).
 *
 *   GET  /api/encounters/:id/handwriting   permission 'encounters:read' -> HandwritingLatest
 *   POST /api/encounters/:id/handwriting   permission 'encounters:write' (the consultation's own unsigned draft, visit with the doctor)
 *                                          multipart: the fields of HandwritingSaveFields, then ONE JSON file (a HandwritingDocument, at most
 *                                          HANDWRITING_LIMITS.maxFileBytes) -> HandwritingSaved (201); 409 when expectedVersion is not the latest
 *                                          (HANDWRITING_VERSION_CONFLICT) or the record is signed or discarded
 *
 * Every save is a new version: the strokes file is a `files` row of kind HANDWRITING_FILE_KIND with this patient's and this consultation's
 * ids (the database refuses anything else), and the new row's version is latest + 1 (the database refuses a gap or a duplicate with SQLSTATE
 * 23505, and any version once the consultation is signed or discarded with 42501). What is stored is the validated document re-serialised,
 * never the bytes as sent (no unknown keys reach the record). Nothing reads or recognises the writing. Audit `encounter.handwriting_save` with
 * the version, the counts, the size and the file id only: never strokes.
 */
export function registerHandwritingRoutes(app: FastifyInstance, { db, config, limiter }: HandwritingRouteDeps): void {
  app.get('/api/encounters/:id/handwriting', { config: { permission: 'encounters:read' } }, async (req): Promise<HandwritingLatest> => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    const [latest] = await db
      .select({ h: encounterHandwriting, f: files, by: users.fullName })
      .from(encounterHandwriting)
      .innerJoin(files, eq(files.id, encounterHandwriting.strokesFileId))
      .innerJoin(users, eq(users.id, encounterHandwriting.createdBy))
      .where(eq(encounterHandwriting.encounterId, id))
      .orderBy(desc(encounterHandwriting.version))
      .limit(1)
    const readOnly = !(await canWrite(db, e, me.id))
    await audit(db, req, { action: 'encounter.handwriting_read', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { version: latest?.h.version ?? 0 } })
    if (!latest) return { encounterId: id, version: 0, strokeCount: 0, pageCount: 0, strokesFileId: null, document: null, savedAt: null, savedByName: null, readOnly }
    return {
      encounterId: id,
      version: latest.h.version,
      strokeCount: latest.h.strokeCount,
      pageCount: latest.h.pageCount,
      strokesFileId: latest.f.id,
      document: await readDocument(config.storageDir, latest.f),
      savedAt: latest.h.createdAt.toISOString(),
      savedByName: latest.by,
      readOnly,
    }
  })

  app.post('/api/encounters/:id/handwriting', { config: { permission: 'encounters:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const e = await getEncounterOr404(db, me, id)
    assertOwnDraft(e, me, 'edit')
    await assertWithDoctor(db, e)
    await enforceLimit(db, limiter, req, reply, 'handwriting-save', me.id, { max: SAVES_PER_MINUTE, windowSeconds: 60 })

    const up = await readUpload(req, 'the handwritten notes (one JSON file)')
    if (up.mimetype !== HANDWRITING_MIME) throw badRequest('The handwritten notes must be sent as a JSON file', [{ path: 'file', message: `Use ${HANDWRITING_MIME}` }])
    if (up.data.length > HANDWRITING_LIMITS.maxFileBytes) throw new HttpError(413, 'too_large', `The handwritten notes are larger than ${HANDWRITING_LIMITS.maxFileBytes / (1024 * 1024)} MB`)
    // An empty multipart field is a missing one (never coerced to 0).
    const fields = parse(HandwritingSaveFields, Object.fromEntries(Object.entries(up.fields).map(([k, v]) => [k, v === '' ? undefined : v])))
    const doc = parseDocument(up.data)
    const mismatch = [
      ...(fields.strokeCount !== doc.strokes.length ? [{ path: 'strokeCount', message: `The file has ${doc.strokes.length} strokes` }] : []),
      ...(fields.pageCount !== doc.pageCount ? [{ path: 'pageCount', message: `The file has ${doc.pageCount} pages` }] : []),
    ]
    if (mismatch.length) throw badRequest('The counts do not match the file', mismatch)
    // Cheap check before anything is written; the transaction checks again and the database is the backstop.
    if ((await latestVersion(db, id)) !== fields.expectedVersion) throw conflict(conflictMessage, HANDWRITING_VERSION_CONFLICT)

    const bytes = Buffer.from(JSON.stringify(doc))
    const stored = await storeBytes(config.storageDir, bytes, '.json')
    const version = fields.expectedVersion + 1
    try {
      const saved = await db.transaction(async (tx) => {
        if ((await latestVersion(tx, id)) !== fields.expectedVersion) throw conflict(conflictMessage, HANDWRITING_VERSION_CONFLICT)
        const [f] = await tx
          .insert(files)
          .values({ facilityId: e.facilityId, patientId: e.patientId, encounterId: id, kind: HANDWRITING_FILE_KIND, storageKey: stored.storageKey, originalName: `handwriting-v${version}.json`, mimeType: HANDWRITING_MIME, sizeBytes: stored.sizeBytes, sha256: stored.sha256, uploadedBy: me.id })
          .returning({ id: files.id })
        // The version row BEFORE the audit entry: its guard waits for the consultation row, and auditing first could deadlock with a draft save.
        const [row] = await tx
          .insert(encounterHandwriting)
          .values({ encounterId: id, patientId: e.patientId, version, strokesFileId: f!.id, strokeCount: doc.strokes.length, pageCount: doc.pageCount, createdBy: me.id })
          .returning({ createdAt: encounterHandwriting.createdAt })
        await audit(tx, req, { action: 'encounter.handwriting_save', entityType: 'encounter', entityId: id, patientId: e.patientId, details: { version, strokeCount: doc.strokes.length, pageCount: doc.pageCount, sizeBytes: stored.sizeBytes, strokesFileId: f!.id } })
        return { createdAt: row!.createdAt, fileId: f!.id }
      })
      const out: HandwritingSaved = { encounterId: id, version, strokeCount: doc.strokes.length, pageCount: doc.pageCount, savedAt: saved.createdAt.toISOString(), strokesFileId: saved.fileId, savedByName: me.fullName }
      return reply.code(201).send(out)
    } catch (err) {
      // Nothing was recorded: the bytes written for it are not left behind.
      await discardStoredBytes(config.storageDir, stored.storageKey)
      throw await explainRefusal(db, id, err)
    }
  })
}

/** The newest saved version of a consultation's notes (0 before the first save). */
async function latestVersion(db: DbOrTx, encounterId: string): Promise<number> {
  const [r] = await db.select({ v: max(encounterHandwriting.version) }).from(encounterHandwriting).where(eq(encounterHandwriting.encounterId, encounterId))
  return r?.v ?? 0
}

/** The notes can be written by their consultation's author only, while it is an unsigned draft whose visit is with the doctor (as the typed note). */
async function canWrite(db: DbOrTx, e: EncounterRow, userId: string): Promise<boolean> {
  if (e.status !== 'in_progress' || e.doctorId !== userId) return false
  const [v] = await db.select({ status: visits.status }).from(visits).where(eq(visits.id, e.visitId))
  return v?.status === 'in_consultation'
}

/** The uploaded file as a handwriting document, or a 400 that lists (some of) what is wrong. Never echoes the content. */
function parseDocument(data: Buffer): HandwritingDocument {
  let json: unknown
  try {
    json = JSON.parse(data.toString('utf8'))
  } catch {
    throw badRequest('The handwritten notes file is not valid JSON', [{ path: 'file', message: 'Not JSON' }])
  }
  const r = HandwritingDocument.safeParse(json)
  if (r.success) return r.data
  const issues = r.error.issues.slice(0, MAX_ISSUES).map((i) => ({ path: ['file', ...i.path].join('.'), message: i.message }))
  throw new HttpError(400, 'validation_error', `The handwritten notes are not in the handwriting format (version ${HANDWRITING_FORMAT_VERSION})`, issues)
}

/**
 * A stored version's document. It was validated before it was stored and is our own serialisation, so only its shape is checked here (a full
 * validation of a large document on every read would cost more than it protects).
 */
async function readDocument(storageDir: string, f: typeof files.$inferSelect): Promise<HandwritingDocument> {
  if (f.deletedAt) throw new HttpError(410, 'file_deleted', 'The stored handwritten notes were removed.')
  const doc = JSON.parse((await readStoredBytes(storageDir, f.storageKey)).toString('utf8')) as HandwritingDocument
  if (doc?.format !== HANDWRITING_FORMAT_VERSION || !Array.isArray(doc.strokes)) throw new HttpError(500, 'handwriting_unreadable', 'The stored handwritten notes could not be read.')
  return doc
}

/** The database's refusals of a save, said as the client's conflict (a concurrent save took the version, or the record was closed meanwhile). */
async function explainRefusal(db: Db, encounterId: string, err: unknown): Promise<unknown> {
  const code = pgCode(err)
  if (code === '23505') return conflict(conflictMessage, HANDWRITING_VERSION_CONFLICT)
  if (code === '42501') {
    const [now] = await db.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, encounterId))
    return now?.status === 'discarded'
      ? conflict('This draft was discarded. Its handwritten notes can no longer be changed.', 'encounter_discarded')
      : conflict('This consultation is signed. Its handwritten notes can no longer be changed.', 'encounter_signed')
  }
  return err
}
