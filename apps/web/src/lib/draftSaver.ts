import type { DiagnosisInput, Encounter, InsertionSubject, NoteFields, NoteInsertion, PrescriptionItemInput } from '@adaxai/contracts'
import type { NoteSaveState } from './analysis.ts'
import { ApiError, errorMessage } from './api.ts'

/*
 * The doctor's working draft of a consultation (note, diagnoses, prescription) and how it reaches the server: the pure core of
 * lib/encounterDraft.ts (useEncounterDraft), with no React and no DOM, so it is unit-tested in node (test/encounterDraft.test.ts). Extracted
 * without a change of behaviour from the consultation editor (pages/doctor/ConsultationPage.tsx), so the consultation and the prescription page
 * (pages/doctor/PrescriptionPage.tsx) save the same draft the same way:
 * - every save replaces the whole draft (PUT /draft) with the version it was read at; saves run one after another on one chain;
 * - a version conflict stops saving (another window changed it), a refusal retrying cannot fix blocks it (signed, discarded, the visit left the
 *   doctor, access ended) with the server's reason, any other failure is retried;
 * - an insertion of reviewed AI text (POST /insertions) runs on the same chain after what is pending, so a save and an insertion never use the
 *   same version;
 * - the last edits are never sent for another person who has signed in on this browser since.
 */

export interface Draft {
  note: NoteFields
  diagnoses: DiagnosisInput[]
  prescription: PrescriptionItemInput[]
}

export type SaveState = NoteSaveState

/** The autosave waits this long after the last change, and this long before retrying a failed save. */
export const AUTOSAVE_MS = 1200
export const RETRY_MS = 5000

/** The most medicines one prescription holds (SaveDraftRequest's limit). */
export const MAX_PRESCRIPTION_ITEMS = 30

/** Refusals that retrying cannot fix: the draft was signed or discarded elsewhere, the visit left the doctor, or access ended. */
export const isTerminalSaveError = (err: unknown): boolean =>
  err instanceof ApiError && (['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(err.code) || err.status === 403 || err.status === 404)

/** What a failed save leaves the draft in: changed elsewhere (conflict), refused for good (blocked), or to be retried (error). */
export function failedSaveState(err: unknown): 'conflict' | 'blocked' | 'error' {
  if (err instanceof ApiError && err.code === 'version_conflict') return 'conflict'
  if (isTerminalSaveError(err)) return 'blocked'
  return 'error'
}

/** When the autosave runs next: soon after a change, later after a failure, never otherwise. */
export function autosaveDelay(state: SaveState): number | null {
  return state === 'dirty' ? AUTOSAVE_MS : state === 'error' ? RETRY_MS : null
}

/** Nothing more can be saved from this screen: changed in another window, or refused for good. */
export const isLocked = (state: SaveState): boolean => state === 'conflict' || state === 'blocked'

/** The draft of an encounter as the server holds it (the structured course of each medicine included: it is saved with every autosave). */
export const draftOf = (e: Pick<Encounter, 'note' | 'diagnoses' | 'prescription'>): Draft => ({ note: e.note, diagnoses: e.diagnoses, prescription: e.prescription })

/**
 * The draft with one more medicine (an approved Mana action, DESIGN §5.8, or the doctor's own row). Throws, with words for the doctor, when the
 * prescription is full: the caller says it was approved but not added.
 */
export function appendPrescriptionItem(d: Draft, item: PrescriptionItemInput): Draft {
  if (d.prescription.length >= MAX_PRESCRIPTION_ITEMS) throw new Error(`A prescription holds at most ${MAX_PRESCRIPTION_ITEMS} medicines. Remove one first.`)
  return { ...d, prescription: [...d.prescription, item] }
}

/** What the screen shows of the draft; a new object whenever any of it changes. */
export interface DraftSnapshot {
  draft: Draft
  state: SaveState
  savedAt: Date | null
  /** The AI-produced text in the note, with its sources (as the server last said). */
  insertions: NoteInsertion[]
  /** Why saving stopped for good (the server's words), when it did. */
  blocked: string | null
  /** An insertion of reviewed AI text is running: the note's fields are read-only meanwhile, so no keystroke is lost. */
  inserting: boolean
  /** The prescription as the server last stored it (what the fixed rules' allergy name check reads), not the edits still to send. */
  savedPrescription: PrescriptionItemInput[]
}

export interface InsertionBody {
  version: number
  section: keyof NoteFields
  text: string
  subjectType: InsertionSubject
  subjectId: string
}

/** How the saver reaches the server and the page (injected, so tests need no network). */
export interface DraftSaverIo {
  saveDraft: (body: { version: number } & Draft) => Promise<Encounter>
  insert: (body: InsertionBody) => Promise<Encounter>
  /** False once another person has signed in on this browser: their edits are not theirs to send. */
  samePerson: () => boolean
  /** After the server stored the draft or an insertion (the page refreshes what depends on the note). */
  onSaved?: (kind: 'draft' | 'insertion', e: Encounter) => void
}

/** The working draft and its save chain (see the top of this file). One per open editor of one encounter. */
export class DraftSaver {
  private snap: DraftSnapshot
  private readonly listeners = new Set<() => void>()
  private dirty = false
  private chain: Promise<void> = Promise.resolve()
  /** The insertions under way (each ends, stored or refused, before `idle` resolves), and how many have not finished their last step. */
  private readonly inserts = new Set<Promise<void>>()
  private pendingInserts = 0
  /** The version the next save is sent with (the server's, from the last answer). */
  version: number

  constructor(
    initial: Pick<Encounter, 'note' | 'diagnoses' | 'prescription' | 'version' | 'aiInsertions'>,
    private readonly io: DraftSaverIo,
  ) {
    this.version = initial.version
    this.snap = { draft: draftOf(initial), state: 'saved', savedAt: null, insertions: initial.aiInsertions, blocked: null, inserting: false, savedPrescription: initial.prescription }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): DraftSnapshot => this.snap

  get state(): SaveState {
    return this.snap.state
  }

  /** Edits not yet sent (a save in flight has taken the earlier ones). */
  get isDirty(): boolean {
    return this.dirty
  }

  /** Something is not stored yet: edits to send, a save in flight, or an insertion under way. */
  get busy(): boolean {
    return this.dirty || this.snap.state === 'saving' || this.inserts.size > 0
  }

  private set(patch: Partial<DraftSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    for (const l of this.listeners) l()
  }

  /** A refusal retrying cannot fix: stop saving and say why. */
  private block(err: unknown) {
    this.set({ blocked: errorMessage(err), state: 'blocked' })
  }

  /** After a failed save: conflict, blocked, or the edits kept to be sent again. */
  private failed(err: unknown) {
    const s = failedSaveState(err)
    if (s === 'blocked') return this.block(err)
    if (s === 'error') this.dirty = true
    this.set({ state: s })
  }

  /** Changes the draft (the autosave sends it). Refused, and false, once nothing more can be saved. */
  update(fn: (d: Draft) => Draft): boolean {
    if (isLocked(this.snap.state)) return false
    const next = fn(this.snap.draft)
    this.dirty = true
    this.set({ draft: next, state: 'dirty' })
    return true
  }

  /** Nothing more to send (the draft was discarded from this page). */
  markClean(): void {
    this.dirty = false
  }

  /** Saves serially; resolves once nothing is pending (never rejects: the state says how it went). */
  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!this.dirty || isLocked(this.snap.state)) return
      // Another person has taken over this browser (this page is being closed for them): the last edits are not theirs to send.
      if (!this.io.samePerson()) {
        this.dirty = false
        return
      }
      this.dirty = false
      this.set({ state: 'saving' })
      try {
        const e = await this.io.saveDraft({ version: this.version, ...this.snap.draft })
        this.version = e.version
        this.set({ insertions: e.aiInsertions, savedAt: new Date(), state: this.dirty ? 'dirty' : 'saved', savedPrescription: e.prescription })
        this.io.onSaved?.('draft', e)
      } catch (err) {
        this.failed(err)
      }
    })
    return this.chain
  }

  /** Saves what is pending, then says how the draft stands (what Analyze, Preview and Sign need before they go on). */
  async flushState(): Promise<SaveState> {
    await this.flush()
    return this.snap.state
  }

  /**
   * Resolves once nothing more is under way: what is pending saved (or failed), and every insertion ended, with the edits made during one
   * saved after it. What leaving the editor waits for, so the next editor of the consultation opens on what was stored. Never rejects.
   */
  async idle(): Promise<void> {
    for (;;) {
      await this.flush()
      if (this.inserts.size === 0) return
      await Promise.allSettled(Array.from(this.inserts))
    }
  }

  /**
   * Saves pending edits, then asks the server to insert the reviewed AI text (the server records which AI artifact it came from). The note
   * is read-only while this runs so no keystroke is lost. Rejects with the reason when it could not be inserted.
   */
  insert(section: keyof NoteFields, text: string, subject: { type: InsertionSubject; id: string }): Promise<void> {
    const work = this.runInsert(section, text, subject)
    this.inserts.add(work)
    const done = () => {
      this.inserts.delete(work)
    }
    work.then(done, done)
    return work
  }

  private async runInsert(section: keyof NoteFields, text: string, subject: { type: InsertionSubject; id: string }): Promise<void> {
    this.pendingInserts += 1
    this.set({ inserting: true })
    try {
      await this.flush()
      // Runs on the same serial chain as autosave, so a save and an insertion never use the same version.
      const run = this.chain.then(async () => {
        if (this.snap.state === 'conflict') throw new ApiError(409, 'version_conflict', 'This consultation was changed in another window. Reload to continue.')
        if (this.snap.state === 'blocked') throw new ApiError(409, 'not_saved', this.snap.blocked ?? 'Changes to this consultation cannot be saved. Reload it.')
        if (this.dirty || this.snap.state === 'error') {
          // Diagnoses or prescription changed meanwhile: save them first (note fields are read-only now).
          this.dirty = false
          this.set({ state: 'saving' })
          try {
            const saved = await this.io.saveDraft({ version: this.version, ...this.snap.draft })
            this.version = saved.version
            this.set({ savedPrescription: saved.prescription })
          } catch (err) {
            this.failed(err)
            throw err
          }
        }
        this.set({ state: 'saving' })
        try {
          const e = await this.io.insert({ version: this.version, section, text, subjectType: subject.type, subjectId: subject.id })
          this.version = e.version
          this.set({ draft: { ...this.snap.draft, note: e.note }, insertions: e.aiInsertions, savedAt: new Date(), state: this.dirty ? 'dirty' : 'saved', savedPrescription: e.prescription })
          this.io.onSaved?.('insertion', e)
        } catch (err) {
          const s = failedSaveState(err)
          if (s === 'conflict') this.set({ state: 'conflict' })
          else if (s === 'blocked') this.block(err)
          else this.set({ state: this.dirty ? 'dirty' : 'saved' })
          throw err
        }
      })
      this.chain = run.catch(() => undefined)
      await run
    } finally {
      this.pendingInserts -= 1
      if (this.pendingInserts === 0) this.set({ inserting: false })
    }
  }

  /** Whether text from this AI artifact is already in the note. */
  inserted(type: InsertionSubject, id: string): boolean {
    return this.snap.insertions.some((i) => i.subjectType === type && i.subjectId === id)
  }
}

// ---------------------------------------------------------------------------
// The last save of an editor that went away, so the next editor of the same consultation opens on the version it stored.
// ---------------------------------------------------------------------------

const exits = new Map<string, Promise<void>>()
const exitListeners = new Set<() => void>()
const notifyExits = () => {
  for (const l of exitListeners) l()
}

/** Records the last save of an editor that went away (the doctor went from the consultation to its prescription, or back). */
export function trackDraftExit(encounterId: string, work: Promise<unknown>): Promise<void> {
  const before = exits.get(encounterId)
  const done: Promise<void> = Promise.all([before, work])
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (exits.get(encounterId) === done) {
        exits.delete(encounterId)
        notifyExits()
      }
    })
  exits.set(encounterId, done)
  notifyExits()
  return done
}

/** Whether an editor of this consultation that went away is still saving. */
export const draftExitPending = (encounterId: string | undefined): boolean => !!encounterId && exits.has(encounterId)

export function subscribeDraftExits(listener: () => void): () => void {
  exitListeners.add(listener)
  return () => {
    exitListeners.delete(listener)
  }
}
