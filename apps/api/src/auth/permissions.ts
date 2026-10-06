import type { Role } from '@adaxai/contracts'

/**
 * Server-side permission matrix. Every protected route declares one of these;
 * the auth hook rejects the request (403, audited) when the caller's role is
 * not listed. The web app hides controls too, but that is convenience only.
 *
 * Admins manage the platform but do not read clinical content.
 */
export const PERMISSIONS = {
  'system:status': ['admin'],
  'overview:read': ['admin'],
  'users:manage': ['admin'],
  'departments:manage': ['admin'],
  'departments:read': ['admin', 'doctor', 'nurse'],
  'staff:read': ['admin', 'doctor', 'nurse'],
  'audit:read': ['admin'],
  'devices:manage': ['admin'],
  'devices:read': ['admin', 'doctor', 'nurse'],
  'devices:assign': ['doctor', 'nurse'],
  'patients:read': ['doctor', 'nurse'],
  'patients:write': ['doctor', 'nurse'],
  'consents:write': ['doctor', 'nurse'],
  /** Conditions, medicines and results on a patient's history. Doctors and nurses read it (patients:read); doctors write. */
  'history:write': ['doctor'],
  'queue:read': ['doctor', 'nurse'],
  'queue:manage': ['doctor', 'nurse'],
  /** The schedule. Administrators see it without patient identity or free text. */
  'appointments:read': ['admin', 'doctor', 'nurse'],
  'appointments:manage': ['doctor', 'nurse'],
  'observations:write': ['doctor', 'nurse'],
  'encounters:read': ['doctor', 'nurse'],
  'encounters:write': ['doctor'],
  'encounters:sign': ['doctor'],
  /** HERO final: the doctor's own day (Home counts, trend and today's patients). */
  'doctor_day:read': ['doctor'],
  /** HERO final: service orders. Nurses see them (and the catalogue); the doctor of the consultation orders and cancels. */
  'orders:read': ['doctor', 'nurse'],
  'orders:write': ['doctor'],
  /** HERO final: uploading a patient's documents (reports, imaging) and marking one as entered in error. Reading them is patients:read. */
  'documents:write': ['doctor', 'nurse'],
  'ai:use': ['doctor'],
  /** Aggregate AI operations and review metrics (no patient-level content). */
  'ai:oversight': ['admin', 'doctor'],
  'thermal:write': ['doctor', 'nurse'],
  'images:write': ['doctor', 'nurse'],
  'thermal:approve': ['doctor'],
  'thermal:label': ['doctor'],
  'thermal:export': ['doctor', 'admin'],
  'portal:self': ['patient'],
} as const satisfies Record<string, readonly Role[]>

export type Permission = keyof typeof PERMISSIONS

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role)
}
