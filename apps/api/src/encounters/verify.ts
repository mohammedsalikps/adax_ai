import { ENCOUNTER_HASH_SCHEME_V2, ENCOUNTER_HASH_SCHEME_V3, ENCOUNTER_HASH_SCHEMES, type EncounterVerification, type VerificationCheck } from '@adaxai/contracts'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db, DbOrTx } from '../db/client.ts'
import { auditEvents, diagnoses, encounters, noteInsertions, patients, prescriptionItems, users } from '../db/schema.ts'
import { fullName } from '../patients/service.ts'
import { canonicalJson, type EncounterRow, sha256 } from './service.ts'

/**
 * Signed-record verification. What is covered, and how, is versioned:
 *
 * - adaxai.encounter.v1 (records signed before migration 0019, which carry no
 *   scheme marker): SHA-256 of canonicalJson(snapshot): JSON with object keys
 *   sorted, no whitespace.
 * - adaxai.encounter.v2: the same serialisation, but strict (it
 *   refuses undefined values, non-finite numbers and non-plain objects, so a
 *   fingerprint is never computed over something the stored JSON cannot
 *   reproduce), and the snapshot names its scheme and also covers the
 *   facility, visit id, reason for visit and the signing attestation.
 * - adaxai.encounter.v3 (current, HERO final): v2, and each medicine also
 *   carries its structured course: durationDays and startDate (null when the
 *   medicine has none). The record's rows are compared with those as well.
 *
 * All cover: patient identity (id, MRN, name, date of birth, sex), doctor
 * (id, name, registration number), visit date and token, the seven note
 * sections, diagnoses, prescription (as written: medicine, strength, form,
 * dose, route, frequency, duration, instructions), references to AI-assisted
 * text in the note, and the signing time. Not covered: vitals, allergies,
 * attached images and recordings, completing the consultation (it happens
 * after signing and changes the visit, not the record), and anything changed
 * in other tables after signing. A v1 or v2 record's medicines are checked
 * without a structured course (those schemes do not cover one).
 *
 * Amendments (adaxai.amendment.v1) are fingerprinted by the database when they
 * are added (migration 0019): each links to the previous one, the first to the
 * record's content hash. The canonical text is rebuilt here independently of
 * the database function.
 */
export const LEGACY_ENCOUNTER_HASH_SCHEME = 'adaxai.encounter.v1'
export const AMENDMENT_HASH_SCHEME = 'adaxai.amendment.v1'
const UTC_MICROS = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'

/** Sorted-key JSON that refuses anything JSON storage would not reproduce exactly. */
export function canonicalJsonStrict(value: unknown, path = '$'): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`)
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => canonicalJsonStrict(v, `${path}[${i}]`)).join(',')}]`
      const proto = Object.getPrototypeOf(value) as unknown
      if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not a plain object`)
      const o = value as Record<string, unknown>
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJsonStrict(o[k], `${path}.${k}`)}`)
        .join(',')}}`
    }
    default:
      throw new Error(`${path} (${typeof value}) cannot be part of a signed record`)
  }
}

/** The content hash of a signed snapshot under a scheme; null for a scheme this version does not support. */
export function signedContentHash(snapshot: unknown, scheme: string): string | null {
  if (scheme === LEGACY_ENCOUNTER_HASH_SCHEME) return sha256(canonicalJson(snapshot))
  // v2 and v3 serialise the same way; v3's snapshot holds more (each medicine's course).
  if (scheme === ENCOUNTER_HASH_SCHEME_V2 || scheme === ENCOUNTER_HASH_SCHEME_V3) return sha256(canonicalJsonStrict(snapshot))
  return null
}

/** Whether a scheme's signed prescription covers each medicine's structured course (durationDays, startDate). */
export const schemeCoversCourse = (scheme: string) => scheme === ENCOUNTER_HASH_SCHEME_V3

const jsonText = (v: string | null) => (v === null ? 'null' : JSON.stringify(v))

/** The amendment's canonical text: the jsonb array the database fingerprints, printed as PostgreSQL prints it. */
export function amendmentCanonical(a: { scheme: string; encounterId: string; seq: number; prevHash: string | null; authorId: string; createdAt: string; reason: string; content: string }): string {
  return `[${[jsonText(a.scheme), jsonText(a.encounterId), String(a.seq), jsonText(a.prevHash), jsonText(a.authorId), jsonText(a.createdAt), jsonText(a.reason), jsonText(a.content)].join(', ')}]`
}

interface AmendmentRow {
  id: string
  author_id: string
  reason: string
  content: string
  seq: number | null
  prev_hash: string | null
  content_hash: string | null
  hash_scheme: string | null
  created_at: string
}

type Snapshot = {
  scheme?: unknown
  encounterId?: unknown
  facilityId?: unknown
  patient?: { id?: unknown; fullName?: unknown; dateOfBirth?: unknown }
  doctor?: { id?: unknown; fullName?: unknown; registrationNumber?: unknown }
  visit?: { id?: unknown }
  note?: unknown
  diagnoses?: unknown
  prescription?: unknown
  aiInsertions?: { id?: unknown; section?: unknown }[]
  signedAt?: unknown
}

const NOTE_KEYS = ['chiefComplaint', 'history', 'pastHistory', 'examination', 'assessment', 'plan', 'followUp'] as const

/**
 * Verifies a record from one consistent snapshot of the database (read-only,
 * repeatable read), so a change committed while the check runs, such as a new
 * amendment and its audit entry, is either wholly seen or not at all.
 */
export async function verifyEncounterById(db: Db, id: string): Promise<EncounterVerification> {
  return db.transaction(
    async (tx) => {
      const e = await tx.query.encounters.findFirst({ where: eq(encounters.id, id) })
      if (!e) throw new Error(`consultation ${id} not found`)
      return verifyEncounter(tx, e)
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

export async function verifyEncounter(db: DbOrTx, e: EncounterRow): Promise<EncounterVerification> {
  const checks: VerificationCheck[] = []
  const notes: string[] = []
  const fail = (key: string, label: string, detail: string) => checks.push({ key, label, result: 'fail', detail })
  const pass = (key: string, label: string, detail: string) => checks.push({ key, label, result: 'pass', detail })
  const skip = (key: string, label: string, detail: string) => checks.push({ key, label, result: 'not_checked', detail })

  const am = (
    await db.execute(sql`select id, author_id, reason, content, seq, prev_hash, content_hash, hash_scheme,
      to_char(created_at at time zone 'UTC', ${UTC_MICROS}) as created_at
      from encounter_amendments where encounter_id = ${e.id} order by seq nulls first, created_at, id`)
  ).rows as unknown as AmendmentRow[]
  const linked = am.filter((a) => a.seq !== null)
  const amendments = { total: am.length, linked: linked.length, beforeLinking: am.length - linked.length }
  const base = { encounterId: e.id, contentHash: e.contentHash, amendments, checkedAt: new Date().toISOString() }
  const done = (status: EncounterVerification['status'], scheme: string | null, recomputedHash: string | null): EncounterVerification => ({ ...base, status, scheme, schemeRecorded: !!e.hashScheme, recomputedHash, checks, notes })

  if (e.status !== 'signed') {
    skip('signed', 'Record is signed', e.status === 'discarded' ? 'This is a discarded draft. Only signed records have a fingerprint.' : 'This consultation is an unsigned draft. Only signed records have a fingerprint.')
    return done('unverifiable', null, null)
  }
  if (!e.signedSnapshot || !e.contentHash) {
    fail('fingerprint', 'Fingerprint recorded', 'The signed content or its fingerprint is missing, so the record cannot be checked.')
    return done('unverifiable', e.hashScheme, null)
  }
  const snap = e.signedSnapshot as Snapshot
  const supported = (x: string) => (ENCOUNTER_HASH_SCHEMES as readonly string[]).includes(x)

  // The audit log's entries for the signing and the amendments: written at the time, linked in the audit chain.
  const signEntries = await db
    .select({ hash: sql<string | null>`${auditEvents.details}->>'contentHash'`, scheme: sql<string | null>`${auditEvents.details}->>'hashScheme'` })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'encounter.sign'), eq(auditEvents.entityId, e.id)))
  const amendEntries = await db
    .select({ id: sql<string>`${auditEvents.details}->>'amendmentId'`, seq: sql<string | null>`${auditEvents.details}->>'seq'`, hash: sql<string | null>`${auditEvents.details}->>'contentHash'` })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, 'encounter.amend'), eq(auditEvents.entityId, e.id)))

  // The scheme column can be edited; the signed content and the audit entry say which scheme was used.
  // Version 1 left no marker anywhere: an absent marker is evidence of version 1 (current signings always write one).
  const recorded = e.hashScheme ?? LEGACY_ENCOUNTER_HASH_SCHEME
  const named = [...new Set([snap.scheme === undefined ? LEGACY_ENCOUNTER_HASH_SCHEME : String(snap.scheme), ...signEntries.map((x) => x.scheme ?? LEGACY_ENCOUNTER_HASH_SCHEME)])]
  const schemeChanged = named.some((x) => x !== recorded)
  let scheme = recorded
  if (schemeChanged) {
    fail('scheme', 'Fingerprint version', `The record's fingerprint version (${e.hashScheme ?? 'none recorded'}) differs from the one named by its signed content or its audit entry (${named.join(', ') || 'none'}): it was changed after signing.`)
    // Check the content under the version the evidence names, where possible.
    scheme = named.find(supported) ?? scheme
  } else if (!supported(scheme)) {
    // Even then, the audit log's copy of the fingerprint must agree.
    if (signEntries.some((x) => x.hash !== e.contentHash)) {
      fail('sign_audit', 'Audit log has the same fingerprint', 'The fingerprint in the audit log entry for the signing differs from the record.')
      return done('invalid', scheme, null)
    }
    skip('scheme', 'Fingerprint version', `Fingerprint version "${scheme}" is not supported by this version of ADAXAI, so the content was not checked.`)
    return done('unsupported_version', scheme, null)
  } else pass('scheme', 'Fingerprint version', e.hashScheme ? `Version ${scheme.split('.').pop()} (${scheme}).` : 'This record was signed before fingerprint versions were recorded; checked as version 1.')

  // 1. The stored signed content still produces the stored fingerprint.
  let recomputed: string | null = null
  try {
    recomputed = supported(scheme) ? signedContentHash(snap, scheme) : null
  } catch (err) {
    fail('content_hash', 'Content matches its fingerprint', `The signed content cannot be serialised under ${scheme}: ${(err as Error).message}.`)
  }
  if (recomputed !== null) {
    if (recomputed !== e.contentHash) fail('content_hash', 'Content matches its fingerprint', 'The signed content no longer produces the fingerprint recorded at signing: it was changed after signing.')
    else pass('content_hash', 'Content matches its fingerprint', 'SHA-256 of the signed content equals the fingerprint recorded at signing.')
  }

  // 2. The record's own rows still say what was signed (they are frozen by the database).
  const [dx, rxRows, ins] = await Promise.all([
    db.select({ description: diagnoses.description, code: diagnoses.code, kind: diagnoses.kind }).from(diagnoses).where(eq(diagnoses.encounterId, e.id)).orderBy(asc(diagnoses.sortOrder)),
    db
      .select({
        drugName: prescriptionItems.drugName,
        strength: prescriptionItems.strength,
        form: prescriptionItems.form,
        dose: prescriptionItems.dose,
        route: prescriptionItems.route,
        frequency: prescriptionItems.frequency,
        duration: prescriptionItems.duration,
        instructions: prescriptionItems.instructions,
        durationDays: prescriptionItems.durationDays,
        startDate: prescriptionItems.startDate,
      })
      .from(prescriptionItems)
      .where(eq(prescriptionItems.encounterId, e.id))
      .orderBy(asc(prescriptionItems.sortOrder)),
    db.select({ id: noteInsertions.id, section: noteInsertions.section }).from(noteInsertions).where(eq(noteInsertions.encounterId, e.id)),
  ])
  // Under v3 the medicines' rows are compared with their course; under v1 and v2 without it (those schemes did not sign one).
  const withCourse = schemeCoversCourse(scheme)
  const rx = withCourse ? rxRows : rxRows.map(({ durationDays: _d, startDate: _s, ...written }) => written)
  if (!withCourse && rxRows.some((r) => r.durationDays !== null || r.startDate !== null)) {
    notes.push(`Some medicines have a course length or start date, which fingerprint version ${scheme.split('.').pop()} does not cover.`)
  }
  const liveNote = Object.fromEntries(NOTE_KEYS.map((k) => [k, e[k]]))
  const sameRefs = (a: { id?: unknown; section?: unknown }[]) =>
    a
      .map((x) => `${String(x.id)}:${String(x.section)}`)
      .sort()
      .join('|')
  const differences = [
    canonicalJson(liveNote) !== canonicalJson(snap.note) && 'note',
    canonicalJson(dx) !== canonicalJson(snap.diagnoses) && 'diagnoses',
    canonicalJson(rx) !== canonicalJson(snap.prescription) && 'prescription',
    sameRefs(ins) !== sameRefs(snap.aiInsertions ?? []) && 'AI-assisted text references',
    (snap.encounterId !== e.id || snap.patient?.id !== e.patientId || snap.doctor?.id !== e.doctorId) && 'record identity',
    // Whenever the signed content names them (scheme v2), whatever the scheme column says.
    ((snap.visit?.id !== undefined && snap.visit.id !== e.visitId) || (snap.facilityId !== undefined && snap.facilityId !== e.facilityId)) && 'visit or facility',
    e.signedAt?.toISOString() !== snap.signedAt && 'signing time',
  ].filter(Boolean)
  if (differences.length) fail('record_matches', 'Record matches what was signed', `The stored record differs from the signed content in: ${differences.join(', ')}.`)
  else pass('record_matches', 'Record matches what was signed', 'Note, diagnoses, prescription, AI-assisted text references and signing time are as signed.')

  // 3. The audit log's copy of the fingerprint, written when the record was signed.
  if (!signEntries.length) skip('sign_audit', 'Audit log has the same fingerprint', 'There is no signing entry for this record in the audit log, so this was not checked.')
  else if (signEntries.some((x) => x.hash !== e.contentHash)) fail('sign_audit', 'Audit log has the same fingerprint', 'The fingerprint in the audit log entry for the signing differs from the record.')
  else pass('sign_audit', 'Audit log has the same fingerprint', 'The audit log entry written at signing holds the same fingerprint.')

  // 4. Amendments: each linked amendment follows the previous one, starting at the record's fingerprint.
  if (!am.length) pass('amendments', 'Amendments are intact', 'No amendments.')
  else {
    const problems: string[] = []
    const unlinked = am.filter((a) => a.seq === null)
    // Unlinked amendments exist only on records signed before linking began, and only before the first linked one.
    if (unlinked.length && e.hashScheme) problems.push(`${unlinked.length} amendment(s) have no link although the record was signed after linking began`)
    const firstLinked = linked[0]?.created_at
    if (firstLinked && unlinked.some((a) => a.created_at > firstLinked)) problems.push('an amendment without a link was added after linked ones')
    let expected = amendments.beforeLinking + 1
    let prev: string | null = e.contentHash
    for (const a of linked) {
      if (a.hash_scheme !== AMENDMENT_HASH_SCHEME) {
        problems.push(`amendment ${a.seq} uses an unsupported fingerprint version`)
        continue
      }
      if (a.seq !== expected) problems.push(`amendment ${expected} is missing or out of order`)
      if (a.prev_hash !== prev) problems.push(`amendment ${a.seq} does not follow the one before it`)
      const h = sha256(amendmentCanonical({ scheme: a.hash_scheme, encounterId: e.id, seq: a.seq!, prevHash: a.prev_hash, authorId: a.author_id, createdAt: a.created_at, reason: a.reason, content: a.content }))
      if (h !== a.content_hash) problems.push(`amendment ${a.seq} was changed after it was added`)
      prev = a.content_hash
      expected = a.seq! + 1
    }
    if (problems.length) fail('amendments', 'Amendments are intact', `${problems.slice(0, 5).join('; ')}.`)
    else if (!linked.length) skip('amendments', 'Amendments are intact', `${am.length} amendment(s) were added before amendments were fingerprinted; their text is not covered.`)
    else pass('amendments', 'Amendments are intact', `${linked.length} amendment(s) are linked in order to the signed record${amendments.beforeLinking ? `; ${amendments.beforeLinking} earlier one(s) were added before amendments were fingerprinted and are not covered` : ''}.`)
  }

  // 5. Amendments and their audit entries agree: none added outside the application, none removed since.
  if (am.length || amendEntries.length) {
    const rows = new Map(am.map((a) => [a.id, a]))
    const audited = new Map(amendEntries.map((x) => [x.id, x]))
    const problems: string[] = []
    const unaudited = am.filter((a) => !audited.has(a.id)).length
    if (unaudited) problems.push(`${unaudited} amendment(s) have no audit entry: they were not added through the application`)
    const removed = amendEntries.filter((x) => !rows.has(x.id)).length
    if (removed) problems.push(`${removed} amendment(s) recorded in the audit log are missing: they were removed after they were added`)
    const differ = amendEntries.filter((x) => {
      const a = rows.get(x.id)
      return a && ((x.seq !== null && Number(x.seq) !== a.seq) || (x.hash !== null && x.hash !== a.content_hash))
    }).length
    if (differ) problems.push(`${differ} amendment(s) differ from their audit entry`)
    if (problems.length) fail('amendment_audit', 'Amendments agree with the audit log', `${problems.join('; ')}.`)
    else pass('amendment_audit', 'Amendments agree with the audit log', 'Each amendment has its audit entry, and every audited amendment is present.')
  }

  // Changes elsewhere that are not tampering, but that a reader should know about.
  const [p] = await db.select({ givenName: patients.givenName, familyName: patients.familyName, dateOfBirth: patients.dateOfBirth }).from(patients).where(eq(patients.id, e.patientId))
  const [d] = await db.select({ fullName: users.fullName, registrationNumber: users.registrationNumber }).from(users).where(eq(users.id, e.doctorId))
  if (p && snap.patient?.fullName !== fullName(p)) notes.push("The patient's name has changed since signing; the signed content keeps the name at signing.")
  if (p && snap.patient?.dateOfBirth !== p.dateOfBirth) notes.push("The patient's date of birth has changed since signing.")
  if (d && (snap.doctor?.fullName !== d.fullName || (snap.doctor?.registrationNumber ?? null) !== d.registrationNumber)) notes.push("The doctor's name or registration number has changed since signing.")

  const status = checks.some((c) => c.result === 'fail') ? 'invalid' : 'valid'
  return done(status, scheme, recomputed)
}
