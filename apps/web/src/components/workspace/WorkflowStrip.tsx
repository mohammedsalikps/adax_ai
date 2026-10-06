import { type ConsultationAi, ConsultationContext, type Encounter, type PendingReview } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { analysisFacts, type NoteSaveState, type Tone } from '../../lib/analysis.ts'
import { api } from '../../lib/api.ts'
import { contextKey } from '../../lib/consultationContext.ts'
import { type InputModuleFacts, moduleFills, type WorkflowStep, workflowSteps } from '../../lib/workflow.ts'
import { showPart } from '../../lib/workspace.ts'
import { showsStatements } from '../ai/ConsultationIntelligence.tsx'
import { useConsultationAiObserver } from './AnalyzeButton.tsx'
import { useConversationModule } from './summaries/ConversationSummary.tsx'
import { useHistoryModule } from './summaries/HistorySummary.tsx'
import { useStethoscopeModule } from './summaries/StethoscopeSummary.tsx'
import { useThermalModule } from './summaries/ThermalSummary.tsx'
import { useVitalsModule } from './summaries/VitalsSummary.tsx'

/*
 * The workflow strip under the consultation's header (Doctor HERO): 1 Inputs → 2 Mana analysis → 3 Your review → 4 Note & prescription →
 * 5 Sign, each with the state it is in now, and each a button that leads to its part of the page. Every word comes from data the page already
 * holds (lib/workflow.ts): the five modules' observers, the result card's AI state and the overview's context (both observed, never asked
 * for here), the note's save state and the prescription's rows. It replaces the "Go to" bar; the modules are always in the rail.
 */

/** What the five modules hold, from their own observers (no request). */
export function useInputModuleFacts(encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'>): InputModuleFacts {
  const conversation = useConversationModule(encounter)
  const history = useHistoryModule(encounter)
  const vitals = useVitalsModule(encounter)
  const stethoscope = useStethoscopeModule(encounter)
  const thermal = useThermalModule(encounter)
  return { conversation: conversation.facts, history: history.facts, vitals: vitals.facts, stethoscope: stethoscope.facts, thermal: thermal.facts }
}

/** What waits for review, as the overview (D2) counted it; null until the overview has read this consultation. Observed, never asked for. */
function usePendingReview(encounterId: string): PendingReview | null {
  const q = useQuery({
    queryKey: contextKey(encounterId),
    queryFn: async () => ConsultationContext.parse(await api<unknown>(`/encounters/${encounterId}/context`)),
    enabled: false,
    select: (c: ConsultationContext) => (c.encounterId === encounterId ? c.pending : null),
  })
  return q.data ?? null
}

/** The draft statements not yet decided (all of them, the medication considerations included); 0 while none are shown. */
const undecidedOf = (ai: Pick<ConsultationAi, 'draft'>): number => (ai.draft && showsStatements(ai.draft) ? ai.draft.items.filter((i) => i.decision === 'pending').length : 0)

/** A word for each step's state (`data-state`), for whoever reads the page by its markup. */
export function stepStateKey(step: WorkflowStep, f: { inputs: InputModuleFacts; analysisView: string | null; save: NoteSaveState; signed: boolean }): string {
  switch (step.id) {
    case 'inputs': {
      const n = moduleFills(f.inputs).filter((m) => m.filled).length
      return n === 0 ? 'none' : n === 5 ? 'all' : 'some'
    }
    case 'analysis':
      return f.analysisView ?? 'unknown'
    case 'review':
      return step.state === '—' ? 'not_yet' : step.tone === 'warn' ? 'waiting' : step.tone === 'ok' ? 'clear' : 'uncounted'
    case 'record':
      return f.save
    case 'sign':
      return f.signed ? 'signed' : 'unsigned'
  }
}

const NUMBER_TONE: Record<Tone, string> = {
  neutral: 'border-line bg-canvas text-ink-muted',
  ok: 'border-ok/20 bg-ok-soft text-ok',
  warn: 'border-pending/20 bg-pending-soft text-pending',
  down: 'border-down/20 bg-down-soft text-down',
  notice: 'border-notice/20 bg-notice-soft text-notice',
  ai: 'border-ai/30 bg-ai-soft text-ai',
}
const STATE_TONE: Record<Tone, string> = { neutral: 'text-ink-muted', ok: 'text-ok', warn: 'text-pending', down: 'text-down', notice: 'text-notice', ai: 'text-ai' }

/** Moves focus to the header's "Complete consultation" (the one that can be seen: the header's, or the bottom bar's on a narrow screen). */
function focusComplete() {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  buttons.find((b) => b.textContent?.trim() === 'Complete consultation' && b.getClientRects().length > 0)?.focus()
}

export interface WorkflowStripProps {
  encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'>
  /** The note's save state (what the SaveIndicator shows). */
  save: NoteSaveState
  /** Prescription rows that name a medicine (lib/workflow.ts `medicineCount`). */
  medicines: number
  signed?: boolean
  /** Step 5: where signing starts. Without it, focus goes to the visible "Complete consultation" button. */
  onSign?: () => void
}

/**
 * A nav named "Consultation steps": an ordered list of five buttons, each named by its label and its state ("Mana analysis: Writing").
 * Inputs leads to the rail (its heading), Mana analysis to `#mana-result`, Your review to `#mana-review` (the first block that waits; the Mana
 * area when there is none), Note & prescription to the note, and Sign to "Complete consultation". One row at every width: five columns from
 * 1024px, a row that scrolls sideways inside itself below.
 */
export function WorkflowStrip({ encounter, save, medicines, signed = false, onSign }: WorkflowStripProps) {
  const inputs = useInputModuleFacts(encounter)
  const consult = useConsultationAiObserver(encounter.id, (ai) => ({ analysis: analysisFacts(ai), undecided: undecidedOf(ai) }))
  const pending = usePendingReview(encounter.id)
  const analysis = consult.data?.analysis ?? null
  const steps = workflowSteps({ inputs, analysis, undecided: consult.data?.undecided ?? null, pending, save, medicines, signed })
  const go = (s: WorkflowStep) => {
    if (s.target === null) return (onSign ?? focusComplete)()
    if (!showPart(s.target) && s.target === 'mana-review') showPart('mana-result')
  }
  return (
    <nav aria-label="Consultation steps" className="min-w-0" data-testid="workflow-strip">
      {/* Below 1024px one row that scrolls sideways inside itself, a step at a time (each step is a stop); from 1024px five equal columns. The
          padding keeps each button's focus ring inside the row's own scroller. */}
      <ol className="-m-1 flex snap-x snap-mandatory scroll-px-1 gap-2 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none] lg:m-0 lg:grid lg:snap-none lg:grid-cols-5 lg:overflow-visible lg:p-0">
        {steps.map((s) => (
          <li key={s.id} className="shrink-0 snap-start lg:max-w-full lg:min-w-0 lg:shrink" data-step={s.id} data-state={stepStateKey(s, { inputs, analysisView: analysis?.view ?? null, save, signed })} data-tone={s.tone}>
            <button
              type="button"
              aria-label={s.name}
              onClick={() => go(s)}
              className="flex min-h-control w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1 text-left whitespace-nowrap shadow-card hover:bg-canvas lg:whitespace-normal"
            >
              <span aria-hidden="true" className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums ${NUMBER_TONE[s.tone]}`}>
                {s.n}
              </span>
              <span className="min-w-0">
                <span className="block text-sm leading-tight font-medium text-ink">{s.label}</span>
                <span className={`block text-xs leading-tight break-words tabular-nums ${STATE_TONE[s.tone]}`}>{s.state}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
