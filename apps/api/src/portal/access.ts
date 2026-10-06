import { and, eq } from 'drizzle-orm'
import { consentState } from '../consents/service.ts'
import type { DbOrTx } from '../db/client.ts'
import { users } from '../db/schema.ts'

/**
 * Whether the patient can see their records in the patient app now: an active portal account AND the patient's portal consent (current or an
 * earlier wording, as the portal itself accepts on every request). Used to tell the doctor, on completing a consultation, whether the
 * prescription is available to the patient; it reveals nothing else about the account.
 */
export async function patientPortalAccess(db: DbOrTx, patientId: string): Promise<boolean> {
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.patientId, patientId), eq(users.role, 'patient'), eq(users.isActive, true)))
    .limit(1)
  if (!account) return false
  const { state } = await consentState(db, patientId, 'portal_access')
  return state === 'granted' || state === 'outdated'
}
