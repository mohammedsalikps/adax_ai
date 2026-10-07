import { CircleCheck, CircleDashed, CircleDot, Clock3, FilePen, PenLine, Stethoscope, type LucideIcon } from 'lucide-react'
import { type HeroStatus, type HeroTone, statusPillSpec } from './spec.ts'

const TONE: Record<HeroTone, string> = {
  ok: 'border-ok/15 bg-ok-soft/80 text-ok',
  pending: 'border-pending/15 bg-pending-soft/80 text-pending',
  notice: 'border-notice/15 bg-notice-soft text-notice',
  brand: 'border-brand/20 bg-brand-soft text-brand-strong',
  neutral: 'border-line bg-canvas text-ink-muted',
}

/** UI/UX redesign: each status has its own small icon beside the word (still never colour alone). */
const ICON: Partial<Record<HeroStatus, LucideIcon>> = {
  completed: CircleCheck,
  waiting: Clock3,
  in_consultation: Stethoscope,
  yet_to_see: CircleDashed,
  signed_to_complete: PenLine,
  draft: FilePen,
}

export interface StatusPillProps {
  status: HeroStatus
  /** Replaces the default word (e.g. "Signed — to complete" said differently); the tone stays the status'. */
  label?: string
  className?: string
}

/**
 * The one status pill of the doctor's app (DESIGN §1): an icon and a word, never colour alone. Completed (ok) · Waiting (pending) ·
 * In consultation (notice) · Yet to see (neutral) · Signed — to complete (brand) · Draft (neutral) · Cancelled (neutral). The mapping is
 * `statusPillSpec` in ./spec.ts (unit-tested). `data-status` carries the status for tests.
 */
export function StatusPill({ status, label, className = '' }: StatusPillProps) {
  const spec = statusPillSpec(status)
  const Icon = ICON[status] ?? CircleDot
  return (
    <span data-status={status} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-none font-semibold whitespace-nowrap ${TONE[spec.tone]} ${className}`}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label ?? spec.label}
    </span>
  )
}
