import type { Encounter, HandwritingLatest } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Circle, CircleSlash, CircleX, FileText, LoaderCircle, Sparkles } from 'lucide-react'
import { memo, useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router'
import { type CheckLine, type CheckState, generateControl, manaReads, manaReadsText, modelRefusal, type NoteSaveState, preparingChecklist } from '../../lib/analysis.ts'
import { ApiError } from '../../lib/api.ts'
import { useConsultationAi, useGenerateDraft } from '../../lib/consult.ts'
import { handwritingQueryKey } from '../../lib/handwritingApi.ts'
import { Sheet } from '../hero/Sheet.tsx'
import { Button } from '../ui/Button.tsx'
import { runAnalysis, useAnalysis, useAnalysisInputFacts, useForgetEndedRun } from './analysisRun.ts'
import { ClinicalSummaryPreview, MultimodalFlow } from './MultimodalFlow.tsx'

/*
 * "Generate prescription" (DESIGN §5.5), the workspace's one primary action, in its bottom bar. A click saves the doctor's notes (the page's
 * save chain), then runs the fixed safety rules and asks the local model for its summary (runAnalysis), and opens "Preparing the
 * consultation": a centred sheet whose checklist ticks only on real state (lib/analysis.ts preparingChecklist). When the summary is ready (or
 * partly ready), or when the model cannot be asked at all, the prescription page opens by itself; [Open prescription] opens it at any time
 * (the page shows the summary's progress), [Continue consultation] closes the sheet and the summary goes on being made.
 */

/** performance.now(), read again every second while `ticking`. */
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

const MARK: Record<CheckState, { icon: typeof Check; cls: string; word: string }> = {
  done: { icon: Check, cls: 'text-ok', word: 'Done' },
  running: { icon: LoaderCircle, cls: 'text-ai motion-safe:animate-spin', word: 'In progress' },
  waiting: { icon: Circle, cls: 'text-line-strong', word: 'Not yet' },
  failed: { icon: CircleX, cls: 'text-down', word: 'Not done' },
  skipped: { icon: CircleSlash, cls: 'text-ink-muted', word: 'Not done' },
}

function Line({ l }: { l: CheckLine }) {
  const m = MARK[l.state]
  const Icon = m.icon
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2.5 py-1.5" data-testid="preparing-line" data-key={l.key} data-state={l.state}>
      <Icon aria-hidden="true" className={`mt-0.5 size-4 ${m.cls}`} />
      <div className="min-w-0 text-sm">
        <p className={l.state === 'waiting' ? 'text-ink-muted' : l.key === 'model' && l.state === 'running' ? 'text-ai' : 'text-ink'}>
          <span className="sr-only">{m.word}: </span>
          <span className="font-medium">{l.label}</span>
          {l.text && (
            <>
              <span aria-hidden="true" className="text-ink-muted">
                {' '}
                —{' '}
              </span>
              <span className={`tabular-nums ${l.state === 'done' ? 'text-ink' : 'text-ink-muted'}`}>{l.text}</span>
            </>
          )}
        </p>
        {l.note && <p className="mt-0.5 text-xs break-words text-ink-muted">{l.note}</p>}
      </div>
    </li>
  )
}

export interface GeneratePrescriptionProps {
  encounter: Encounter
  /** The page's save chain, resolving with the note's save state once nothing is pending. */
  flush: () => Promise<NoteSaveState>
  /** The note's save state now: the action is off only while the note cannot be saved at all. */
  save: NoteSaveState
  /** Where the prescription page of this consultation is. */
  prescriptionUrl: string
  /** Command (Mac) or Ctrl names the Ctrl/⌘+Enter shortcut. */
  mac: boolean
}

export function GeneratePrescription({ encounter, flush, save, prescriptionUrl, mac }: GeneratePrescriptionProps) {
  const id = encounter.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  // The page's owner of the consultation's AI state (the model's status, the newest draft) and the poller of a draft being made.
  const consultAi = useConsultationAi(id)
  const generate = useGenerateDraft(id)
  const { run, ai, active } = useAnalysis(id)
  useForgetEndedRun(id)
  const control = generateControl({ ai, running: active, save })
  const reasonId = useId()
  const [open, setOpen] = useState(false)
  const now = useTicking(open && active)

  const start = () => {
    setOpen(true)
    // A run or a draft already under way: its progress is shown again; nothing new is asked.
    if (active) return
    const refusal = modelRefusal(ai)
    void runAnalysis({
      encounterId: id,
      flush,
      qc,
      // The server already said the model cannot be asked: no request is made for a draft it would refuse.
      startDraft: refusal ? () => Promise.reject(new ApiError(0, 'not_asked', refusal)) : () => generate.mutateAsync(),
    })
  }

  const strokes = qc.getQueryData<HandwritingLatest>(handwritingQueryKey(id))?.strokeCount ?? null
  const prep = preparingChecklist({ save: run?.save ?? null, ask: run?.ask ?? null, ai, elapsedMs: run ? Math.max(0, now - run.clickedAt) : null, handwritingStrokes: strokes })
  const next = prep.next
  // Premium design: a ready draft is shown here first (its clinical summary, AI DRAFT) with [Review prescription]; only when there is no draft to
  // show (the model cannot be asked, or wrote nothing) does the prescription page open by itself while the sheet is open.
  const items = consultAi.data?.draft?.items ?? []
  const summaryReady = next === 'open' && items.length > 0
  useEffect(() => {
    if (open && next === 'open' && !summaryReady) navigate(prescriptionUrl)
  }, [open, next, summaryReady, navigate, prescriptionUrl])

  return (
    <>
      <Button
        icon={control.busy ? <LoaderCircle aria-hidden="true" className="size-5 motion-safe:animate-spin" /> : <Sparkles aria-hidden="true" className="size-5" />}
        disabled={control.disabled}
        aria-busy={control.busy || undefined}
        aria-describedby={control.reason ? reasonId : undefined}
        aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
        data-testid="analyze-mana"
        data-state={control.state}
        onClick={start}
      >
        {control.label}
      </Button>
      {control.reason && (
        <p id={reasonId} className="basis-full text-right text-xs text-ink-muted" data-testid="analyze-reason">
          {control.reason}
        </p>
      )}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Analyzing clinical context"
        subtitle="Bringing together the consultation’s inputs to create a clinician-reviewable summary"
        placement="center"
        width="xl"
        testId="preparing-consultation"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Continue consultation
            </Button>
            <Button icon={<FileText aria-hidden="true" className="size-4" />} onClick={() => navigate(prescriptionUrl)} data-testid="open-prescription">
              {summaryReady ? 'Review prescription' : 'Open prescription'}
            </Button>
          </>
        }
      >
        <MultimodalFlow prep={prep} />
        {summaryReady && <ClinicalSummaryPreview items={items} />}
        <ol aria-label="What Mana is given" className="mt-5 grid grid-cols-1 gap-x-6 border-t border-line/70 pt-2 sm:grid-cols-2 [&>li]:py-1 [&>li]:text-[0.8125rem]" data-testid="preparing-checklist">
          {prep.lines.map((l) => (
            <Line key={l.key} l={l} />
          ))}
        </ol>
        {/* The model's step in words, announced when it changes (the clock beside it is not announced every second). */}
        <p role="status" className="sr-only">
          {prep.announce}
        </p>
        <p className="mt-3 text-xs text-ink-muted">Mana drafts; nothing reaches the prescription without you. No percentage or time left is shown: neither is known.</p>
      </Sheet>
    </>
  )
}

/**
 * "Mana reads: 3 of 5 inputs" in the bottom bar: which of the five inputs a Generate prescription reads, from the page's own observers (no
 * request). Each input, read or not and why, is in its title and said to assistive technology.
 */
export const ManaReads = memo(function ManaReads({ encounter, typedNote }: { encounter: Pick<Encounter, 'id' | 'patient' | 'vitals'>; typedNote: boolean }) {
  const f = useAnalysisInputFacts(encounter)
  const inputs = manaReads({
    confirmedPoints: f.confirmedPoints,
    staffVitals: f.staffVitals,
    deviceReadings: f.deviceReadings,
    typedNote,
    approvedThermal: f.approvedThermal,
    thermalConsentWithdrawn: f.thermalConsentWithdrawn,
  })
  const list = inputs.map((i) => `${i.read ? 'Read' : 'Not read'}: ${i.label}, ${i.text}`).join('. ')
  return (
    <p className="text-sm text-ink-muted tabular-nums" title={inputs.map((i) => `${i.read ? '✓' : '—'} ${i.label}: ${i.text}`).join('\n')} data-testid="mana-reads">
      {manaReadsText(inputs)}
      <span className="sr-only">. {list}.</span>
    </p>
  )
})
