import type { Encounter, PrescriptionItemInput } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, api } from './api.ts'
import { useStillSamePerson } from './auth.tsx'
import { consultKey } from './consult.ts'
import { contextKey } from './consultationContext.ts'
import { registerDraftBridge } from './draftBridge.ts'
import { appendPrescriptionItem, autosaveDelay, type Draft, DraftSaver, draftExitPending, isLocked, subscribeDraftExits, trackDraftExit } from './draftSaver.ts'
import { encounterKey } from './encounters.ts'
import type { NoteInserter } from './insert.ts'

export { type Draft, type DraftSnapshot, type SaveState, appendPrescriptionItem, draftOf, isLocked } from './draftSaver.ts'

/**
 * The doctor's draft of a consultation, as one reusable hook (Doctor HERO: the consultation workspace and the prescription page both edit it):
 * the draft, `update`, the debounced autosave (and its retry), the serial save chain with the version and conflict handling, the last save
 * when the editor goes away (in-app navigation), the warning before the browser closes with unsaved edits, the recorded insertion of reviewed
 * AI text (`inserter`), and the Mana draft bridge (an approved Mana action adds a medicine row through `update`, DESIGN §5.8). The logic is
 * lib/draftSaver.ts (unit-tested); this file ties it to React and the query cache. Give it the encounter as the server holds it NOW (the
 * page waits for a fresh read: see useFreshDraftGate) and key the editor by the encounter's id.
 */
export function useEncounterDraft(initial: Encounter, opts: { draftBridge?: boolean } = {}) {
  const qc = useQueryClient()
  const samePerson = useStillSamePerson()
  const samePersonRef = useRef(samePerson)
  samePersonRef.current = samePerson
  const id = initial.id
  const [saver] = useState(
    () =>
      new DraftSaver(initial, {
        saveDraft: (body) => api<Encounter>(`/encounters/${id}/draft`, { method: 'PUT', body }),
        insert: (body) => api<Encounter>(`/encounters/${id}/insertions`, { method: 'POST', body }),
        samePerson: () => samePersonRef.current(),
        onSaved: (kind) => {
          void qc.invalidateQueries({ queryKey: ['my-consultations'] })
          // The consultation intelligence panel compares its draft with the note: it looks again when the note has been saved.
          void qc.invalidateQueries({ queryKey: consultKey(id) })
          // The overview lists what is in the note: after an insertion it reads the consultation again now, not at its next refresh.
          if (kind === 'insertion') void qc.invalidateQueries({ queryKey: contextKey(id) })
        },
      }),
  )
  const snap = useSyncExternalStore(saver.subscribe, saver.getSnapshot)

  // Debounced autosave; retry after errors.
  useEffect(() => {
    const ms = autosaveDelay(snap.state)
    if (ms === null) return
    const t = setTimeout(() => void saver.flush(), ms)
    return () => clearTimeout(t)
  }, [snap.draft, snap.state, saver])

  // Leaving the page within the autosave delay, during a save, or while an insertion runs (in-app navigation) still saves the last edits and
  // waits for what is under way; the next editor of this consultation (the prescription page, or the consultation again) opens on the version
  // that stored.
  useEffect(
    () => () => {
      if (saver.busy) void trackDraftExit(id, saver.idle().then(() => qc.invalidateQueries({ queryKey: encounterKey(id) })))
    },
    [saver, id, qc],
  )

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (saver.isDirty || saver.state === 'saving') e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [saver])

  // Mana's approved action adds the medicine to this draft (the doctor's act: Approve), saved by the autosave; refused when it cannot be added.
  const bridge = opts.draftBridge ?? true
  useEffect(() => {
    if (!bridge) return
    return registerDraftBridge({
      encounterId: id,
      addPrescriptionItem: (item: PrescriptionItemInput) => {
        // Checked first, so a full prescription is said before anything changes.
        appendPrescriptionItem(saver.getSnapshot().draft, item)
        if (!saver.update((d) => appendPrescriptionItem(d, item))) throw new Error('This draft cannot be saved just now, so the medicine was not added. Reload the consultation.')
      },
    })
  }, [bridge, id, saver])

  const update = useCallback((fn: (d: Draft) => Draft) => saver.update(fn), [saver])
  const flush = useCallback(() => saver.flush(), [saver])
  const flushState = useCallback(() => saver.flushState(), [saver])
  const idle = useCallback(() => saver.idle(), [saver])
  // One stable way into the note for every panel (what it reads is always the latest draft), so typing never redraws the panels.
  const inserter = useMemo<NoteInserter>(() => ({ insert: (...a) => saver.insert(...a), inserted: (...a) => saver.inserted(...a) }), [saver])
  return { ...snap, saver, update, flush, flushState, idle, inserter, locked: isLocked(snap.state) }
}

export type EncounterDraft = ReturnType<typeof useEncounterDraft>

/**
 * Signs the consultation (POST /sign) after saving what is pending, with the version the draft was saved at. Signing does not complete the
 * consultation (POST /complete does, a separate act). Refreshes what shows the consultation's state.
 */
export function useSignEncounter(encounterId: string, saver: DraftSaver, onSigned?: (e: Encounter) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await saver.flush()
      if (saver.state !== 'saved') throw new ApiError(409, 'not_saved', 'The latest changes could not be saved. Try again.')
      return api<Encounter>(`/encounters/${encounterId}/sign`, { method: 'POST', body: { version: saver.version, attestation: true } })
    },
    onSuccess: (e) => {
      qc.setQueryData(encounterKey(e.id), e)
      void qc.invalidateQueries({ queryKey: ['visits'] })
      void qc.invalidateQueries({ queryKey: ['appointments'] })
      void qc.invalidateQueries({ queryKey: ['patient', e.patient.id] })
      void qc.invalidateQueries({ queryKey: ['my-consultations'] })
      void qc.invalidateQueries({ queryKey: ['doctor-day'] })
      onSigned?.(e)
    },
  })
}

/**
 * Whether an editor may open on the encounter the page has read: only once it was read from the server after the page opened (never a cached
 * copy) and after the last save of an editor of the same consultation that went away (that save refreshes the read). Once true it stays true
 * (a later background refresh never closes the editor under the doctor's hands).
 */
export function useFreshDraftGate(encounterId: string | undefined, q: { isFetchedAfterMount: boolean; isFetching: boolean }): boolean {
  const exiting = useSyncExternalStore(subscribeDraftExits, () => draftExitPending(encounterId))
  const fresh = q.isFetchedAfterMount && !exiting && !q.isFetching
  // Latched per consultation: another consultation opened in the same page waits for its own fresh read.
  const [openedFor, setOpenedFor] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (fresh) setOpenedFor(encounterId)
  }, [fresh, encounterId])
  return (!!encounterId && openedFor === encounterId) || fresh
}

