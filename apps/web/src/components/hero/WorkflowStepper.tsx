import { Check } from 'lucide-react'

/** The consultation's five stages, in order (UI/UX redesign: the reference's stepper). */
export const WORKFLOW_STAGES = ['Consultation', 'Analyze', 'Prescription', 'Review & sign', 'Complete'] as const
export type WorkflowStage = 0 | 1 | 2 | 3 | 4

/**
 * Where this consultation is in its workflow, as a row of stages (UI/UX redesign). A picture of the page's own state, never a control: it
 * changes no step and navigates nowhere (the page's buttons do that, as before). Stages before `current` are done; `allDone` marks every stage
 * done (a completed consultation). The current stage carries the brand gradient and `aria-current="step"`.
 */
export function WorkflowStepper({ current, allDone = false, className = '' }: { current: WorkflowStage; allDone?: boolean; className?: string }) {
  return (
    <div role="group" aria-label="Consultation progress" className={`print:hidden ${className}`} data-testid="workflow-stepper">
      <ol className="flex items-stretch gap-1.5 rounded-2xl border border-line/70 bg-surface p-1.5 shadow-card">
        {WORKFLOW_STAGES.map((label, i) => {
          const done = allDone || i < current
          const now = !allDone && i === current
          return (
            <li
              key={label}
              aria-current={now ? 'step' : undefined}
              className={`flex min-w-0 items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium whitespace-nowrap ${now ? 'flex-[1.4] bg-brand-gradient text-white shadow-[0_8px_20px_-10px_rgb(79_70_229/0.8)]' : `flex-1 ${done ? 'text-brand-strong' : 'text-ink-muted'}`}`}
            >
              <span
                aria-hidden="true"
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${now ? 'bg-white/20 text-white ring-1 ring-white/50' : done ? 'bg-brand text-white' : 'bg-canvas text-ink-muted ring-1 ring-line'}`}
              >
                {done ? <Check className="size-4" /> : i + 1}
              </span>
              {/* Below 1024px only the current stage's name shows; the others are their numbers (their names stay for a screen reader). */}
              <span className={`min-w-0 truncate ${now ? '' : 'max-lg:sr-only'}`}>
                {label}
                <span className="sr-only">{done ? ' (done)' : now ? ' (current)' : ''}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
