import { z } from 'zod'

// ---------------------------------------------------------------------------
// The doctor's handwritten notes (Doctor HERO final): a writing pad for a digital pen, stylus, touch or mouse in the consultation. What is
// kept is the strokes, in a compact JSON document stored as a file (`files.kind` handwriting_strokes) for each saved version; every version is
// kept and the latest is what the pad shows. Nothing reads or recognises the writing: it is never turned into text or a clinical fact, and the
// consultation draft says it was not read. A version can be saved only while the consultation is an unsigned draft (migration 0033).
// ---------------------------------------------------------------------------

/** Limits (the API refuses more; the database checks the counts too). */
export const HANDWRITING_LIMITS = {
  /** Pages in one document. */
  maxPages: 50,
  /** Strokes across all pages. */
  maxStrokes: 20_000,
  /** Points in one stroke. */
  maxPointsPerStroke: 5_000,
  /** Size of the strokes file. */
  maxFileBytes: 4 * 1024 * 1024,
} as const

/** The page's coordinate system: x from 0 to `width`, y from 0 to `height` (A4 portrait proportions), whatever the screen size. */
export const HANDWRITING_PAGE = { width: 1000, height: 1414 } as const
export const HANDWRITING_FORMAT_VERSION = 1
/** The `files.kind` of a strokes document. */
export const HANDWRITING_FILE_KIND = 'handwriting_strokes'
export const HANDWRITING_MIME = 'application/json'

/**
 * One stroke, compact: `points` is a flat list of triples [x, y, pressure, x, y, pressure, ...] in page units (x 0 to 1000, y 0 to 1414,
 * rounded to one decimal) with pressure from 0 to 1 (0.5 when the device reports none). `input` is the pointer type the browser reported.
 */
export const HandwritingStroke = z.object({
  page: z.number().int().min(0).max(HANDWRITING_LIMITS.maxPages - 1),
  /** Line width in page units. */
  width: z.number().min(0.5).max(40),
  /** A colour from the pad's palette, as #rrggbb. */
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  input: z.enum(['pen', 'touch', 'mouse']).optional(),
  points: z
    .array(z.number().finite().min(0).max(HANDWRITING_PAGE.height))
    .min(3)
    .max(HANDWRITING_LIMITS.maxPointsPerStroke * 3)
    .refine((p) => p.length % 3 === 0, 'Points come in triples: x, y, pressure')
    .refine((p) => p.every((v, i) => (i % 3 === 0 ? v <= HANDWRITING_PAGE.width : i % 3 === 2 ? v <= 1 : true)), 'A point is outside the page, or its pressure is above 1'),
})
export type HandwritingStroke = z.infer<typeof HandwritingStroke>

/** The strokes file of one saved version. */
export const HandwritingDocument = z
  .object({
    format: z.literal(HANDWRITING_FORMAT_VERSION),
    page: z.object({ width: z.literal(HANDWRITING_PAGE.width), height: z.literal(HANDWRITING_PAGE.height) }),
    pageCount: z.number().int().min(1).max(HANDWRITING_LIMITS.maxPages),
    strokes: z.array(HandwritingStroke).max(HANDWRITING_LIMITS.maxStrokes),
  })
  .superRefine((d, ctx) => {
    if (d.strokes.some((s) => s.page >= d.pageCount)) ctx.addIssue({ code: 'custom', path: ['strokes'], message: 'A stroke is on a page the document does not have' })
  })
export type HandwritingDocument = z.infer<typeof HandwritingDocument>

export const EMPTY_HANDWRITING: HandwritingDocument = { format: HANDWRITING_FORMAT_VERSION, page: { ...HANDWRITING_PAGE }, pageCount: 1, strokes: [] }

/**
 * POST /api/encounters/:id/handwriting: multipart with ONE file (the HandwritingDocument as JSON) and these fields (strings in multipart).
 * `expectedVersion` is the version the pad started from (0 when nothing was saved yet): a different latest version is a 409 conflict, and so is a
 * consultation that was signed meanwhile. The counts must match the file.
 */
/** The error code of a save whose `expectedVersion` is no longer the latest (409): reload the latest version, keep the local strokes, save again. */
export const HANDWRITING_VERSION_CONFLICT = 'handwriting_version_conflict'

export const HandwritingSaveFields = z.object({
  expectedVersion: z.coerce.number().int().min(0),
  strokeCount: z.coerce.number().int().min(0).max(HANDWRITING_LIMITS.maxStrokes),
  pageCount: z.coerce.number().int().min(1).max(HANDWRITING_LIMITS.maxPages),
})
export type HandwritingSaveFields = z.input<typeof HandwritingSaveFields>

/** The answer to a save: the version now stored. */
export const HandwritingSaved = z.object({
  encounterId: z.uuid(),
  version: z.number().int().min(1),
  strokeCount: z.number().int(),
  pageCount: z.number().int(),
  savedAt: z.string(),
  /** The new version's strokes file and who saved it (the pad keeps its copy of the latest version current with them). */
  strokesFileId: z.uuid().optional(),
  savedByName: z.string().optional(),
})
export type HandwritingSaved = z.infer<typeof HandwritingSaved>

/** GET /api/encounters/:id/handwriting: the latest version (version 0 and no document when nothing was written yet). */
export const HandwritingLatest = z.object({
  encounterId: z.uuid(),
  version: z.number().int().min(0),
  strokeCount: z.number().int().min(0),
  pageCount: z.number().int().min(0),
  /** The strokes file (also readable through GET /api/files/:id); null before the first save. */
  strokesFileId: z.uuid().nullable(),
  document: HandwritingDocument.nullable(),
  savedAt: z.string().nullable(),
  savedByName: z.string().nullable(),
  /** The pad is read-only: the consultation is signed or discarded, or it is not the caller's own draft. */
  readOnly: z.boolean(),
})
export type HandwritingLatest = z.infer<typeof HandwritingLatest>
