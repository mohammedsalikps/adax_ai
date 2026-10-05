import crypto from 'node:crypto'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type pg from 'pg'
import { registerAdminRoutes } from './admin/routes.ts'
import { type NotificationChannel } from './appointments/notifications.ts'
import { registerAppointmentRoutes } from './appointments/routes.ts'
import { Gate } from './ai/llm/gate.ts'
import { type AiProviders, providersFromConfig } from './ai/providers.ts'
import { JobService } from './ai/jobs.ts'
import { registerOversightRoutes } from './ai/oversight.ts'
import { type JobExecutor, registerAiRoutes } from './ai/routes.ts'
import { effectiveSettings, loadAppSettings, RoutingRulesSource } from './settings/load.ts'
import type { AppSettings } from './settings/schema.ts'
import { registerFileRoutes } from './files/routes.ts'
import { httpThermalService, type ThermalService } from './thermal/client.ts'
import { registerImageRoutes } from './images/routes.ts'
import { registerDeviceRoutes } from './devices/routes.ts'
import { registerPortalRoutes } from './portal/routes.ts'
import { registerRoutingRoutes } from './routing/routes.ts'
import { registerThermalDatasetRoutes } from './thermal/datasets.ts'
import { registerThermalRoutes } from './thermal/routes.ts'
import { registerThermalSummaryRoutes } from './thermal/summary-routes.ts'
import { registerActivationRoutes } from './auth/activation.ts'
import { encounterIdsForVisits } from './encounters/service.ts'
import { registerEncounterRoutes } from './encounters/routes.ts'
import { registerInsertionRoutes } from './encounters/insertions.ts'
import { registerConsultationRoutes } from './consult/routes.ts'
import { registerConsultationContextRoutes } from './consultation-context/routes.ts'
import { ConsultationService, editableEncounterFor } from './consult/service.ts'
import { registerManaAssistantRoutes } from './mana/assistant/routes.ts'
import { ManaAssistantService } from './mana/assistant/service.ts'
import { registerManaRoutes } from './mana/routes.ts'
import { registerHistoryRoutes } from './history/routes.ts'
import { registerPatientRoutes } from './patients/routes.ts'
import { registerVisitRoutes } from './visits/routes.ts'
import { registerAuth } from './auth/plugin.ts'
import { registerAuthRoutes } from './auth/routes.ts'
import type { Config } from './config.ts'
import { createDb, pgCode } from './db/client.ts'
import { LIFECYCLE_REFUSALS } from './db/lifecycle.ts'
import { audit } from './audit/audit.ts'
import { HttpError } from './http/errors.ts'
import { RateLimiter } from './http/rate-limit.ts'
import { registerHealthRoutes } from './routes/health.ts'

export interface AppDeps {
  config: Config
  pool: pg.Pool
  /** Injected so tests can simulate the thermal service; defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** AI providers; tests inject fakes. Defaults to the configured real providers (or none). */
  ai?: AiProviders
  /** Thermal processing service; tests inject a fake. Defaults to the HTTP service at THERMAL_URL. */
  thermal?: ThermalService
  /** config/adaxai.yaml; tests may pass their own. */
  settings?: AppSettings
  /** config/routing.yaml (re-read on change). */
  routing?: RoutingRulesSource
  /** How appointment messages are delivered; defaults to the patient portal. Tests inject a failing channel. */
  notificationChannel?: NotificationChannel
  /** false: no logging (tests). A stream: the API's own log settings, written to that stream (tests of log content). */
  logger?: false | { stream: NodeJS.WritableStream }
  /** Longest one of Mana's two model calls may take, in milliseconds (default: the AI timeout setting, at most six minutes). Tests set a short one. */
  manaCallTimeoutMs?: number
  /** The clock the device boundary reads (assignment windows, "seen", reading states); tests pass their own. Defaults to the system clock. */
  clock?: () => number
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: 'info',
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
            // Request logs record the path only: query strings can hold patient names, phone numbers or MRNs (search).
            serializers: {
              req: (r: { method: string; url: string; ip?: string }) => ({ method: r.method, url: r.url.split('?')[0], remoteAddress: r.ip }),
              // A database error's message carries the values that were being stored (a transcript, a note): log what failed and the code, never those.
              err: (e: FastifyError) => {
                const code = (e.cause as { code?: string } | undefined)?.code ?? e.code ?? 'unknown'
                return /^Failed query|DrizzleQueryError/.test(`${e.name} ${e.message}`) ? { type: e.name, message: `database query failed (code ${code})`, stack: '' } : { type: e.name, message: e.message, stack: e.stack ?? '' }
              },
            },
            ...(deps.logger?.stream && { stream: deps.logger.stream }),
          },
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  })
  const db = createDb(deps.pool)
  const fetchImpl = deps.fetchImpl ?? fetch

  const settings = effectiveSettings(deps.settings ?? loadAppSettings(), deps.config)
  const limiter = new RateLimiter()
  const limits = settings.security.rateLimits

  void app.register(multipart, { limits: { fileSize: deps.config.maxUploadBytes, files: 1, fields: 8 } })
  registerAuth(app, { db, cookieSecure: deps.config.cookieSecure })
  registerHealthRoutes(app, { config: deps.config, pool: deps.pool, fetchImpl })
  registerAuthRoutes(app, { db, cookieSecure: deps.config.cookieSecure, limits: { limiter, rules: limits } })
  registerActivationRoutes(app, { db, cookieSecure: deps.config.cookieSecure, limiter, perIp: limits.activationPerIp })
  registerAdminRoutes(app, { db })
  registerPatientRoutes(app, { db, dataOrigin: deps.config.dataOrigin })
  registerHistoryRoutes(app, { db, dataOrigin: deps.config.dataOrigin })
  registerVisitRoutes(app, { db, encounterLookup: encounterIdsForVisits })
  registerAppointmentRoutes(app, { db, channel: deps.notificationChannel })
  registerEncounterRoutes(app, { db })
  registerInsertionRoutes(app, { db })
  registerFileRoutes(app, { db, config: deps.config })
  const routing = deps.routing ?? new RoutingRulesSource(undefined, (m) => app.log.error(`routing.yaml: ${m} (previous rules kept)`))
  const providers = deps.ai ?? providersFromConfig(deps.config, settings)
  const jobs = new JobService({ db, dataOrigin: deps.config.dataOrigin, aiSettings: { ai: settings.ai, uploads: settings.uploads, safety: settings.safety, mana: settings.mana } })
  const executors = new Map<string, JobExecutor>()
  // Local AI consultation intelligence (V3): drafts are made in the background by the one local model, which answers one request at a time.
  const reasoningConfig = { mode: providers.reasoning?.mode ?? 'none', model: providers.reasoner ?? null, reason: providers.reasoning?.reason ?? null, egress: providers.egress ?? { hosted: false, destination: null } }
  // One model on this computer answers one request at a time: the consultation drafts and Mana's answers wait for it in the same line.
  const modelGate = new Gate(1, settings.ai.reasoning.maxWaiting)
  const consult = new ConsultationService({
    db,
    jobs,
    reasoning: reasoningConfig,
    gate: modelGate,
    settings,
    editableEncounter: editableEncounterFor(db),
  })
  // Mana AI (V4): the doctor's assistant over the clinic's records; read-only, answers made in the background by the same local model.
  const manaAssistant = new ManaAssistantService({ db, jobs, reasoning: reasoningConfig, gate: modelGate, settings, config: deps.config, dataOrigin: deps.config.dataOrigin, ...(deps.manaCallTimeoutMs !== undefined && { callTimeoutMs: deps.manaCallTimeoutMs }) })
  // A step that was running when the system stopped will never finish: fail it (retryable) so its doctor is not left waiting on it.
  app.addHook('onReady', async () => {
    // Each sweep on its own: one that fails does not keep the others from running. Not worth stopping the server for: a sweep runs again at the next start.
    try {
      const n = await jobs.sweepInterrupted()
      if (n) app.log.warn({ jobs: n }, 'AI steps left running by a stop were marked failed (retryable)')
    } catch {
      // see above
    }
    try {
      const drafts = await consult.sweepInterrupted()
      if (drafts) app.log.warn({ drafts }, 'Consultation drafts left running by a stop were marked failed (retryable)')
    } catch {
      // see above
    }
    try {
      const answers = await manaAssistant.sweepInterrupted()
      if (answers) app.log.warn({ answers }, 'Mana answers left running by a stop were marked failed (retryable)')
    } catch {
      // see above
    }
  })
  // Closing the server stops any model call in progress.
  app.addHook('onClose', async () => {
    consult.abortAll()
    manaAssistant.abortAll()
  })
  const thermal = deps.thermal ?? httpThermalService(deps.config.thermalUrl, fetchImpl)
  registerAiRoutes(app, { db, config: deps.config, providers, settings, routing, jobs, executors, limiter })
  registerManaRoutes(app, { db, providers, settings, jobs, executors, dataOrigin: deps.config.dataOrigin })
  registerConsultationRoutes(app, { db, service: consult, limiter, settings })
  registerManaAssistantRoutes(app, { db, service: manaAssistant, limiter, settings })
  registerImageRoutes(app, { db, config: deps.config, settings, providers, thermal, jobs, executors })
  registerThermalRoutes(app, { db, config: deps.config, thermal })
  registerThermalSummaryRoutes(app, { db, config: deps.config, thermal, limiter })
  registerThermalDatasetRoutes(app, { db, config: deps.config, thermal })
  registerRoutingRoutes(app, { db, routing })
  registerOversightRoutes(app, { db, providers, jobs, hostedKeyConfigured: !!deps.config.ai.anthropicApiKey })
  registerPortalRoutes(app, { db })
  registerDeviceRoutes(app, { db, config: deps.config, settings, limiter, clock: deps.clock })
  registerConsultationContextRoutes(app, { db, config: deps.config, settings, limiter, clock: deps.clock, reasoningStatus: () => consult.status() })

  // API responses carry patient data: never store them in any cache (browser,
  // proxy or the web app's service worker), and set basic security headers.
  app.addHook('onSend', async (_req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
  })

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: 'not_found', message: `No route for ${req.method} ${req.url.split('?')[0]}` })
  })

  // Client errors carry a safe code/message; anything else is logged and
  // returned as a generic 500 (no stack traces, SQL or input echoed back).
  app.setErrorHandler(async (err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      // Every refusal leaves a trace: in-route 403s (wrong doctor, wrong role for
      // an action, CSRF) and lookups of patients or records outside the
      // caller's reach, unless the denial was already audited where it happened.
      // CSRF refusals happen before any session or rate limit: only the first per address per window is recorded.
      const csrfFlood = err.code === 'csrf_header_missing' && !limiter.hit(`csrf-denied:${req.ip}`, { max: 0, windowSeconds: 300 }).firstRefusal
      if (!req.denialAudited && !csrfFlood && (err.statusCode === 403 || err.auditDenial)) {
        req.denialAudited = true
        await audit(db, req, { action: err.statusCode === 403 ? 'access.denied' : 'access.not_found', outcome: 'denied', ...(err.auditDenial && { entityType: err.auditDenial.entityType, entityId: err.auditDenial.entityId }), details: { code: err.code, method: req.method, route: req.routeOptions.url ?? null, ...(err.auditDenial?.reason && { reason: err.auditDenial.reason }) } }).catch((e: unknown) => req.log.error({ err: e }, 'denial audit failed'))
      }
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, requestId: req.id, ...(err.issues && { issues: err.issues }) })
    }
    // The database's own lifecycle guards (migration 0019) are the backstop for the checks in the routes.
    const refusal = LIFECYCLE_REFUSALS[pgCode(err) ?? '']
    if (refusal) return reply.code(409).send({ error: refusal.code, message: refusal.message, requestId: req.id })
    // PostgreSQL gave up on one of two changes that were waiting for each other (deadlock, serialization): nothing was changed, trying again is safe.
    if (pgCode(err) === '40P01' || pgCode(err) === '40001') return reply.code(409).send({ error: 'try_again', message: 'The system was busy with another change. Nothing was saved. Try again.', requestId: req.id })
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'bad_request', message: err.statusCode === 413 ? 'Request too large' : 'Malformed request', requestId: req.id })
    }
    req.log.error({ err }, 'unhandled error')
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong', requestId: req.id })
  })

  return app
}
