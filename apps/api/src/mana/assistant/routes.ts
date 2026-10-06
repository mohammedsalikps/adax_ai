import { AskManaAssistantRequest, ManaActionDecisionRequest, OpenManaConversationRequest, SelectManaCandidateRequest } from '@adaxai/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Transcriber } from '../../ai/providers.ts'
import { currentUser } from '../../auth/plugin.ts'
import type { Db } from '../../db/client.ts'
import { enforceLimit, type RateLimiter } from '../../http/rate-limit.ts'
import { parse } from '../../http/validate.ts'
import type { AppSettings } from '../../settings/schema.ts'
import type { ManaAssistantService } from './service.ts'

const IdParams = z.object({ id: z.uuid() })

export interface ManaAssistantRouteDeps {
  db: Db
  service: ManaAssistantService
  limiter: RateLimiter
  settings: AppSettings
  /** The local speech model, for a spoken question (HERO final). Absent or null: the voice route says the speech service is not set up. */
  transcriber?: Transcriber | null
}

/**
 * Mana AI, the doctor's assistant over the clinic's records. Doctors only (`ai:use`, the permission of every AI feature): the role check is the first thing
 * that happens to any request here, before a conversation is looked at, and a conversation can only be read by the doctor it belongs to. The answer is made in
 * the background and polled; no route writes to a patient's record, an appointment or a permission. The client never names a clinic, a tool or a query: what to
 * look up is the server's own plan. It names a patient in two places only, and each is checked by the server: opening a conversation for a consultation or a patient
 * record the doctor has open (it must belong to the doctor's clinic), and choosing one of the patients Mana offered (a handle from the conversation, not an id).
 */
export function registerManaAssistantRoutes(app: FastifyInstance, { db, service, limiter, settings, transcriber = null }: ManaAssistantRouteDeps) {
  const limits = settings.security.rateLimits

  app.get('/api/mana-assistant/status', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const fresh = (req.query as { fresh?: string }).fresh === '1'
    // "Check again" asks the model server itself: a script that does it in a loop is slowed down like one that asks questions in a loop.
    if (fresh) await enforceLimit(db, limiter, req, reply, 'mana-health', me.id, limits.aiStepPerUser)
    return service.status({ fresh })
  })

  /** Opens (or continues) the doctor's conversation for a consultation, a patient, or the clinic in general. */
  app.post('/api/mana-assistant/conversations', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const body = parse(OpenManaConversationRequest, req.body ?? {})
    // Opening is cheap but writes a row: a script that opens conversations in a loop is slowed down like one that asks questions in a loop.
    await enforceLimit(db, limiter, req, reply, 'mana-open', me.id, limits.aiStepPerUser)
    return service.open(req, me, body)
  })

  app.get('/api/mana-assistant/conversations/:id', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    // `fresh=1`: ask the model server again instead of using what it said a few seconds ago (the doctor pressed "Check again").
    const fresh = (req.query as { fresh?: string }).fresh === '1'
    if (fresh) await enforceLimit(db, limiter, req, reply, 'mana-health', me.id, limits.aiStepPerUser)
    return service.stateOf(me, id, { fresh })
  })

  app.post('/api/mana-assistant/conversations/:id/messages', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(AskManaAssistantRequest, req.body)
    await enforceLimit(db, limiter, req, reply, 'ai-step', me.id, limits.aiStepPerUser)
    const { state, created } = await service.ask(req, me, id, body)
    // 202: accepted, being answered (poll it). 200: the same question again.
    return reply.code(created ? 202 : 200).send(state)
  })

  /** The doctor chose one of the patients Mana found for a name. */
  app.post('/api/mana-assistant/conversations/:id/select', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(SelectManaCandidateRequest, req.body)
    await enforceLimit(db, limiter, req, reply, 'ai-step', me.id, limits.aiStepPerUser)
    const { state, created } = await service.select(req, me, id, body)
    return reply.code(created ? 202 : 200).send(state)
  })

  app.post('/api/mana-assistant/messages/:id/cancel', { config: { permission: 'ai:use' } }, async (req) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    return service.cancel(req, me, id)
  })

  /**
   * HERO final: the doctor's Approve or Cancel on an action an answer proposed (a medicine to add to the open consultation's draft). Records the decision
   * once and audits it (ids only); nothing clinical is written: the doctor's screen adds the medicine to the unsigned draft.
   */
  app.post('/api/mana-assistant/messages/:id/decision', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    const { id } = parse(IdParams, req.params)
    const body = parse(ManaActionDecisionRequest, req.body)
    await enforceLimit(db, limiter, req, reply, 'ai-step', me.id, limits.aiStepPerUser)
    const { result, created } = await service.decide(req, me, id, body)
    return reply.code(created ? 201 : 200).send(result)
  })

  /**
   * HERO final: a spoken question (multipart: `conversationId`, `durationMs`, then one short audio file), transcribed in memory by the local speech model
   * and returned as text; nothing is stored. Limited like the consultation's audio routes (per user).
   */
  app.post('/api/mana-assistant/voice', { config: { permission: 'ai:use' } }, async (req, reply) => {
    const me = currentUser(req)
    await enforceLimit(db, limiter, req, reply, 'ai-audio', me.id, limits.aiAudioPerUser)
    return service.voice(req, me, transcriber)
  })
}
