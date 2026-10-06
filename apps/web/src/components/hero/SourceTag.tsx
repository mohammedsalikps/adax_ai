import type { ReactNode } from 'react'
import { type SourceKind, type SourceTagSpec, sourceTagSpec } from './spec.ts'

const LOOK: Record<SourceTagSpec['look'], string> = {
  neutral: 'border-line bg-canvas text-ink-muted',
  // An unverified device: a solid edge (a simulator's is dashed), so the two are never taken for each other.
  'outline-pending': 'border-pending/60 bg-surface text-pending',
  // The simulated look of the device and stethoscope cards (a dashed edge), quieter: muted ink, so it is subtle but never missed.
  dashed: 'border-dashed border-ink-muted/60 bg-surface text-ink-muted',
  ai: 'border-ai/30 bg-ai-soft text-ai',
}

export interface SourceTagProps {
  kind: SourceKind
  /** Replaces the default words (e.g. "SIMULATED AUDIO"; keep the exact existing marks). */
  children?: ReactNode
  className?: string
  testId?: string
}

/**
 * Where a value came from, said subtly and next to the value (DESIGN §1): Staff (neutral) · Device · UNVERIFIED (pending outline) ·
 * SIMULATED (dashed, muted) · AI DRAFT (the AI's violet) · Fixed rules · From the record (neutral). Simulated is never shown as real: every
 * simulated value carries this tag where it appears. The default words are `sourceTagSpec` in ./spec.ts. `data-source` carries the kind.
 */
export function SourceTag({ kind, children, className = '', testId }: SourceTagProps) {
  const spec = sourceTagSpec(kind)
  return (
    <span
      data-source={kind}
      data-testid={testId}
      className={`inline-flex items-center rounded-md border px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide whitespace-nowrap ${LOOK[spec.look]} ${className}`}
    >
      {children ?? spec.label}
    </span>
  )
}
