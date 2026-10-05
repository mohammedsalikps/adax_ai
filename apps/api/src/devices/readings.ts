import { type AttachedDevice, DEVICE_READING_KINDS, type DeviceKind, type DeviceReading, flagVital, type PatientDeviceReadings, type ReadingState, readingState, usesGateway } from '@adaxai/contracts'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import type { Config } from '../config.ts'
import { consentState } from '../consents/service.ts'
import type { DbOrTx } from '../db/client.ts'
import { deviceAssignments, deviceBatches, devices, observations } from '../db/schema.ts'
import { ageOn, facilityToday, type PatientRow } from '../patients/service.ts'
import type { AppSettings } from '../settings/schema.ts'
import { simulatorAllowed } from './gateway.ts'

/**
 * The read model behind the consultation's "Device readings" card: the devices attached to ONE patient of the caller's facility now, and for each
 * the newest reading of every kind it may send, from this assignment, with a state that says how current it is. The state is decided here, on
 * the server's clock, by the same function the screen uses to age it between two reads. Nothing is ever filled in: a kind with no reading has none.
 *
 * It is read every few seconds for as long as a consultation is open, and an assignment can run for weeks: each kind is one index look-up
 * (`observations_device_kind_idx`), and the number stored comes from the assignment's batches, not from counting its readings.
 */

type DeviceRow = typeof devices.$inferSelect
type AssignmentRow = typeof deviceAssignments.$inferSelect

/** Why nothing can arrive through this device now, in words; null when something can. */
function unavailableBecause(d: DeviceRow, a: AssignmentRow, consented: boolean, config: Config, now: number): string | null {
  if (d.status !== 'active') return 'This device is retired.'
  if (!usesGateway(d.integration)) return d.integration === 'manual_upload' ? 'This device has no gateway: its files are uploaded by staff, so no readings arrive from it.' : 'This device is in the registry only: no gateway is connected to it, so no readings can arrive.'
  if (d.integration === 'simulator' && !simulatorAllowed(config)) return 'A simulator may not post in this deployment.'
  if (!consented) return 'The patient’s consent to device readings is not in place, so nothing is stored.'
  if (a.validUntil && a.validUntil.getTime() <= now) return 'The time this device was attached for is over. End the assignment; it can then be attached again.'
  return null
}

const WHY: Record<Exclude<ReadingState, 'live' | 'unavailable'>, (s: AppSettings['devices'], seen: boolean) => string> = {
  disconnected: (s, seen) => (seen ? `Nothing has been heard from this device’s gateway for more than ${s.disconnectedSeconds} seconds. Any value shown is the last one received.` : 'This device’s gateway has not been in contact since it was registered.'),
  no_data: () => 'The gateway is in contact but has sent no reading since the device was attached.',
  stale: (s) => `The newest reading is more than ${s.liveSeconds} seconds old.`,
}

export async function patientDeviceReadings(db: DbOrTx, patient: PatientRow, settings: AppSettings, config: Config, now: number): Promise<PatientDeviceReadings> {
  // What an attached device sends is stored under an earlier wording of the consent too (the gateway's rule); attaching one needs the current wording.
  const consent = await consentState(db, patient.id, 'device_monitoring')
  const consented = !!consent.consent
  const rows = await db
    .select({ a: deviceAssignments, d: devices })
    .from(deviceAssignments)
    .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
    .where(and(eq(deviceAssignments.patientId, patient.id), eq(devices.facilityId, patient.facilityId), isNull(deviceAssignments.endedAt)))
    .orderBy(desc(deviceAssignments.assignedAt))
  const age = rows.length ? ageOn(String(patient.dateOfBirth), await facilityToday(db, patient.facilityId)) : null
  const t = settings.devices
  const out: AttachedDevice[] = []
  for (const { a, d } of rows) {
    const kinds = [...DEVICE_READING_KINDS[d.kind as DeviceKind]]
    const [latest, [stored]] = await Promise.all([
      Promise.all(
        kinds.map((kind) =>
          db
            .select()
            .from(observations)
            .where(and(eq(observations.deviceId, d.id), eq(observations.kind, kind), eq(observations.patientId, patient.id), gte(observations.measuredAt, a.assignedAt), eq(observations.enteredInError, false)))
            .orderBy(desc(observations.measuredAt), desc(observations.createdAt))
            .limit(1),
        ),
      ).then((perKind) => perKind.flat()),
      db
        .select({ n: sql<number>`coalesce(sum(${deviceBatches.itemCount}), 0)::int` })
        .from(deviceBatches)
        .where(and(eq(deviceBatches.assignmentId, a.id), eq(deviceBatches.kind, 'readings'))),
    ])
    const why = unavailableBecause(d, a, consented, config, now)
    const lastSeenAt = d.lastSeenAt?.getTime() ?? null
    const stateOf = (measuredAt: number | null) => readingState({ now, measuredAt, lastSeenAt, available: why === null }, t)
    const readings: DeviceReading[] = latest.map((o) => ({
      observationId: o.id,
      kind: o.kind,
      value: Number(o.value),
      unit: o.unit,
      // A generated value is not compared with a reference range: a "high" beside it would read as something about the patient.
      flag: o.validationStatus === 'simulated' ? null : flagVital(o.kind, Number(o.value), age),
      measuredAt: o.measuredAt.toISOString(),
      receivedAt: o.createdAt.toISOString(),
      state: stateOf(o.measuredAt.getTime()),
      validationStatus: o.validationStatus === 'simulated' ? 'simulated' : 'device_unverified',
    }))
    const newest = latest.length ? Math.max(...latest.map((o) => o.measuredAt.getTime())) : null
    const state = stateOf(newest)
    out.push({
      assignmentId: a.id,
      deviceId: d.id,
      label: d.label,
      kind: d.kind as DeviceKind,
      integration: d.integration as AttachedDevice['integration'],
      simulated: d.integration === 'simulator',
      assignedAt: a.assignedAt.toISOString(),
      validUntil: a.validUntil?.toISOString() ?? null,
      visitId: a.visitId,
      encounterId: a.encounterId,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      state,
      reason: state === 'live' ? null : state === 'unavailable' ? why : WHY[state](t, lastSeenAt !== null),
      kinds,
      readings,
      readingsStored: stored?.n ?? 0,
    })
  }
  return {
    serverTime: new Date(now).toISOString(),
    thresholds: { liveSeconds: t.liveSeconds, disconnectedSeconds: t.disconnectedSeconds },
    consent: consent.state === 'granted' ? 'granted' : consented ? 'outdated' : 'missing',
    devices: out,
  }
}
