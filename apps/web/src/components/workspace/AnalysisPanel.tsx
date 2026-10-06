import type { Encounter } from '@adaxai/contracts'
import { Check, Circle, CircleCheck, CircleMinus, CircleSlash, CircleX, LoaderCircle, Minus, Timer } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { type AnalysisInput, type AnalysisStep, analysisInputs, analysisSteps, analysisTiming, type StepState, type Tone } from '../../lib/analysis.ts'
import { useAnalysis, useAnalysisInputFacts } from './AnalyzeButton.tsx'

/*
 * The progress of "Analyze with Mana", in the Mana area (`analysis-panel`). While a run is under way: what it reads from each input (marks,
 * never progress), its steps as the page and the server know them (your note saved; the fixed safety rules' results; the local model waiting
 * for its turn or writing), and the time since the click on this page's own clock. Once it ended: the steps' outcomes and how long the model
 * took, by the server's own times (when it says when the model started, also how long it waited and how long the writing and the checks took).
 * Nothing here is estimated: no percentage, no time left, no step the server does not report. A draft found under way after a reload is
 * shown with the model's step only and the time it started by the server's clock.
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

function StepRow({ step }: { step: AnalysisStep }) {
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
      </div>
    </li>
  )
}

/**
 * Shown while a run is under way (this page's, or a draft found being made) and, after this page's run ended, as its record: the steps and the
 * time. Nothing before the first click.
 */
export function AnalysisPanel({ encounter }: { encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'> }) {
  const headingId = useId()
  const { run, ai, active } = useAnalysis(encounter.id)
  const live = useAnalysisInputFacts(encounter)
  const now = useNow(active && !!run)
  if (!run && !active) return null

  const ask = run?.ask ?? null
  const steps = analysisSteps({ save: run?.save ?? null, rules: run?.rules ?? null, ask, ai })
  const timing = analysisTiming({ clickedAt: run?.clickedAt ?? null, now, ask, ai })
  return (
    <section aria-labelledby={headingId} className={`min-w-0 rounded-xl border bg-surface p-4 shadow-card ${active ? 'border-ai/30' : 'border-line'}`} data-testid="analysis-panel" data-state={active ? 'running' : 'done'}>
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
      {active && (
        <div className="mt-3">
          <InputRecap inputs={run?.inputs ?? analysisInputs(live)} />
        </div>
      )}
      {/* The steps' words are announced as they change (politely); the clock above is not. */}
      <ol aria-live="polite" className="mt-3 space-y-2" data-testid="analysis-steps">
        {steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ol>
    </section>
  )
}
