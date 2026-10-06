import type { DoctorDayTimelineRow } from '@adaxai/contracts'
import { FileCheck2, FileText, Stethoscope } from 'lucide-react'
import { Link, useNavigate } from 'react-router'
import { errorMessage } from '../../lib/api.ts'
import { TODAY_ACTION_LABELS, todayAction, todayActionHref } from '../../lib/doctorDay.ts'
import { useStartConsultation } from '../../lib/encounters.ts'
import { Button } from '../ui/Button.tsx'
import { useToast } from '../ui/Toast.tsx'

/** A link drawn as a small secondary button (Open, Complete): the same size and focus ring as Button size sm. */
const LINK_BUTTON = 'inline-flex min-h-control-sm items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium whitespace-nowrap transition-colors'

/**
 * The one action of a row of today's patients (lib/doctorDay.ts todayAction): Start consultation (a new start opens the workspace with
 * recording armed), Continue consultation (resume my paused draft, or open my consultation in progress), Complete (my signed consultation, on
 * the prescription page), Open (the record). Nothing for a patient who has not arrived.
 */
export function TodayAction({ row }: { row: DoctorDayTimelineRow }) {
  const start = useStartConsultation()
  const toast = useToast()
  const navigate = useNavigate()
  const kind = todayAction(row)
  if (!kind) return null
  const label = TODAY_ACTION_LABELS[kind]
  if ((kind === 'start' || kind === 'resume') && row.visitId) {
    const visitId = row.visitId
    return (
      <Button
        size="sm"
        icon={<Stethoscope aria-hidden="true" className="size-4" />}
        loading={start.isPending}
        // The row says whether there is a consultation (null: none), so only a real new start arms recording.
        onClick={() => start.mutate({ visitId, encounterId: row.encounterId }, { onError: (e) => toast('error', errorMessage(e)) })}
      >
        {label}
      </Button>
    )
  }
  if (!row.encounterId) return null
  if (kind === 'continue') {
    const href = todayActionHref('continue', row.encounterId)
    return (
      <Button size="sm" icon={<Stethoscope aria-hidden="true" className="size-4" />} onClick={() => navigate(href)}>
        {label}
      </Button>
    )
  }
  if (kind === 'complete') {
    return (
      <Link to={todayActionHref('complete', row.encounterId)} className={`${LINK_BUTTON} border-brand/30 bg-brand-soft text-brand-strong hover:bg-brand/15`}>
        <FileCheck2 aria-hidden="true" className="size-4" />
        {label}
        <span className="sr-only"> the consultation of {row.patient.fullName}</span>
      </Link>
    )
  }
  return (
    <Link to={todayActionHref('open', row.encounterId)} className={`${LINK_BUTTON} border-line-strong bg-surface text-ink hover:bg-canvas`}>
      <FileText aria-hidden="true" className="size-4" />
      {label}
      <span className="sr-only"> the record of {row.patient.fullName}</span>
    </Link>
  )
}
