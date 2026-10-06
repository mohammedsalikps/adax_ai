import type { ConsultationAi, ConsultDraft, ConsultProgress, Encounter } from '@adaxai/contracts'
import { type QueryClient, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { type AiResponse, aiKey, newIdempotencyKey } from '../../lib/ai.ts'
import {
  type AiFacts,
  type AnalysisInput,
  type AnalysisInputFacts,
  type ModelAsk,
  modelStep,
  NO_WRITING,
  type NoteSaveState,
  nextWriting,
  type RulesRun,
  rulesRunOf,
  type SaveRun,
  savedForAnalysis,
  startRefusal,
  withPolledProgress,
  type Writing,
} from '../../lib/analysis.ts'
import { ApiError, api, errorMessage } from '../../lib/api.ts'
import { consultKey, draftPollKey } from '../../lib/consult.ts'
import { contextKey } from '../../lib/consultationContext.ts'
import { useConversationModule } from './summaries/ConversationSummary.tsx'
import { useHistoryModule } from './summaries/HistorySummary.tsx'
import { useThermalModule } from './summaries/ThermalSummary.tsx'
import { useVitalsModule } from './summaries/VitalsSummary.tsx'

/*
 * The run behind "Generate prescription" (DESIGN §5.5; it was "Analyze with Mana"). One click does three real things, in this order: the
 * doctor's note is saved (the page's own save chain); then, at the same time, the fixed safety rules run (POST /encounters/:id/recommendations,
 * rules only) and the local model is asked for a draft (POST /encounters/:id/consultation-ai/drafts). It never opens or asks Mana chat: the
 * chat shares the one model slot and asks nothing until the doctor opens it.
 *
 * What this page's run did is kept here, per consultation, outside React (the button is in the bottom bar, its progress in the "Preparing the
 * consultation" sheet): the time of the click on this page's own clock (performance.now), and each step's outcome as the server answered it.
 * Nothing here is estimated or animated: a step says only what its request returned or what the draft's own state says. JSX-free.
 */

// --- this page's run ---------------------------------------------------------------------------------------------------------------------------

export interface AnalysisRun {
  /** Which click this is: an answer that arrives for an earlier click is dropped. */
  id: number
  /** performance.now() at the click: the live clock counts from here, never from a server time read against this computer's clock. */
  clickedAt: number
  /** What the run reads from each input, as the page knew it at the click. */
  inputs: AnalysisInput[]
  save: SaveRun
  rules: RulesRun
  ask: ModelAsk
  /** The save and the two requests are still under way. */
  pending: boolean
}

const runs = new Map<string, AnalysisRun>()
const listeners = new Set<() => void>()
let lastRunId = 0

function emit() {
  for (const listener of Array.from(listeners)) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes the run of a consultation, unless a newer click has replaced it since. */
function patchRun(encounterId: string, id: number, patch: Partial<AnalysisRun>) {
  const run = runs.get(encounterId)
  if (!run || run.id !== id) return
  runs.set(encounterId, { ...run, ...patch })
  emit()
}

/** This page's last run on a consultation (null before the first click, and after the page was left once it had ended). */
export const analysisRunOf = (encounterId: string): AnalysisRun | null => runs.get(encounterId) ?? null

export function useAnalysisRun(encounterId: string): AnalysisRun | null {
  const read = () => analysisRunOf(encounterId)
  return useSyncExternalStore(subscribe, read, read)
}

export interface AnalysisRequest {
  encounterId: string
  /** The page's save chain: saves what is pending and resolves with the note's save state once nothing is pending. */
  flush: () => Promise<NoteSaveState>
  /** What the run reads, as the page knows it now (kept with the run); none by default. */
  inputs?: AnalysisInput[]
  qc: QueryClient
  /** Asks the local model for a draft (the V3 request, with a new idempotency key each time). */
  startDraft: () => Promise<ConsultDraft>
}

/** Said when the fixed rules answered without a safety_check run in the answer (never expected; said rather than guessed). */
export const RULES_NOT_FOUND = 'The answer did not include a run of the fixed safety rules.'

/**
 * One run: save, then the fixed rules and the local model at the same time. A save that ends in error, conflict or blocked stops it before
 * anything is asked. The rules' answer (the consultation's AI state) replaces the cached copy the capture panel, the safety rules and the
 * prescription lane read, and the overview reads its context again now. A 409 from the model means a draft is already being made: that draft
 * is followed. Resolves when the save and both requests have ended; the draft itself goes on, followed by the result card's polling.
 */
export async function runAnalysis({ encounterId, flush, inputs = [], qc, startDraft }: AnalysisRequest): Promise<void> {
  if (runs.get(encounterId)?.pending) return
  const id = ++lastRunId
  runs.set(encounterId, { id, clickedAt: performance.now(), inputs, save: { state: 'running' }, rules: { state: 'idle' }, ask: { state: 'idle' }, pending: true })
  emit()

  let saved: NoteSaveState
  try {
    saved = await flush()
  } catch {
    saved = 'error'
  }
  if (!savedForAnalysis(saved)) {
    patchRun(encounterId, id, { save: { state: 'failed' }, rules: { state: 'skipped' }, ask: { state: 'skipped' }, pending: false })
    return
  }
  patchRun(encounterId, id, { save: { state: 'done', at: new Date().toISOString() }, rules: { state: 'running' }, ask: { state: 'sending' } })

  const rules = api<AiResponse>(`/encounters/${encounterId}/recommendations`, { method: 'POST', body: { includeLlm: false, idempotencyKey: newIdempotencyKey() } }).then(
    (ai) => {
      if (ai.consent) qc.setQueryData(aiKey(encounterId), ai)
      void qc.invalidateQueries({ queryKey: contextKey(encounterId) })
      patchRun(encounterId, id, { rules: rulesRunOf(ai) ?? { state: 'failed', message: RULES_NOT_FOUND } })
    },
    (e: unknown) => patchRun(encounterId, id, { rules: { state: 'failed', message: errorMessage(e) } }),
  )
  const draft = startDraft().then(
    (d) => patchRun(encounterId, id, { ask: { state: 'sent', draft: d } }),
    (e: unknown) => {
      const refusal = e instanceof ApiError ? startRefusal(e) : { kind: 'failed' as const, message: errorMessage(e) }
      patchRun(encounterId, id, { ask: refusal.kind === 'running' ? { state: 'sent', draft: null } : { state: 'failed', message: refusal.message } })
    },
  )
  await Promise.all([rules, draft])
  patchRun(encounterId, id, { pending: false })
}

// --- what the page reads ---------------------------------------------------------------------------------------------------------------------

/**
 * The consultation's AI state (GET /encounters/:id/consultation-ai), observed: the page's owner of that query (lib/consult.ts
 * useConsultationAi, in the bottom bar's Generate prescription) reads and polls it; nothing here asks for it (never enabled).
 */
export function useConsultationAiObserver<T = ConsultationAi>(encounterId: string, select?: (ai: ConsultationAi) => T) {
  return useQuery({
    queryKey: consultKey(encounterId),
    queryFn: () => api<ConsultationAi>(`/encounters/${encounterId}/consultation-ai`, { query: { fresh: 1 } }),
    enabled: false,
    select,
  })
}

/**
 * What a run reads from each input, as the page holds it: the five modules' own observers (no request). The thermal summaries the doctor
 * reviewed are not held by any query on this page, so they are not counted (the list then names the approved images' measurements only).
 */
export function useAnalysisInputFacts(encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'>): AnalysisInputFacts {
  const conversation = useConversationModule(encounter)
  const history = useHistoryModule(encounter)
  const vitals = useVitalsModule(encounter)
  const thermal = useThermalModule(encounter)
  return { confirmedPoints: conversation.confirmedPoints, history: history.status, ...vitals.analysis, ...thermal.analysis, reviewedThermalSummaries: 0 }
}

/**
 * The draft being made, as useConsultationAi polls it about every second (GET /consultation-ai/drafts/:id, lib/consult.ts): observed, never
 * enabled here, so it adds no request. It carries the model's progress, which the consultation's AI state does not re-read.
 */
function usePolledDraft(draftId: string | null) {
  return useQuery({ queryKey: draftPollKey(draftId), queryFn: () => api<ConsultDraft>(`/consultation-ai/drafts/${draftId}`), enabled: false }).data ?? null
}

/** The writing speed of a consultation's draft, from the successive progress values the page polled (lib/analysis.ts nextWriting), kept per consultation. */
const writings = new Map<string, Writing>()

function useWriting(encounterId: string, draftId: string | null, progress: ConsultProgress | null): Writing {
  // The polled answer keeps its identity while it is unchanged (the query's structural sharing), and the same report read again changes nothing.
  return useMemo(() => {
    if (!draftId) return NO_WRITING
    const next = nextWriting(writings.get(encounterId) ?? NO_WRITING, draftId, progress)
    writings.set(encounterId, next)
    return next
  }, [encounterId, draftId, progress])
}

export interface AnalysisState {
  run: AnalysisRun | null
  /** The consultation's AI state, with the polled progress on the draft being made (lib/analysis.ts withPolledProgress). */
  ai: AiFacts | undefined
  aiError: boolean
  /** A run is under way: this page's save and requests, or a draft being made (this page's attempt, or one found under way). */
  active: boolean
  /** While the model writes: how far it has got as the server last said (null when it has not said), and the speed from the last two values. */
  progress: ConsultProgress | null
  writing: Writing
}

export function useAnalysis(encounterId: string): AnalysisState {
  const run = useAnalysisRun(encounterId)
  const q = useConsultationAiObserver(encounterId)
  const shown = q.data?.draft
  const generatingId = shown?.status === 'generating' ? shown.id : null
  const polled = usePolledDraft(generatingId)
  const ai = withPolledProgress(q.data, polled) ?? undefined
  const d = ai?.draft
  const progress = d && d.status === 'generating' && d.phase === 'running' ? (d.progress ?? null) : null
  const writing = useWriting(encounterId, generatingId, progress)
  const active = !!run?.pending || modelStep(run?.ask ?? null, ai).state === 'running'
  return { run, ai, aiError: q.isError, active, progress, writing }
}

/** A run that has ended is forgotten when the page is left; one still under way keeps its place, so its answers are not lost. */
export function useForgetEndedRun(encounterId: string) {
  useEffect(
    () => () => {
      const last = runs.get(encounterId)
      if (last && !last.pending) {
        runs.delete(encounterId)
        emit()
      }
    },
    [encounterId],
  )
}
