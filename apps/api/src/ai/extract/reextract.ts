/**
 * Finding the important points again on a transcript that has grown (a live recording: the fixed rules run after each transcribed part).
 *
 * A point the doctor has not decided yet (pending, or set aside) that the new run finds again EXACTLY as it was is kept as it is: the same row,
 * the same id, the same status. A doctor who is reading or confirming it while the conversation goes on is never told that it "was replaced by
 * a newer run". Anything that differs in what the doctor sees or in what produced it (the text, the category, who said it, certainty, negation,
 * details, flags, the sources and their wording, the extractor and its version) is replaced: the old row is superseded, never deleted, and the
 * new one is added. A point whose source line was given a speaker after it was found is replaced as well, so that its "speaker changed" mark
 * goes away with a point found after the change. Decided points (confirmed, edited, rejected) are not touched here: the caller leaves them out of
 * what it adds (a confirmed point is not proposed twice, a rejected one does not come back). Nothing is ever confirmed by this step.
 *
 * Pure (no database): the extraction step reads the rows, asks this what to do, and writes. Tested in test/capture-reextract.test.ts.
 */

/** One source of a point, as it is stored (ai_evidence) and shown. */
export interface PointSource {
  relation: string
  sourceType: string
  sourceId: string | null
  sourceRef: string
  provenance: string
  excerpt: string
  note: string | null
}

/** Everything about a point that the doctor sees or that says what produced it. Two points with the same content are the same point. */
export interface PointContent {
  category: string
  text: string
  attribution: string
  certainty: string
  uncertaintyReason: string | null
  negated: boolean
  attributes: Record<string, unknown>
  flags: readonly string[]
  evidence: readonly PointSource[]
  producedBy: { provider: string; model: string; promptVersion: string | null }
}

/** Longest stored text of a point and of one of its sources (as the extraction step stores them). */
export const POINT_TEXT_MAX = 2000
export const SOURCE_EXCERPT_MAX = 2000

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonical(o[k])]),
    )
  }
  return v
}

/**
 * A point's content as one comparable string. The stored form is compared (text trimmed and cut as stored, details without empty fields, keys in
 * a fixed order, flags and sources as sets), so a point read back from the database and the same point found again compare equal.
 */
export function pointSignature(p: PointContent): string {
  const attributes = Object.fromEntries(Object.entries(p.attributes).filter(([, v]) => v !== null && v !== undefined))
  const sources = p.evidence.map((e) => JSON.stringify([e.relation, e.sourceType, e.sourceId ?? null, e.sourceRef, e.provenance, e.excerpt.slice(0, SOURCE_EXCERPT_MAX), e.note ?? null])).sort()
  return JSON.stringify([
    p.producedBy.provider,
    p.producedBy.model,
    p.producedBy.promptVersion ?? null,
    p.category,
    p.text.trim().slice(0, POINT_TEXT_MAX),
    p.attribution,
    p.certainty,
    p.uncertaintyReason ?? null,
    p.negated,
    canonical(attributes),
    [...new Set(p.flags)].sort(),
    sources,
  ])
}

/** The transcript lines a point rests on (its supporting transcript sources). */
export const sourceLines = (evidence: readonly PointSource[]): string[] => [...new Set(evidence.filter((e) => e.relation === 'supports' && e.sourceType === 'transcript_segment').map((e) => e.sourceRef))]

/** An undecided point already stored for this transcript. */
export interface StoredPoint {
  id: string
  createdAt: Date
  content: PointContent
}

/** A speaker the doctor assigned to a line of this transcript (every assignment, not only the latest). */
export interface SpeakerAssignment {
  label: string
  at: Date
}

/** True when a source line of the point was given a speaker after the point was found (what the screen calls "speaker changed"). */
export const relabelledSince = (p: StoredPoint, assignments: readonly SpeakerAssignment[]): boolean => {
  const lines = sourceLines(p.content.evidence)
  return assignments.some((a) => lines.includes(a.label) && a.at.getTime() > p.createdAt.getTime())
}

export interface ReextractionPlan<T> {
  /** Undecided points found again unchanged: left exactly as they are. */
  keep: string[]
  /** Points of the new run that are not already stored undecided: to add. */
  add: T[]
  /** Undecided points the new run did not find again unchanged: to supersede. */
  replace: string[]
}

/**
 * What to do with the undecided points of a transcript after a new run. `found` is what the run proposes, already without the points the doctor
 * decided. Each stored point can stand for one found point only (two identical findings keep one row and add one).
 */
export function planReextraction<T>(stored: readonly StoredPoint[], found: readonly { item: T; content: PointContent }[], assignments: readonly SpeakerAssignment[]): ReextractionPlan<T> {
  const pool = new Map<string, string[]>()
  for (const p of stored) {
    if (relabelledSince(p, assignments)) continue
    const s = pointSignature(p.content)
    pool.set(s, [...(pool.get(s) ?? []), p.id])
  }
  const keep: string[] = []
  const add: T[] = []
  for (const f of found) {
    const ids = pool.get(pointSignature(f.content))
    const id = ids?.shift()
    if (id) keep.push(id)
    else add.push(f.item)
  }
  const kept = new Set(keep)
  return { keep, add, replace: stored.filter((p) => !kept.has(p.id)).map((p) => p.id) }
}
