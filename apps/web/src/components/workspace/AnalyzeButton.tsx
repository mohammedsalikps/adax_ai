import type { ConsultationAi, ConsultDraft, ConsultProgress, Encounter } from '@adaxai/contracts'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronUp, LoaderCircle, Minus, Sparkles } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type AiResponse, aiKey, newIdempotencyKey } from '../../lib/ai.ts'
import {
  ANALYSIS_COVERAGE,
  type AiFacts,
  type AnalysisInput,
  type AnalysisInputFacts,
  analysisInputs,
  analyzeControl,
  fmtCount,
  fmtDuration,
  type ModelAsk,
  modelStep,
  NO_WRITING,
  NOT_SAVED,
  nextWriting,
  type NoteSaveState,
  type RulesRun,
  rulesRunOf,
  type SaveRun,
  savedForAnalysis,
  startRefusal,
  withPolledProgress,
  type Writing,
} from '../../lib/analysis.ts'
import { ApiError, api, errorMessage } from '../../lib/api.ts'
import { consultKey, draftPollKey, useGenerateDraft } from '../../lib/consult.ts'
import { isMacPlatform } from '../../lib/shortcuts.ts'
import { contextKey } from '../../lib/consultationContext.ts'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { useConversationModule } from './summaries/ConversationSummary.tsx'
import { useHistoryModule } from './summaries/HistorySummary.tsx'
import { useThermalModule } from './summaries/ThermalSummary.tsx'
import { useVitalsModule } from './summaries/VitalsSummary.tsx'

/*
 * "Analyze with Mana" (Doctor HERO), at the foot of the inputs rail. One click does three real things, in this order: the doctor's note is
 * saved (the page's own save chain); then, at the same time, the fixed safety rules run (POST /encounters/:id/recommendations, rules only) and
 * the local model is asked for a draft (POST /encounters/:id/consultation-ai/drafts, the V3 draft the result card already polls). It never
 * opens or asks Mana chat: the chat shares the one model slot and asks nothing until the doctor opens it.
 *
 * What this page's run did is kept here, per consultation, outside React (the button sits in the rail, its progress in the Mana area): the
 * time of the click on this page's own clock (performance.now), what the run read, and each step's outcome as the server answered it. Nothing
 * here is estimated or animated: a step says only what its request returned or what the draft's own state says.
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
  /** What the run reads, as the page knows it now (kept with the run). */
  inputs: AnalysisInput[]
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
export async function runAnalysis({ encounterId, flush, inputs, qc, startDraft }: AnalysisRequest): Promise<void> {
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
 * The consultation's AI state (GET /encounters/:id/consultation-ai), observed: the result card (ConsultationIntelligence) owns and polls this
 * query; nothing here asks for it (never enabled), so it adds no request and no audit entry.
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
 * The draft being made, as the result card polls it about every second (GET /consultation-ai/drafts/:id, lib/consult.ts): observed, never
 * enabled here, so it adds no request. It carries the model's progress, which the consultation's AI state does not re-read.
 */
function usePolledDraft(draftId: string | null) {
  return useQuery({ queryKey: draftPollKey(draftId), queryFn: () => api<ConsultDraft>(`/consultation-ai/drafts/${draftId}`), enabled: false }).data ?? null
}

/**
 * The writing speed of a consultation's draft, from the successive progress values the page polled (lib/analysis.ts nextWriting), kept per
 * consultation outside React so that the rail's line and the Mana area's progress, drawn apart, give the same speed from the same values.
 */
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
  /**
   * A run is under way: this page's save and requests, or a draft being made (this page's attempt, or one found under way). The rail's
   * button and the Mana area's progress both read this, so they never disagree.
   */
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

/** The rail's short form of the progress while the model writes ("812 tokens"); null otherwise. */
const tokensSoFar = (p: ConsultProgress | null) => (p && p.generatedTokens > 0 ? `${fmtCount(p.generatedTokens)} ${p.generatedTokens === 1 ? 'token' : 'tokens'}` : null)

// --- the inclusion list ------------------------------------------------------------------------------------------------------------------------

/**
 * What a run reads from each of the five inputs: a mark (read, or not read) and why, never progress. `testId` keeps the rail's list the one
 * `analysis-inputs` on the page. `hideTitle`: the title names the list for assistive technology only (what opens it already says it).
 */
export function InputMarks({ inputs, title, testId = 'analysis-inputs', hideTitle = false }: { inputs: readonly AnalysisInput[]; title: string; testId?: string; hideTitle?: boolean }) {
  const titleId = useId()
  return (
    <div className="min-w-0">
      <p id={titleId} className={hideTitle ? 'sr-only' : 'text-xs font-semibold text-ink'}>
        {title}
      </p>
      <ul aria-labelledby={titleId} className={`${hideTitle ? '' : 'mt-1.5 '}space-y-1`} data-testid={testId}>
        {inputs.map((i) => (
          <li key={i.key} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 text-xs" data-input={i.key} data-included={i.included}>
            <span aria-hidden="true" className={`mt-px flex size-4 items-center justify-center ${i.included ? 'text-ok' : 'text-ink-muted'}`}>
              {i.included ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
            </span>
            <p className="min-w-0 break-words">
              <span className="sr-only">{i.included ? 'Read: ' : 'Not read: '}</span>
              <span className="font-medium text-ink tabular-nums">
                {i.n} {i.label}
              </span>
              <span className="text-ink-muted"> · {i.text}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- the control -------------------------------------------------------------------------------------------------------------------------------

export interface AnalyzeButtonProps {
  encounter: Encounter
  /**
   * The page's save chain (ConsultationPage's `flush`), resolving with the note's save state once nothing is pending:
   * `async () => { await flush(); return stateRef.current }`.
   */
  flush: () => Promise<NoteSaveState>
  /** The note's save state now (what the SaveIndicator shows): the control is off while the note cannot be saved at all. */
  save: NoteSaveState
}

/** A Mac names the page's shortcut with Command, everything else with Ctrl. */
const MAC = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform)

/** performance.now(), read again every second while `ticking`; still otherwise. */
function useTicking(ticking: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!ticking) return
    setNow(performance.now())
    const t = setInterval(() => setNow(performance.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  return now
}

/**
 * One line under the button: "Reads 4 of 5 inputs · What Mana reads". Before a run, how many of the five inputs a run reads as the page holds
 * them now; while a run is under way, what the local model is doing, the tokens it has written (as the server reports them) and the time since
 * the click instead ("Writing the draft · 812 tokens · 0:21"), so the click is answered where it was made even when the Mana area's progress
 * is out of sight (that panel is the one that announces the steps). "What Mana reads" opens a popover above the Analyze area (never over the
 * button, and the rail's foot does not grow): the list of the five inputs (`analysis-inputs`: each read or not and why, marks, never progress;
 * during a run what that run read at the click) and the fixed line on what a run never reads, at most 18rem with its own scroll. Escape or a
 * click elsewhere closes it, and focus returns to its button. Not remembered.
 */
export function AnalysisReads({ encounter }: { encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'> }) {
  const { run, ai, active, progress } = useAnalysis(encounter.id)
  const facts = useAnalysisInputFacts(encounter)
  const inputs = active && run ? run.inputs : analysisInputs(facts)
  const read = inputs.filter((i) => i.included).length
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const now = useTicking(active && !!run)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])
  const elapsed = active && run ? fmtDuration(Math.max(0, now - run.clickedAt)) : null
  const doing = active ? modelStep(run?.ask ?? null, ai).detail : null
  const tokens = active ? tokensSoFar(progress) : null
  return (
    // Not positioned itself: the list opens above the whole Analyze area (AnalyzeButton's wrapper), so it never covers the button.
    <div ref={wrap} className="min-w-0" data-testid="analysis-reads">
      <div className="flex min-h-control-sm min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
        {doing ? (
          <span className="font-medium text-ai tabular-nums" data-testid="analyze-progress">
            {doing}
            {tokens ? ` · ${tokens}` : ''}
            {elapsed ? ` · ${elapsed}` : ''}
          </span>
        ) : (
          <span className="tabular-nums" data-testid="analysis-reads-count">
            Reads {read} of {inputs.length} inputs
          </span>
        )}
        <span aria-hidden="true">·</span>
        <button
          ref={button}
          type="button"
          className="inline-flex min-h-control-sm items-center gap-0.5 rounded-md font-medium text-brand-strong hover:underline"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
        >
          What Mana reads
          <ChevronUp aria-hidden="true" className={`size-3.5 transition-transform ${open ? '' : 'rotate-180'}`} />
        </button>
      </div>
      <div
        id={panelId}
        hidden={!open}
        role="region"
        aria-label="What Mana reads"
        className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-72 space-y-2 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-3 shadow-pop"
      >
        <InputMarks inputs={inputs} title="What Mana reads, input by input" />
        <p className="text-xs text-ink-muted" data-testid="analysis-coverage">
          {ANALYSIS_COVERAGE}
        </p>
      </div>
    </div>
  )
}

/**
 * The one control: "Analyze with Mana", "Analyzing…" (busy, off) while a run or a draft is under way, "Analyze again" after one. Off with
 * the reason, said under it and tied to it (aria-describedby), while the model's state is not known, while the note cannot be saved, and when
 * the server says no draft can be asked for. Under it, one line: how many of the five inputs a run reads, which opens the list of what it reads
 * and never reads. Cancel stays with the draft in the result card.
 */
export function AnalyzeButton({ encounter, flush, save }: AnalyzeButtonProps) {
  const id = encounter.id
  const qc = useQueryClient()
  const generate = useGenerateDraft(id)
  const { run, ai, aiError, active } = useAnalysis(id)
  const facts = useAnalysisInputFacts(encounter)
  const control = analyzeControl({ ai, aiError, running: active, save })
  const reasonId = useId()

  // A run that has ended is forgotten when the page is left; one still under way keeps its place, so its answers are not lost.
  useEffect(
    () => () => {
      const last = runs.get(id)
      if (last && !last.pending) {
        runs.delete(id)
        emit()
      }
    },
    [id],
  )

  const start = () => void runAnalysis({ encounterId: id, flush, inputs: analysisInputs(facts), qc, startDraft: () => generate.mutateAsync() })
  const notSaved = !active && run?.save.state === 'failed'

  return (
    <div className="relative min-w-0 space-y-0.5" data-testid="analyze-area">
      <Button
        variant="ai"
        size="lg"
        className="w-full"
        icon={control.busy ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> : <Sparkles aria-hidden="true" className="size-5" />}
        disabled={control.disabled}
        aria-busy={control.busy || undefined}
        aria-describedby={control.reason ? reasonId : undefined}
        // The page's shortcut (lib/shortcuts.ts): Ctrl+Enter, or Command+Enter on a Mac.
        aria-keyshortcuts={MAC ? 'Meta+Enter' : 'Control+Enter'}
        data-testid="analyze-mana"
        data-state={control.state}
        onClick={start}
      >
        {control.label}
      </Button>
      {control.reason && (
        <p id={reasonId} className="pt-1 text-sm break-words text-ink-muted" data-testid="analyze-reason">
          {control.reason}
        </p>
      )}
      {notSaved && (
        <Alert tone="error">
          <span data-testid="analyze-not-saved">{NOT_SAVED}</span>
        </Alert>
      )}
      <AnalysisReads encounter={encounter} />
    </div>
  )
}
