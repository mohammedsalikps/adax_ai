import { ArrowRight, Check, CircleSlash, ClipboardList, FileText, History, LoaderCircle, Mic, NotebookPen, Sparkles, Stethoscope, Thermometer, Activity, Layers } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'
import type { CheckLine, CheckState, Preparing } from '../../lib/analysis.ts'

/**
 * The multimodal flow of "Analyze & Generate Prescription" (jury design §29): the consultation's inputs flow into the clinical context, then
 * Mana (the local model), then the clinical summary and the prescription draft. It is a picture of what the page and the server ACTUALLY hold,
 * never a timer: each input ticks only when the server says what it sent to the model (the checklist's own lines); the context lights when every
 * input is settled; Mana's stage shows the model's real state, token count and time since the click; the summary and the draft light only when
 * the draft is ready. The only staging is the inputs' entrance (about 2.5 s, none with reduced motion). The stethoscope is recorded, never analysed.
 */

type NodeKey = 'conversation' | 'history' | 'inputs' | 'stethoscope' | 'thermal' | 'notes'
const NODES: { key: NodeKey; label: string; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }> }[] = [
  { key: 'conversation', label: 'Conversation', icon: Mic },
  { key: 'history', label: 'Patient history', icon: History },
  { key: 'inputs', label: 'Clinical vitals', icon: Activity },
  { key: 'stethoscope', label: 'Stethoscope', icon: Stethoscope },
  { key: 'thermal', label: 'Thermal image', icon: Thermometer },
  { key: 'notes', label: 'Doctor’s note', icon: NotebookPen },
]

const settled = (s: CheckState | undefined) => s === 'done' || s === 'skipped' || s === 'failed'

function StateIcon({ state }: { state: CheckState | 'info' }) {
  if (state === 'done') return <Check aria-hidden="true" className="size-4 text-ok" />
  if (state === 'running') return <LoaderCircle aria-hidden="true" className="size-4 text-brand motion-safe:animate-spin" />
  if (state === 'skipped' || state === 'info') return <CircleSlash aria-hidden="true" className="size-4 text-ink-muted" />
  if (state === 'failed') return <CircleSlash aria-hidden="true" className="size-4 text-down" />
  return <span aria-hidden="true" className="size-2 rounded-full bg-line-strong" />
}

export function MultimodalFlow({ prep }: { prep: Preparing }) {
  const byKey = new Map<string, CheckLine>(prep.lines.map((l) => [l.key, l]))
  // The inputs' entrance: one by one, ~400 ms apart (visual staging only; their ticks come from the real lines).
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (shown >= NODES.length) return
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 150 : 400)
    return () => clearTimeout(t)
  }, [shown])
  const model = byKey.get('model')
  const inputsSettled = NODES.every((n) => n.key === 'stethoscope' || settled(byKey.get(n.key)?.state))
  const modelRunning = model?.state === 'running'
  const modelDone = model?.state === 'done'
  const stages: { key: string; label: string; detail: string | null; lit: boolean; busy: boolean; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }> }[] = [
    { key: 'context', label: 'ADAXAI Clinical Context', detail: inputsSettled ? 'Inputs combined' : 'Collecting inputs…', lit: inputsSettled, busy: !inputsSettled, icon: Layers },
    { key: 'mana', label: 'Mana AI', detail: model ? [model.label, model.text].filter(Boolean).join(' · ') : null, lit: modelRunning || modelDone, busy: modelRunning, icon: Sparkles },
    { key: 'summary', label: 'Clinical summary', detail: modelDone ? 'Clinical summary ready' : null, lit: modelDone, busy: false, icon: ClipboardList },
    { key: 'draft', label: 'Prescription draft', detail: modelDone ? 'Prescription ready for doctor review' : null, lit: modelDone, busy: false, icon: FileText },
  ]
  return (
    <div className="space-y-4" data-testid="multimodal-flow">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Consultation inputs">
        {NODES.map((n, i) => {
          const line = byKey.get(n.key)
          const state: CheckState | 'info' = n.key === 'stethoscope' ? 'info' : (line?.state ?? 'waiting')
          const text = n.key === 'stethoscope' ? 'Recorded · not analysed' : (line?.text ?? (state === 'waiting' ? 'Waiting…' : ''))
          const Icon = n.icon
          return (
            <li
              key={n.key}
              className={`flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2 transition-all duration-300 motion-reduce:transition-none ${i < shown ? 'opacity-100 motion-safe:translate-y-0' : 'opacity-0 motion-safe:translate-y-1'} ${state === 'done' ? 'border-ok/30 bg-ok-soft/40' : 'border-line bg-surface'}`}
              data-node={n.key}
              data-state={state}
            >
              <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {n.label}
                  <StateIcon state={state} />
                </span>
                <span className="block text-xs text-ink-muted">{text}</span>
              </span>
            </li>
          )
        })}
      </ul>
      <div aria-hidden="true" className="mx-auto h-5 w-px bg-gradient-to-b from-line-strong to-brand/60" />
      <ol className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4" aria-label="What happens with them">
        {stages.map((s, i) => {
          const Icon = s.icon
          return (
            <li key={s.key} className="relative flex min-w-0" data-stage={s.key} data-lit={s.lit || undefined}>
              {/* The arrow from the stage before, drawn in the gap (not on a phone's second row). */}
              {i > 0 && <ArrowRight aria-hidden="true" className={`absolute top-1/2 -left-[1.15rem] size-3.5 -translate-y-1/2 text-ink-muted ${i === 2 ? 'hidden sm:block' : ''}`} />}
              <span
                className={`flex w-full min-w-0 flex-col rounded-xl border px-3 py-2 transition-colors duration-500 motion-reduce:transition-none ${s.lit ? 'border-brand/40 bg-brand-soft text-brand-strong' : 'border-line bg-canvas text-ink-muted'} ${s.busy && s.key === 'mana' ? 'motion-safe:animate-pulse' : ''}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0">{s.label}</span>
                </span>
                {s.detail && <span className="mt-0.5 text-xs tabular-nums [overflow-wrap:anywhere]">{s.detail}</span>}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
