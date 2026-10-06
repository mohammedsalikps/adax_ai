import { sql } from 'drizzle-orm'
import type { DbOrTx } from './client.ts'

/** Where a visit or consultation status change came from (kept in the status history). */
export type LifecycleSource =
  | 'check_in'
  | 'appointment_check_in'
  | 'booking'
  | 'reschedule'
  | 'cancellation'
  | 'no_show'
  | 'queue'
  | 'vitals'
  | 'consultation_start'
  | 'consultation_resume'
  | 'consultation_signed'
  | 'consultation_discarded'
  /** HERO final: the signing doctor completed the consultation (visit in_consultation -> completed; signing no longer completes it). */
  | 'consultation_completed'

/**
 * Names the acting user, the source and the reason for the status changes
 * made in this transaction. The status-history triggers (migration 0019) read
 * these settings, and refuse a status change by the application role that
 * names no user. Call it inside a transaction: the settings end with it.
 */
export async function setLifecycleContext(tx: DbOrTx, c: { actorId: string; source: LifecycleSource; reason?: string | null }): Promise<void> {
  await tx.execute(sql`select set_config('adaxai.actor_id', ${c.actorId}, true), set_config('adaxai.source', ${c.source}, true), set_config('adaxai.reason', ${c.reason ?? ''}, true)`)
}

/** Refusals raised by the lifecycle triggers, answered as conflicts (the API checks first; these are the backstop). */
export const LIFECYCLE_REFUSALS: Record<string, { code: string; message: string }> = {
  AX003: { code: 'invalid_transition', message: 'This status change is not allowed in the current state. Refresh and try again.' },
  AX004: { code: 'consultation_in_progress', message: 'This visit has an unsigned consultation. The doctor must sign or discard it first.' },
  AX005: { code: 'visit_in_consultation', message: 'The patient is with the doctor; the doctor and department cannot change now.' },
  AX006: { code: 'invalid_appointment_change', message: 'This appointment change is not allowed. Refresh and try again.' },
  AX007: { code: 'appointment_closed', message: 'This appointment is closed and cannot be changed.' },
  AX008: { code: 'history_entry_locked', message: 'This history entry cannot be changed. Mark it as entered in error and enter a new one if it is wrong.' },
  // Migration 0033: a service order changes only by moving forward (requested, in progress, completed) or by being cancelled while open.
  AX009: { code: 'service_order_locked', message: 'This order cannot be changed in its current state. Refresh and try again.' },
}
