import crypto from 'node:crypto'
import {
  type ActivationCodeResponse,
  AllergyInput,
  CreatePatientRequest,
  type DuplicateCandidate,
  type PatientSummary,
  RecordConsentRequest,
  UpdatePatientRequest,
  WithdrawConsentRequest,
} from '@adaxai/contracts'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { Db } from '../db/client.ts'
import { revokeUserSessions } from '../auth/sessions.ts'
import { grantConsent, requireConsent, withdrawConsentType } from '../consents/service.ts'
import { allergies, consents, patientActivationCodes, patients, users, visits } from '../db/schema.ts'
import { conflict, notFound } from '../http/errors.ts'
import { parse } from '../http/validate.ts'
import { fullName, getPatientOr404, loadPatientDetail, toSummary } from './service.ts'

const PatientParams = z.object({ id: z.uuid() })
const SubParams = z.object({ id: z.uuid(), subId: z.uuid() })
const SearchQuery = z.object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(50).default(25) })

const ACTIVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const hashActivationCode = (code: string) => crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex')

function newActivationCode(): string {
  const bytes = crypto.randomBytes(10)
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
  return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`
}

const escapeLike = (s: string) => s.replace(/[%_\\]/g, '\\$&')

/**
 * The ABHA number a search term is, if it is one: 14 digits, written together or as ##-####-####-#### (spaces allowed in place of the
 * hyphens), as the number is stored (digits only). Anything else is not an ABHA number, so a name or a short run of digits never matches one.
 */
export function abhaQuery(q: string): string | null {
  const t = q.trim()
  return /^\d{14}$/.test(t) || /^\d{2}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}$/.test(t) ? t.replace(/\D/g, '') : null
}

export function registerPatientRoutes(app: FastifyInstance, { db, dataOrigin }: { db: Db; dataOrigin: 'synthetic' | 'clinical' }) {
  // ---- Search / list ----
  app.get('/api/patients', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { q, limit } = parse(SearchQuery, req.query)
    const lastVisit = sql<string | null>`(select max(${visits.visitDate})::text from ${visits} where ${visits.patientId} = ${patients.id})`
    let rows
    if (!q) {
      rows = await db.select({ p: patients, lastVisit }).from(patients).where(eq(patients.facilityId, me.facilityId)).orderBy(desc(patients.updatedAt)).limit(limit)
    } else {
      const digits = q.replace(/\D/g, '')
      const term = q.toLowerCase()
      const conds = [sql`${patients.mrn} ilike ${`${escapeLike(q)}%`}`, sql`${patients.searchName} ilike ${`%${escapeLike(term)}%`}`, sql`${patients.searchName} % ${term}`]
      if (digits.length >= 4) conds.push(sql`${patients.phone} like ${`%${digits}%`}`)
      // HERO final: the ABHA number (exact, as stored), when the term is one.
      const abha = abhaQuery(q)
      if (abha) conds.push(sql`${patients.abhaNumber} = ${abha}`)
      rows = await db
        .select({ p: patients, lastVisit })
        .from(patients)
        .where(and(eq(patients.facilityId, me.facilityId), or(...conds)))
        .orderBy(sql`(${patients.mrn} = ${q}) desc`, ...(abha ? [sql`(${patients.abhaNumber} = ${abha}) desc nulls last`] : []), sql`similarity(${patients.searchName}, ${term}) desc`, desc(patients.updatedAt))
        .limit(limit)
    }
    // The allergy chip of each row: the names of the active allergies.
    const ids = rows.map(({ p }) => p.id)
    const allergyRows = ids.length
      ? await db.select({ patientId: allergies.patientId, substance: allergies.substance }).from(allergies).where(and(inArray(allergies.patientId, ids), eq(allergies.status, 'active'))).orderBy(desc(allergies.recordedAt))
      : []
    // Search terms can be names, so only their length is audited, with the patients the result disclosed.
    await audit(db, req, { action: 'patient.search', details: { queryLength: q?.length ?? 0, results: rows.length, patientIds: rows.map(({ p }) => p.id) } })
    return {
      patients: rows.map(({ p, lastVisit: lv }): PatientSummary => ({ ...toSummary(p, lv), activeAllergies: allergyRows.filter((a) => a.patientId === p.id).map((a) => a.substance) })),
    }
  })

  // ---- Register ----
  app.post('/api/patients', { config: { permission: 'patients:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const body = parse(CreatePatientRequest, req.body)
    const { confirmNotDuplicate, ...data } = body

    if (!confirmNotDuplicate) {
      const name = `${data.givenName} ${data.familyName ?? ''}`.trim().toLowerCase()
      const dupes = await db
        .select()
        .from(patients)
        .where(and(eq(patients.facilityId, me.facilityId), or(eq(patients.phone, data.phone), and(eq(patients.dateOfBirth, data.dateOfBirth), sql`trim(${patients.searchName}) = ${name}`))))
        .limit(5)
      if (dupes.length) {
        const candidates: DuplicateCandidate[] = dupes.map((p) => ({ id: p.id, mrn: p.mrn, fullName: fullName(p), dateOfBirth: p.dateOfBirth, phone: p.phone }))
        // The warning shows existing patients' identities, so it is audited like a read.
        await audit(db, req, { action: 'patient.duplicate_warning', details: { patientIds: dupes.map((p) => p.id) } })
        return reply.code(409).send({ error: 'possible_duplicate', message: 'A patient with the same phone number, or the same name and date of birth, already exists.', candidates })
      }
    }

    const created = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(patients)
        .values({ ...data, facilityId: me.facilityId, createdBy: me.id, dataOrigin })
        .returning()
      await audit(tx, req, { action: 'patient.create', entityType: 'patient', entityId: p!.id, patientId: p!.id, details: { mrn: p!.mrn, duplicateWarningOverridden: !!confirmNotDuplicate } })
      return p!
    })
    return reply.code(201).send(await loadPatientDetail(db, created))
  })

  // ---- Read / update ----
  app.get('/api/patients/:id', { config: { permission: 'patients:read' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    const p = await getPatientOr404(db, me.facilityId, id)
    await audit(db, req, { action: 'patient.read', entityType: 'patient', entityId: id, patientId: id })
    return loadPatientDetail(db, p)
  })

  app.patch('/api/patients/:id', { config: { permission: 'patients:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    const body = parse(UpdatePatientRequest, req.body)
    await getPatientOr404(db, me.facilityId, id)
    const [p] = await db.transaction(async (tx) => {
      const r = await tx
        .update(patients)
        .set({ ...body, updatedAt: sql`now()` })
        .where(eq(patients.id, id))
        .returning()
      await audit(tx, req, { action: 'patient.update', entityType: 'patient', entityId: id, patientId: id, details: { changed: Object.keys(body) } })
      return r
    })
    return loadPatientDetail(db, p!)
  })

  // ---- Allergies ----
  app.post('/api/patients/:id/allergies', { config: { permission: 'patients:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    const body = parse(AllergyInput, req.body)
    await getPatientOr404(db, me.facilityId, id)
    await db.transaction(async (tx) => {
      const [a] = await tx.insert(allergies).values({ patientId: id, ...body, recordedBy: me.id }).returning({ id: allergies.id })
      // Recording an allergy contradicts "no known allergies".
      await tx.update(patients).set({ noKnownAllergies: false, updatedAt: sql`now()` }).where(eq(patients.id, id))
      await audit(tx, req, { action: 'allergy.create', entityType: 'allergy', entityId: a!.id, patientId: id })
    })
    return reply.code(201).send(await loadPatientDetail(db, await getPatientOr404(db, me.facilityId, id)))
  })

  app.post('/api/patients/:id/allergies/:subId/deactivate', { config: { permission: 'patients:write' } }, async (req) => {
    const me = currentUser(req)
    const { id, subId } = parse(SubParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const [a] = await db
      .update(allergies)
      .set({ status: 'inactive', updatedAt: sql`now()` })
      .where(and(eq(allergies.id, subId), eq(allergies.patientId, id)))
      .returning({ id: allergies.id })
    if (!a) throw notFound('Allergy')
    await audit(db, req, { action: 'allergy.deactivate', entityType: 'allergy', entityId: subId, patientId: id })
    return loadPatientDetail(db, await getPatientOr404(db, me.facilityId, id))
  })

  app.put('/api/patients/:id/no-known-allergies', { config: { permission: 'patients:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    const { noKnownAllergies } = parse(z.object({ noKnownAllergies: z.boolean() }), req.body)
    await getPatientOr404(db, me.facilityId, id)
    if (noKnownAllergies) {
      const active = await db.query.allergies.findFirst({ where: and(eq(allergies.patientId, id), eq(allergies.status, 'active')) })
      if (active) throw conflict('Deactivate the recorded allergies first', 'has_active_allergies')
    }
    await db.update(patients).set({ noKnownAllergies, updatedAt: sql`now()` }).where(eq(patients.id, id))
    await audit(db, req, { action: 'patient.no_known_allergies', entityType: 'patient', entityId: id, patientId: id, details: { noKnownAllergies } })
    return loadPatientDetail(db, await getPatientOr404(db, me.facilityId, id))
  })

  // ---- Consents ----
  // Granting under the current wording; an earlier-wording grant is renewed (superseded) in the same step.
  app.post('/api/patients/:id/consents', { config: { permission: 'consents:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    const body = parse(RecordConsentRequest, req.body)
    await getPatientOr404(db, me.facilityId, id)
    await db.transaction((tx) => grantConsent(tx, req, { patientId: id, type: body.type, method: body.method, notes: body.notes ?? null, recordedBy: me.id }))
    return reply.code(201).send(await loadPatientDetail(db, await getPatientOr404(db, me.facilityId, id)))
  })

  /** Withdraws the purpose of this consent: every active grant of that type ends, with its consequences. */
  app.post('/api/patients/:id/consents/:subId/withdraw', { config: { permission: 'consents:write' } }, async (req) => {
    const me = currentUser(req)
    const { id, subId } = parse(SubParams, req.params)
    const body = parse(WithdrawConsentRequest, req.body ?? {})
    await getPatientOr404(db, me.facilityId, id)
    const c = await db.query.consents.findFirst({ where: and(eq(consents.id, subId), eq(consents.patientId, id), eq(consents.status, 'granted')) })
    if (!c) throw notFound('Active consent')
    await db.transaction((tx) => withdrawConsentType(tx, req, id, c.type, { userId: me.id, via: 'staff', reason: body.reason ?? null }))
    return loadPatientDetail(db, await getPatientOr404(db, me.facilityId, id))
  })

  /** Switches the patient's portal account off at once (e.g. a password may be known to someone else). */
  app.post('/api/patients/:id/portal-account/disable', { config: { permission: 'patients:write' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    await getPatientOr404(db, me.facilityId, id)
    const account = await db.query.users.findFirst({ where: and(eq(users.patientId, id), eq(users.role, 'patient')) })
    if (!account) throw notFound('Portal account')
    await db.transaction(async (tx) => {
      await tx.update(users).set({ isActive: false, updatedAt: sql`now()` }).where(eq(users.id, account.id))
      await revokeUserSessions(tx, account.id)
      await tx
        .update(patientActivationCodes)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(patientActivationCodes.patientId, id), isNull(patientActivationCodes.usedAt), isNull(patientActivationCodes.revokedAt)))
      await audit(tx, req, { action: 'patient.portal_disable', entityType: 'user', entityId: account.id, patientId: id })
    })
    return loadPatientDetail(db, await getPatientOr404(db, me.facilityId, id))
  })

  // ---- Patient portal activation code (shown once to staff, handed to the patient) ----
  app.post('/api/patients/:id/portal-activation', { config: { permission: 'patients:write' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(PatientParams, req.params)
    const p = await getPatientOr404(db, me.facilityId, id)
    // A code for an existing account is a reset: it sets a new password and switches the account back on.
    const account = await db.query.users.findFirst({ where: eq(users.patientId, id) })
    await requireConsent(db, req, { patientId: id, type: 'portal_access', purpose: account ? 'portal account reset' : 'portal activation', acceptOlderWording: true })
    const code = newActivationCode()
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_MS)
    await db.transaction(async (tx) => {
      await tx
        .update(patientActivationCodes)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(patientActivationCodes.patientId, id), isNull(patientActivationCodes.usedAt), isNull(patientActivationCodes.revokedAt)))
      await tx.insert(patientActivationCodes).values({ patientId: id, codeHash: hashActivationCode(code), expiresAt, createdBy: me.id })
      await audit(tx, req, { action: 'patient.portal_code_issue', entityType: 'patient', entityId: id, patientId: id, details: { reset: !!account } })
    })
    const body: ActivationCodeResponse = { activationCode: code, expiresAt: expiresAt.toISOString(), mrn: p.mrn, reset: !!account }
    return reply.code(201).send(body)
  })
}
