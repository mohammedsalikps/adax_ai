import { VitalKind } from '@adaxai/contracts'
import { z } from 'zod'

const mime = z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'must be a MIME type')
const LimitRule = z.object({ max: z.number().int().min(1).max(100_000), windowSeconds: z.number().int().min(1).max(86_400) }).strict()

/** config/adaxai.yaml. Strict: unknown keys are errors (catches typos). */
export const AppSettings = z
  .object({
    version: z.literal(1),
    ai: z
      .object({
        features: z
          .object({ noteDraft: z.boolean(), extraction: z.boolean(), recommendations: z.boolean(), imageAnalysis: z.boolean(), liveTranscription: z.boolean(), patientQa: z.boolean(), consultationDraft: z.boolean() })
          .strict(),
        llm: z
          .object({
            provider: z.literal('anthropic'),
            model: z.string().min(1),
            effort: z.enum(['low', 'medium', 'high']),
            maxOutputTokens: z.number().int().min(1000).max(64000),
            timeoutSeconds: z.number().int().min(10).max(600),
          })
          .strict(),
        vision: z.object({ provider: z.literal('anthropic'), model: z.string().min(1), effort: z.enum(['low', 'medium', 'high']) }).strict(),
        // Speech-to-text is local only: "none" until the speech service is configured on purpose (SPEECH_PROVIDER=local). There is no hosted provider.
        stt: z
          .object({ provider: z.enum(['none', 'local']), url: z.url(), liveChunkSeconds: z.number().int().min(5).max(120), languageHint: z.string().regex(/^[a-z]{2,3}$/).nullable() })
          .strict(),
        // The language model that writes consultation drafts (V3) and answers (V4): a local open-weight model served by llama.cpp on this computer
        // (scripts/llm.mjs), `hosted` only behind the egress policy below, or `none`. Nothing falls back from one to another. Env LLM_PROVIDER and
        // LLM_URL override these; the per-install secret is LLM_API_KEY (or the file scripts/llm.mjs makes).
        reasoning: z
          .object({
            provider: z.enum(['none', 'local', 'hosted']),
            url: z.url(),
            /** Longest one answer may take. A draft takes minutes on a laptop CPU. */
            timeoutSeconds: z.number().int().min(30).max(3600),
            maxOutputTokens: z.number().int().min(500).max(8000),
            /** How much the model is sent (characters of the whole message, the sources and the words around them): nothing goes over it, this visit's items first. */
            maxContextChars: z.number().int().min(2000).max(60_000),
            /** How many requests may wait behind the one the model is answering; more are refused. */
            maxWaiting: z.number().int().min(0).max(20),
          })
          .strict(),
        // Whether consultation text may leave this computer for a hosted AI provider. False unless someone says otherwise on purpose: a provider key
        // in .env does not change it. (Audio never leaves: there is no hosted speech provider.)
        egress: z.object({ hostedProviders: z.boolean() }).strict(),
        // The "important points" extractor: fixed rules in this process (default), or the hosted language model when someone chooses it.
        extraction: z.object({ provider: z.enum(['rules', 'llm']) }).strict(),
        context: z.object({ priorEncounters: z.number().int().min(0).max(20), observationDays: z.number().int().min(1).max(365) }).strict(),
      })
      .strict(),
    uploads: z
      .object({
        audio: z.object({ maxMb: z.number().min(1).max(200), types: z.array(mime).min(1) }).strict(),
        images: z.object({ maxMb: z.number().min(1).max(100), types: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp'])).min(1), maxPixels: z.number().int().min(1_000_000).max(200_000_000), previewMaxSide: z.number().int().min(256).max(8192) }).strict(),
      })
      .strict(),
    // How current a device reading is said to be (V5): see contracts readingState. A display rule; the gate on what a device may send is not a setting.
    devices: z
      .object({ liveSeconds: z.number().int().min(2).max(3600), disconnectedSeconds: z.number().int().min(4).max(86_400), maxLateHours: z.number().int().min(1).max(720) })
      .strict()
      .refine((d) => d.disconnectedSeconds > d.liveSeconds, { message: 'disconnectedSeconds must be more than liveSeconds', path: ['disconnectedSeconds'] }),
    retention: z.object({ consultationAudioDays: z.number().int().min(0).max(3650) }).strict(),
    security: z
      .object({
        rateLimits: z
          .object({
            loginPerIp: LimitRule,
            loginPerAccount: LimitRule,
            activationPerIp: LimitRule,
            passwordChangePerUser: LimitRule,
            deviceIngestPerToken: LimitRule,
            deviceRecordingPerToken: LimitRule,
            aiAudioPerUser: LimitRule,
            aiStepPerUser: LimitRule,
          })
          .strict(),
      })
      .strict(),
    mana: z
      .object({
        maxEncounters: z.number().int().min(1).max(50),
        observationDays: z.number().int().min(1).max(3650),
        outdatedDays: z.number().int().min(1).max(3650),
        maxContextChars: z.number().int().min(2000).max(200_000),
      })
      .strict(),
    safety: z
      .object({
        allergyGroups: z.record(z.string().min(2), z.array(z.string().min(2)).min(1)),
        vitalTolerance: z.record(VitalKind, z.number().positive()),
      })
      .strict(),
  })
  .strict()
export type AppSettings = z.infer<typeof AppSettings>

const phrase = z.string().trim().min(2).max(80)

/** config/routing.yaml. */
export const RoutingRules = z
  .object({
    version: z.string().regex(/^[a-z0-9.-]{3,60}$/, 'lowercase letters, digits, dots and dashes'),
    departments: z
      .array(
        z
          .object({
            id: z.string().min(1),
            when: z.object({ ageBelow: z.number().int().min(1).max(130).optional(), ageAtLeast: z.number().int().min(0).max(130).optional(), complaintAny: z.array(phrase).min(1).optional() }).strict(),
            department: z.string().min(1).max(20),
            reason: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .refine((rules) => Object.keys(rules.at(-1)!.when).length === 0, 'the last department rule must have an empty `when` (the default)'),
    redFlags: z.array(z.object({ id: z.string().min(1), phrases: z.array(phrase).min(1), instruction: z.string().min(1).max(300) }).strict()),
    criticalVitalsInstruction: z.string().min(1).max(300),
    urgentWhenRedFlag: z.boolean(),
    requiredIntake: z.object({ reasonForVisit: z.boolean(), vitals: z.array(VitalKind), phone: z.boolean() }).strict(),
    clinician: z.enum(['least-busy', 'none']),
  })
  .strict()
export type RoutingRules = z.infer<typeof RoutingRules>
