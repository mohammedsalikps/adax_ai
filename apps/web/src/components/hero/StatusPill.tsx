import { type HeroStatus, type HeroTone, statusPillSpec } from './spec.ts'

const TONE: Record<HeroTone, string> = {
  ok: 'border-ok/20 bg-ok-soft text-ok',
  pending: 'border-pending/20 bg-pending-soft text-pending',
  notice: 'border-notice/20 bg-notice-soft text-notice',
  brand: 'border-brand/25 bg-brand-soft text-brand-strong',
  neutral: 'border-line bg-canvas text-ink-muted',
}

export interface StatusPillProps {
  status: HeroStatus
  /** Replaces the default word (e.g. "Signed — to complete" said differently); the tone stays the status'. */
  label?: string
  className?: string
}

/**
 * The one status pill of the doctor's app (DESIGN §1): a dot and a word, never colour alone. Completed (ok) · Waiting (pending) ·
 * In consultation (notice) · Yet to see (neutral) · Signed — to complete (brand) · Draft (neutral) · Cancelled (neutral). The mapping is
 * `statusPillSpec` in ./spec.ts (unit-tested). `data-status` carries the status for tests.
 */
export function StatusPill({ status, label, className = '' }: StatusPillProps) {
  const spec = statusPillSpec(status)
  return (
    <span data-status={status} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[spec.tone]} ${className}`}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {label ?? spec.label}
    </span>
  )
}
