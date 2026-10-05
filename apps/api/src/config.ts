import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import pkg from '../package.json' with { type: 'json' }

export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(API_ROOT, '..', '..')

/** The contents of a small secret file (trimmed), or undefined when it is not there. The value is never logged. */
function readSecretFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** Loads the repo-root `.env` into process.env without overriding values already set. */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')): void {
  if (fs.existsSync(file)) process.loadEnvFile(file)
}

const port = z.coerce.number().int().min(1).max(65535)
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, 'must be a lowercase SQL identifier')

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port.default(4000),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: port.default(5433),
  DB_NAME: identifier.default('adaxai'),
  DB_TEST_NAME: identifier.default('adaxai_test'),
  DB_E2E_NAME: identifier.default('adaxai_e2e'),
  DB_APP_USER: identifier.default('adaxai_app'),
  DB_APP_PASSWORD: z.string().min(1, 'is required (run `npm run setup`)'),
  DB_ADMIN_USER: identifier.default('adaxai_admin'),
  DB_ADMIN_PASSWORD: z.string().optional(),
  THERMAL_URL: z.url().default('http://127.0.0.1:8001'),
  /** Origin recorded on thermal images, clinical images and AI jobs. Only a real clinical deployment sets `clinical`. */
  DATA_ORIGIN: z.enum(['clinical', 'synthetic']).default('synthetic'),
  /** Defaults to true in production; local HTTP development needs false. */
  COOKIE_SECURE: z.enum(['true', 'false', '']).optional(),
  STORAGE_DIR: z.string().min(1).default('storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(25),
  /** AI note drafting (Claude). Unset = the feature reports itself unavailable. */
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  /** Optional override of config/adaxai.yaml (ai.llm.model). */
  AI_NOTE_MODEL: z.string().optional().transform((v) => v || undefined),
  /**
   * Speech-to-text runs on this machine only. "none" (the default) or "local" (the speech service in services/speech). There is no
   * hosted option and nothing falls back to one: an old AI_STT_API_KEY is ignored.
   */
  SPEECH_PROVIDER: z.union([z.enum(['none', 'local']), z.literal('')]).optional().transform((v) => v || undefined),
  /** Where the local speech service listens (default http://127.0.0.1:8002). Loopback only unless SPEECH_ALLOW_NON_LOOPBACK is "true". */
  SPEECH_URL: z.union([z.url(), z.literal('')]).optional().transform((v) => v || undefined),
  SPEECH_ALLOW_NON_LOOPBACK: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  /**
   * Hosted AI egress: whether consultation text may be sent to a hosted AI provider at all. A provider key alone never enables it. Unset: the
   * setting in config/adaxai.yaml (ai.egress.hostedProviders, false) decides. "true" allows it on purpose; "false" forbids it whatever the file says.
   */
  AI_EGRESS_HOSTED: z.union([z.enum(['true', 'false']), z.literal('')]).optional().transform((v) => (v ? v === 'true' : undefined)),
  /**
   * The reasoning model (V3, V4): "local" (llama.cpp on this machine, scripts/llm.mjs), "none", or "hosted" (the hosted provider, only if egress is
   * allowed and a key is set). Unset: config/adaxai.yaml (ai.reasoning.provider) decides. Nothing falls back from one to another.
   */
  LLM_PROVIDER: z.union([z.enum(['none', 'local', 'hosted']), z.literal('')]).optional().transform((v) => v || undefined),
  /** Where the local model server listens (default http://127.0.0.1:8081). Loopback only unless LLM_ALLOW_NON_LOOPBACK is "true". */
  LLM_URL: z.union([z.url(), z.literal('')]).optional().transform((v) => v || undefined),
  LLM_ALLOW_NON_LOOPBACK: z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1'),
  /** The per-install secret the local model server was started with. Never sent to a browser, never logged. */
  LLM_API_KEY: z.string().optional().transform((v) => v || undefined),
  /** A file holding that secret (scripts/llm.mjs makes .data/llm/api-key). Used when LLM_API_KEY is not set. */
  LLM_API_KEY_FILE: z.string().optional().transform((v) => v || undefined),
  /** Optional overrides of config/adaxai.yaml (devices.liveSeconds, devices.disconnectedSeconds): how current a device reading is said to be. */
  DEVICE_LIVE_SECONDS: z.union([z.coerce.number().int().min(2).max(3600), z.literal('')]).optional().transform((v) => (v === '' ? undefined : v)),
  DEVICE_DISCONNECTED_SECONDS: z.union([z.coerce.number().int().min(4).max(86_400), z.literal('')]).optional().transform((v) => (v === '' ? undefined : v)),
})

export interface DbConfig {
  host: string
  port: number
  name: string
  testName: string
  e2eName: string
  appUser: string
  appPassword: string
  adminUser: string
  adminPassword: string | undefined
}

export interface Config {
  env: 'development' | 'test' | 'production'
  version: string
  api: { host: string; port: number }
  db: DbConfig
  thermalUrl: string
  dataOrigin: 'clinical' | 'synthetic'
  cookieSecure: boolean
  /** Absolute path for uploaded files (git-ignored). */
  storageDir: string
  maxUploadBytes: number
  /** Env overrides of `devices` in config/adaxai.yaml; undefined means "use the file". */
  devices: { liveSeconds: number | undefined; disconnectedSeconds: number | undefined }
  ai: {
    anthropicApiKey: string | undefined
    /** Env overrides; undefined means "use config/adaxai.yaml". */
    noteModel: string | undefined
    /** Env overrides of ai.stt in config/adaxai.yaml; undefined means "use the file". */
    speech: { provider: 'none' | 'local' | undefined; url: string | undefined; allowNonLoopback: boolean }
    /** The environment's say on hosted egress (undefined: the settings file decides). */
    egressHosted: boolean | undefined
    /** An AI_STT_API_KEY is set in the environment. It is never used; the server says so at start-up. */
    hostedSttKeyIgnored: boolean
    /** Env overrides of ai.reasoning in config/adaxai.yaml (undefined: use the file) and the secret for the local model server. */
    llm: { provider: 'none' | 'local' | 'hosted' | undefined; url: string | undefined; allowNonLoopback: boolean; apiKey: string | undefined }
  }
}

/** Validates the environment. Error messages name variables, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const e = parsed.data
  // The default is `synthetic` (this product is a prototype), so a production deployment must say what its data is: an unset
  // variable would otherwise label real records as synthetic.
  if (e.NODE_ENV === 'production' && !env.DATA_ORIGIN) throw new Error('Invalid environment configuration:\n  DATA_ORIGIN: must be set explicitly in production ("synthetic" or "clinical")')
  return {
    env: e.NODE_ENV,
    version: pkg.version,
    api: { host: e.API_HOST, port: e.API_PORT },
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      name: e.DB_NAME,
      testName: e.DB_TEST_NAME,
      e2eName: e.DB_E2E_NAME,
      appUser: e.DB_APP_USER,
      appPassword: e.DB_APP_PASSWORD,
      adminUser: e.DB_ADMIN_USER,
      adminPassword: e.DB_ADMIN_PASSWORD || undefined,
    },
    thermalUrl: e.THERMAL_URL.replace(/\/+$/, ''),
    dataOrigin: e.DATA_ORIGIN,
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production',
    storageDir: path.resolve(REPO_ROOT, e.STORAGE_DIR),
    maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
    devices: { liveSeconds: e.DEVICE_LIVE_SECONDS, disconnectedSeconds: e.DEVICE_DISCONNECTED_SECONDS },
    ai: {
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      noteModel: e.AI_NOTE_MODEL,
      speech: { provider: e.SPEECH_PROVIDER, url: e.SPEECH_URL?.replace(/\/+$/, ''), allowNonLoopback: e.SPEECH_ALLOW_NON_LOOPBACK },
      egressHosted: e.AI_EGRESS_HOSTED,
      hostedSttKeyIgnored: !!env.AI_STT_API_KEY,
      llm: { provider: e.LLM_PROVIDER, url: e.LLM_URL?.replace(/\/+$/, ''), allowNonLoopback: e.LLM_ALLOW_NON_LOOPBACK, apiKey: e.LLM_API_KEY ?? readSecretFile(e.LLM_API_KEY_FILE ?? path.join(REPO_ROOT, '.data', 'llm', 'api-key')) },
    },
  }
}
