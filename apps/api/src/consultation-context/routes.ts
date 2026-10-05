import type { ConsultationContext } from '@adaxai/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../audit/audit.ts'
import { currentUser } from '../auth/plugin.ts'
import type { Config } from '../config.ts'
import type { Db } from '../db/client.ts'
import type { RateLimiter } from '../http/rate-limit.ts'
import { parse } from '../http/validate.ts'
import type { AppSettings } from '../settings/schema.ts'
import { buildConsultationContext, type ContextDeps } from './build.ts'

const IdParams = z.object({ id: z.uuid() })

/**
 * An open consultation reads its context again and again (its Overview, the device ages, after each review): the audit log records that someone
 * looked at it once per user, consultation and this many seconds, not once per read.
 */
export const CONTEXT_AUDIT_WINDOW_SECONDS = 300

export interface ContextRouteDeps {
  db: Db
  config: Config
  settings: AppSettings
  limiter: RateLimiter
  /** The clock device states are decided on (the device boundary's own); defaults to the system clock. */
  clock?: (() => number) | undefined
  reasoningStatus?: ContextDeps['reasoningStatus']
}

/**
 * D2: GET /api/encounters/:id/context, the consultation's context and its multimodal summary (build.ts). Readable by whoever may read the
 * consultation (doctors and nurses of its facility); what each viewer is shown inside it is decided there. Read-only.
 */
export function registerConsultationContextRoutes(app: FastifyInstance, deps: ContextRouteDeps) {
  const { db, config, settings, limiter } = deps
  const clock = deps.clock ?? Date.now

  app.get('/api/encounters/:id/context', { config: { permission: 'encounters:read' } }, async (req): Promise<ConsultationContext> => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const out = await buildConsultationContext(
      { db, config, settings, reasoningStatus: deps.reasoningStatus, onSourceError: (source, err) => req.log.warn({ err, source, encounterId: id }, 'consultation context: a source could not be read') },
      me,
      id,
      { now: clock() },
    )
    const key = `encounter-context-read:${me.id}:${id}`
    if (limiter.hit(key, { max: 1, windowSeconds: CONTEXT_AUDIT_WINDOW_SECONDS }).allowed) {
      // Counts only: never a word of the conversation, a value, an image or a recording.
      const kinds: Record<string, number> = {}
      for (const x of out.evidence) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1
      try {
        await audit(db, req, {
          action: 'encounter.context_viewed',
          entityType: 'encounter',
          entityId: id,
          patientId: out.patientId,
          details: { kinds, conflicts: out.conflicts.length, missing: out.missing.length, pending: out.pending, rules: out.rules, repeatsNotLoggedForSeconds: CONTEXT_AUDIT_WINDOW_SECONDS },
        })
      } catch (err) {
        // The window is spent only on a look that was recorded: this one was not (and is refused), so the next read is audited.
        limiter.reset(key)
        throw err
      }
    }
    return out
  })
}
