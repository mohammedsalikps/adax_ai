/**
 * The pure parts of the Doctor HERO primitives (DESIGN §1-2): what each status and each source is called and in which tone it is drawn, and
 * how a missing number or value is said. No React and no DOM, so they are unit-tested in node (test/hero-primitives.test.ts) and shared by
 * every unit: one vocabulary for Home, My consultations, the consultation and the prescription page.
 */

/** Every status a StatusPill can show (the queue's vocabulary from contracts' doctorQueueStatus, plus the consultation record's own states). */
export const HERO_STATUSES = ['completed', 'waiting', 'in_consultation', 'yet_to_see', 'signed_to_complete', 'draft', 'cancelled'] as const
export type HeroStatus = (typeof HERO_STATUSES)[number]

/** The design's status tones (§1): ok, pending, notice, brand, or neutral (ink-muted on canvas). */
export type HeroTone = 'ok' | 'pending' | 'notice' | 'brand' | 'neutral'

export interface StatusPillSpec {
  /** The word shown beside the dot (sentence case). Colour is never the only cue. */
  label: string
  tone: HeroTone
}

const STATUS_PILLS: Record<HeroStatus, StatusPillSpec> = {
  completed: { label: 'Completed', tone: 'ok' },
  waiting: { label: 'Waiting', tone: 'pending' },
  in_consultation: { label: 'In consultation', tone: 'notice' },
  yet_to_see: { label: 'Yet to see', tone: 'neutral' },
  signed_to_complete: { label: 'Signed — to complete', tone: 'brand' },
  draft: { label: 'Draft', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

/** The label and tone of a status. An unknown value (a newer server) is shown neutral with its own words, never as another status. */
export function statusPillSpec(status: HeroStatus | (string & {})): StatusPillSpec {
  if (Object.hasOwn(STATUS_PILLS, status)) return STATUS_PILLS[status as HeroStatus]
  const words = status.replace(/_/g, ' ').trim()
  return { label: words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unknown', tone: 'neutral' }
}

/** Where a value came from (§1 Source tags). */
export const SOURCE_KINDS = ['staff', 'device', 'simulated', 'ai', 'rules', 'record'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface SourceTagSpec {
  /** The default words (the existing exact marks where they exist: SIMULATED, UNVERIFIED, AI DRAFT). */
  label: string
  /** How it is drawn: neutral; a solid pending outline (an unverified device); dashed (simulated); the AI's violet. */
  look: 'neutral' | 'outline-pending' | 'dashed' | 'ai'
}

const SOURCE_TAGS: Record<SourceKind, SourceTagSpec> = {
  staff: { label: 'Staff', look: 'neutral' },
  device: { label: 'Device · UNVERIFIED', look: 'outline-pending' },
  simulated: { label: 'SIMULATED', look: 'dashed' },
  ai: { label: 'AI DRAFT', look: 'ai' },
  rules: { label: 'Fixed rules', look: 'neutral' },
  record: { label: 'From the record', look: 'neutral' },
}

export function sourceTagSpec(kind: SourceKind): SourceTagSpec {
  return SOURCE_TAGS[kind]
}

/** What a stat tile shows, and what a screen reader hears, for a count. Null means not available (not loaded or not counted): never 0. */
export function statValue(value: number | null | undefined): { text: string; spoken: string; missing: boolean } {
  if (value === null || value === undefined || !Number.isFinite(value)) return { text: '—', spoken: 'not available', missing: true }
  const text = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value)
  return { text, spoken: text, missing: false }
}

/** Whether a key/value row has nothing to show: null, undefined, NaN, or text that is only spaces. 0 and false are values. */
export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return Number.isNaN(value)
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}
