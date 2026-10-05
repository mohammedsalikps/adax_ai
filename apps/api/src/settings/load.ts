import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { z } from 'zod'
import { type Config, REPO_ROOT } from '../config.ts'
import { AppSettings, RoutingRules } from './schema.ts'

export const CONFIG_DIR = path.join(REPO_ROOT, 'config')

function readYaml<T extends z.ZodType>(file: string, schema: T): z.infer<T> {
  let raw: unknown
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'), { prettyErrors: true })
  } catch (e) {
    throw new Error(`${path.basename(file)}: ${(e as Error).message}`)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid settings in ${path.basename(file)}:\n${issues}`)
  }
  return parsed.data
}

/** Loads config/adaxai.yaml (read once at start-up; changes need a restart). */
export function loadAppSettings(file = path.join(CONFIG_DIR, 'adaxai.yaml')): AppSettings {
  return readYaml(file, AppSettings)
}

/** Canonical SHA-256 of non-secret settings, stored with every AI job. */
export function settingsHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/**
 * Routing rules, re-read when the file changes. An invalid edit keeps the
 * last valid rules in use and reports the error (never silently half-applies).
 */
export class RoutingRulesSource {
  private rules: RoutingRules
  private mtimeMs: number
  lastError: string | null = null

  constructor(
    private readonly file = path.join(CONFIG_DIR, 'routing.yaml'),
    private readonly onError: (message: string) => void = () => {},
  ) {
    this.rules = readYaml(file, RoutingRules)
    this.mtimeMs = fs.statSync(file).mtimeMs
  }

  current(): RoutingRules {
    try {
      const m = fs.statSync(this.file).mtimeMs
      if (m !== this.mtimeMs) {
        this.mtimeMs = m
        this.rules = readYaml(this.file, RoutingRules)
        this.lastError = null
      }
    } catch (e) {
      this.lastError = (e as Error).message
      this.onError(this.lastError)
    }
    return this.rules
  }
}

/**
 * Settings with the environment overrides applied (AI_NOTE_MODEL,
 * SPEECH_PROVIDER, SPEECH_URL, AI_EGRESS_HOSTED, LLM_PROVIDER, LLM_URL, DEVICE_LIVE_SECONDS, DEVICE_DISCONNECTED_SECONDS). Contains no secrets.
 */
export function effectiveSettings(settings: AppSettings, config: Config): AppSettings {
  const devices = { ...settings.devices, liveSeconds: config.devices.liveSeconds ?? settings.devices.liveSeconds, disconnectedSeconds: config.devices.disconnectedSeconds ?? settings.devices.disconnectedSeconds }
  if (devices.disconnectedSeconds <= devices.liveSeconds) throw new Error('Invalid device settings: DEVICE_DISCONNECTED_SECONDS (devices.disconnectedSeconds) must be more than DEVICE_LIVE_SECONDS (devices.liveSeconds).')
  return {
    ...settings,
    devices,
    ai: {
      ...settings.ai,
      llm: { ...settings.ai.llm, model: config.ai.noteModel ?? settings.ai.llm.model },
      egress: { hostedProviders: config.ai.egressHosted ?? settings.ai.egress.hostedProviders },
      reasoning: {
        ...settings.ai.reasoning,
        provider: config.ai.llm.provider ?? settings.ai.reasoning.provider,
        url: (config.ai.llm.url ?? settings.ai.reasoning.url).replace(/\/+$/, ''),
      },
      stt: {
        ...settings.ai.stt,
        url: (config.ai.speech.url ?? settings.ai.stt.url).replace(/\/+$/, ''),
        provider: config.ai.speech.provider ?? settings.ai.stt.provider,
      },
    },
  }
}
