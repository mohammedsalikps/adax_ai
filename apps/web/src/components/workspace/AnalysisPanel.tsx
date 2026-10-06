import type { ConsultInputsUsed, Encounter } from '@adaxai/contracts'
import { Check, Circle, CircleCheck, CircleMinus, CircleSlash, CircleX, LoaderCircle, Minus, Timer } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import {
  type AnalysisInput,
  type AnalysisStep,
  analysisInputs,
  analysisSteps,
  analysisTiming,
  analyzedInputs,
  analyzedTitle,
  analyzedTotal,
  attemptDraft,
  type DraftFacts,
  type StepState,
  type Tone,
  writingCap,
  writingText,
} from '../../lib/analysis.ts'
import { useAnalysis, useAnalysisInputFacts } from './AnalyzeButton.tsx'

/*
 * The progress of "Analyze with Mana", in the Mana area (`analysis-panel`). While a run is under way: what it reads from each input (marks,
 * never progress), its steps as the page and the server know them (your note saved; the fixed safety rules' results; the local model waiting
 * for its turn, reading what was sent, or writing, with the tokens it has written and its speed as the server reports them), and the time since
 * the click on this page's own clock. Once the record has reached the model, what was sent, counted by the server from the draft's own list of
 * sources; once the draft is ready, that list is "Mana analyzed". When the run ended: the steps' outcomes and how long the model took, by the
 * server's own times. Nothing here is estimated: no percentage, no time left, no step the server does not report. A draft found under way after
 * a reload is shown with the model's step only and the time it started by the server's clock; a finished one with what it analyzed only.
 */

const TONE_TEXT: Record<Tone, string> = { neutral: 'text-ink-muted', ok: 'text-ok', warn: 'text-pending', down: 'text-down', notice: 'text-notice', ai: 'text-ai' }

const STEP_ICON: Record<StepState, ReactNode> = {
  idle: <Circle aria-hidden="true" className="size-4" />,
  running: <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />,
  done: <CircleCheck aria-hidden="true" className="size-4" />,
  failed: <CircleX aria-hidden="true" className="size-4" />,
  cancelled: <CircleSlash aria-hidden="true" className="size-4" />,
  skipped: <CircleMinus aria-hidden="true" className="size-4" />,
}

/** performance.now(), read again twice a second while `ticking` (the live clock); still otherwise. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!ticking) return
    setNow(performance.now())
    const t = setInterval(() => setNow(performance.now()), 500)
    return () => clearInterval(t)
  }, [ticking])
  return now
}

/** The five inputs in one row of marks (the rail's list says why each is read or not). */
function InputRecap({ inputs }: { inputs: readonly AnalysisInput[] }) {
  return (
    <ul aria-label="What this analysis reads" className="flex flex-wrap gap-1.5" data-testid="analysis-panel-inputs">
      {inputs.map((i) => (
        <li
          key={i.key}
          className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${i.included ? 'border-ok/20 bg-ok-soft text-ok' : 'border-line bg-canvas text-ink-muted'}`}
          data-input={i.key}
          data-included={i.included}
        >
          {i.included ? <Check aria-hidden="true" className="size-3 shrink-0" /> : <Minus aria-hidden="true" className="size-3 shrink-0" />}
          <span className="min-w-0 break-words">
            {i.label}
            <span className="sr-only">{i.included ? ': read' : ': not read'}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function StepRow({ step, children }: { step: AnalysisStep; children?: ReactNode }) {
  const tone = TONE_TEXT[step.tone]
  // The save step's reason is said by the button that was pressed ("Your note could not be saved, so Mana was not asked."), not twice.
  const message = step.id === 'save' ? null : step.message
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2" data-step={step.id} data-state={step.state}>
      <span className={`mt-0.5 ${step.state === 'idle' ? 'text-ink-muted' : tone}`}>{STEP_ICON[step.state]}</span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium text-ink">{step.label}</span>
          <span className="sr-only">: </span>
          <span className={`break-words ${tone} ${step.tone === 'ai' ? 'font-semibold' : ''}`}>{step.detail}</span>
        </p>
        {message && <p className="mt-0.5 text-xs break-words text-ink-muted">{message}</p>}
        {children}
      </div>
    </li>
  )
}

/**
 * What reached the local model for a draft (`mana-analyzed`), from ConsultDraft.inputsUsed: ✓ each input with what was sent of it, ○ each with
 * nothing sent and why (never "none": what was not sent may still be in the record), the stethoscope always not analysed, and how many sources
 * were sent in all. "Mana analyzed" once the draft has statements; "Sent to the local model" while it writes or after it stopped.
 */
export function AnalyzedList({ draft, used, level = 4 }: { draft: Pick<DraftFacts, 'status'>; used: ConsultInputsUsed; level?: 3 | 4 }) {
  const titleId = useId()
  const Heading = `h${level}` as const
  const title = analyzedTitle(draft)
  return (
    <div className="min-w-0" data-testid="mana-analyzed" data-status={draft.status}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Heading id={titleId} className="text-sm font-semibold">
          {title}
          <span className="sr-only">:</span>
        </Heading>
        <p className="text-xs text-ink-muted tabular-nums" data-testid="mana-analyzed-total">
          {analyzedTotal(used)}
        </p>
      </div>
      {/* Two columns where the panel is wide, filled top to bottom, so the list reads in its order down each column. */}
      <ul aria-labelledby={titleId} className="mt-1.5 gap-x-6 @lg/analysis:columns-2">
        {analyzedInputs(used).map((i) => (
          <li key={i.key} className="mb-1 grid break-inside-avoid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 text-sm" data-input={i.key} data-sent={i.sent}>
            <span aria-hidden="true" className={`mt-0.5 flex size-4 items-center justify-center ${i.sent ? 'text-ok' : 'text-ink-muted'}`}>
              {i.sent ? <Check className="size-4" /> : <Circle className="size-3" />}
            </span>
            <p className="min-w-0 break-words">
              <span className="sr-only">{i.sent ? 'Sent: ' : 'Not sent: '}</span>
              <span className={i.sent ? 'font-medium text-ink' : 'text-ink'}>{i.label}</span>
              <span className="text-ink-muted tabular-nums">{i.sent ? ` (${i.text})` : ` — ${i.text}`}</span>
              {i.detail && <span className="block text-xs text-ink-muted">{i.detail}</span>}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Shown while a run is under way (this page's, or a draft found being made) and, after this page's run ended, as its record: the steps, what
 * reached the model and the time. Without a run on this page (after a reload), only what the shown draft analyzed, when it has statements.
 * Nothing before the first draft.
 */
export function AnalysisPanel({ encounter }: { encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'> }) {
  const headingId = useId()
  const { run, ai, active, progress, writing } = useAnalysis(encounter.id)
  const live = useAnalysisInputFacts(encounter)
  const now = useNow(active && !!run)
  if (!run && !active) {
    const d = ai?.draft
    if (!d?.inputsUsed || (d.status !== 'ready' && d.status !== 'partial')) return null
    return (
      <section aria-label="Last analysis" className="@container/analysis min-w-0 rounded-xl border border-line bg-surface p-4 shadow-card" data-testid="analysis-record">
        <AnalyzedList draft={d} used={d.inputsUsed} level={3} />
      </section>
    )
  }

  const ask = run?.ask ?? null
  const steps = analysisSteps({ save: run?.save ?? null, rules: run?.rules ?? null, ask, ai })
  const timing = analysisTiming({ clickedAt: run?.clickedAt ?? null, now, ask, ai })
  // The attempt this panel follows: what reached the model is said once the server counted it (the record was sent).
  const attempt = ask && ask.state !== 'sent' ? null : attemptDraft(ask, ai)
  const used = attempt?.inputsUsed ?? null
  const writingLine = active && progress ? writingText(progress, writing.rate) : null
  return (
    <section
      aria-labelledby={headingId}
      className={`@container/analysis min-w-0 rounded-xl border bg-surface p-4 shadow-card ${active ? 'border-ai/30' : 'border-line'}`}
      data-testid="analysis-panel"
      data-state={active ? 'running' : 'done'}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-base font-semibold">
          {active ? 'Analyzing with Mana' : 'Last analysis'}
        </h3>
        {timing && (
          <div className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
            <Timer aria-hidden="true" className="size-4 shrink-0" />
            <p className="tabular-nums first-letter:uppercase" data-testid="analysis-timing">
              {timing}
            </p>
          </div>
        )}
      </div>
      {active && !used && (
        <div className="mt-3">
          <InputRecap inputs={run?.inputs ?? analysisInputs(live)} />
        </div>
      )}
      {/* The steps' words are announced as they change (politely); the clock above and the token count below are not. */}
      <ol aria-live="polite" className="mt-3 space-y-2" data-testid="analysis-steps">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>
      {writingLine && progress && (
        // Under the model's step, in line with its words; read with the page, not announced at every report.
        <p className="mt-0.5 pl-6 text-sm text-ink-muted tabular-nums" data-testid="analysis-progress" data-tokens={progress.generatedTokens} data-rate={writing.rate === null ? undefined : Math.round(writing.rate)}>
          <span className="font-medium text-ai">{writingLine}</span>
          {progress.generatedTokens > 0 && <span> · {writingCap(progress)}</span>}
        </p>
      )}
      {used && attempt && (
        <div className="mt-3 border-t border-line pt-3">
          <AnalyzedList draft={attempt} used={used} />
        </div>
      )}
    </section>
  )
}
