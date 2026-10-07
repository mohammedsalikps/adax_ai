import type { ConsultItem } from '@adaxai/contracts'
import { Activity, Check, ClipboardList, FileText, History, LoaderCircle, Mic, NotebookPen, Stethoscope, Thermometer } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'
import type { CheckLine, CheckState, Preparing } from '../../lib/analysis.ts'

/**
 * The multimodal flow of "Analyze & Generate Prescription" (premium design): the six inputs, joined by dotted lines into the ADAXAI clinical
 * context, then Mana AI, then the clinical summary, the prescription draft and "ready for review". It is a picture of what the page and the server
 * ACTUALLY hold, never a timer: an input ticks only when the server says what it sent to the model (the checklist's own lines); the context lights
 * when every input is settled; Mana's node shows the model's real state, token count and time since the click; the last steps light only when the
 * draft is ready. The only staging is the inputs' entrance (about 2.5 s, none with reduced motion). The stethoscope is recorded, never analysed.
 */

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>
type NodeKey = 'conversation' | 'history' | 'inputs' | 'stethoscope' | 'thermal' | 'notes'
const NODES: { key: NodeKey; label: string; sub: string; icon: Icon; tint: string }[] = [
  { key: 'conversation', label: 'Conversation', sub: 'Transcription', icon: Mic, tint: 'text-brand bg-brand-soft' },
  { key: 'history', label: 'Patient history', sub: 'The record', icon: History, tint: 'text-sky-600 bg-sky-50' },
  { key: 'inputs', label: 'Vitals', sub: 'Clinical data', icon: Activity, tint: 'text-rose-500 bg-rose-50' },
  { key: 'stethoscope', label: 'Stethoscope', sub: 'Audio', icon: Stethoscope, tint: 'text-teal-600 bg-teal-50' },
  { key: 'thermal', label: 'Thermal', sub: 'Image', icon: Thermometer, tint: 'text-orange-500 bg-orange-50' },
  { key: 'notes', label: 'Doctor’s note', sub: 'Clinical context', icon: NotebookPen, tint: 'text-ai bg-ai-soft' },
]

const settled = (s: CheckState | undefined) => s === 'done' || s === 'skipped' || s === 'failed'

function Tick({ state }: { state: CheckState | 'info' }) {
  if (state === 'done') return <Check aria-hidden="true" className="size-3.5 text-ok" />
  if (state === 'running') return <LoaderCircle aria-hidden="true" className="size-3.5 text-brand motion-safe:animate-spin" />
  return <span aria-hidden="true" className="size-1.5 rounded-full bg-line-strong" />
}

/** The ADAXAI mark in a disc: large and glowing for the clinical context, smaller for Mana. */
function Orb({ size, lit, busy, label, caption, gradient }: { size: 'lg' | 'md'; lit: boolean; busy: boolean; label: string; caption: string | null; gradient: string }) {
  const box = size === 'lg' ? 'size-24 text-4xl' : 'size-16 text-2xl'
  return (
    <div className="flex flex-col items-center text-center">
      <span className="relative inline-flex">
        {lit && busy && <span aria-hidden="true" className={`absolute inset-0 rounded-full bg-gradient-to-br ${gradient} opacity-40 blur-xl motion-safe:animate-pulse`} />}
        <span
          aria-hidden="true"
          className={`relative inline-flex ${box} items-center justify-center rounded-full font-bold text-white transition-all duration-700 motion-reduce:transition-none ${lit ? `bg-gradient-to-br ${gradient} shadow-[0_10px_30px_-8px_rgb(37_99_235/0.6)]` : 'bg-line-strong/70'}`}
        >
          A
        </span>
      </span>
      <p className={`mt-3 text-xs font-bold tracking-wide uppercase ${lit ? 'text-ink' : 'text-ink-muted'}`}>{label}</p>
      {caption && <p className="mt-0.5 max-w-52 text-xs text-ink-muted tabular-nums">{caption}</p>}
    </div>
  )
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
  const steps: { key: string; label: string; icon: Icon; state: 'waiting' | 'running' | 'done' }[] = [
    { key: 'summary', label: 'Clinical summary', icon: ClipboardList, state: modelDone ? 'done' : modelRunning ? 'running' : 'waiting' },
    { key: 'draft', label: 'Prescription draft', icon: FileText, state: modelDone ? 'done' : 'waiting' },
    { key: 'ready', label: 'Ready for review', icon: Check, state: modelDone ? 'done' : 'waiting' },
  ]
  return (
    <div data-testid="multimodal-flow">
      <ul className="grid grid-cols-3 gap-2.5 sm:grid-cols-6" aria-label="Consultation inputs">
        {NODES.map((n, i) => {
          const line = byKey.get(n.key)
          const state: CheckState | 'info' = n.key === 'stethoscope' ? 'info' : (line?.state ?? 'waiting')
          const text = n.key === 'stethoscope' ? 'Recorded · not analysed' : (line?.text ?? (state === 'waiting' ? 'Waiting…' : n.sub))
          const I = n.icon
          return (
            <li
              key={n.key}
              className={`flex min-w-0 flex-col items-center rounded-2xl border bg-surface px-2 py-3 text-center shadow-[0_1px_3px_rgb(15_23_42/0.05)] transition-all duration-300 motion-reduce:transition-none ${i < shown ? 'opacity-100 motion-safe:translate-y-0' : 'opacity-0 motion-safe:translate-y-1'} ${state === 'done' ? 'border-ok/30' : 'border-line/80'}`}
              data-node={n.key}
              data-state={state}
            >
              <span className={`inline-flex size-9 items-center justify-center rounded-xl ${n.tint}`}>
                <I aria-hidden="true" className="size-5" />
              </span>
              <span className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-ink">
                {n.label}
                <Tick state={state} />
              </span>
              <span className="mt-0.5 line-clamp-2 text-[0.6875rem] leading-4 text-ink-muted">{text}</span>
            </li>
          )
        })}
      </ul>
      {/* The six inputs joined into the clinical context (drawn; the order of things is in the lists for assistive technology). */}
      <svg aria-hidden="true" viewBox="0 0 600 70" preserveAspectRatio="none" className="h-14 w-full">
        {NODES.map((_, i) => (
          <path
            key={i}
            d={`M ${50 + i * 100} 0 C ${50 + i * 100} 40, 150 30, 150 70`}
            fill="none"
            stroke={inputsSettled ? 'rgb(37 99 235 / 0.55)' : 'rgb(148 163 184 / 0.6)'}
            strokeWidth="1.5"
            strokeDasharray="3 5"
            vectorEffect="non-scaling-stroke"
            className={inputsSettled ? '' : 'motion-safe:animate-[dash_1.2s_linear_infinite]'}
          />
        ))}
      </svg>
      <ol className="grid grid-cols-1 items-center gap-6 sm:grid-cols-[1fr_auto_1fr_1fr]" aria-label="What happens with them">
        <li data-stage="context" data-lit={inputsSettled || undefined}>
          <Orb size="lg" lit={inputsSettled} busy={!modelDone} label="ADAXAI clinical context" caption={inputsSettled ? 'All inputs combined' : 'Combining all inputs…'} gradient="from-brand to-indigo-600" />
        </li>
        <li aria-hidden="true" className="hidden sm:block">
          <svg viewBox="0 0 80 10" className="h-3 w-20">
            <line x1="0" y1="5" x2="72" y2="5" stroke="rgb(124 58 237 / 0.55)" strokeWidth="1.5" strokeDasharray="4 4" />
            <path d="M 70 1 L 78 5 L 70 9" fill="none" stroke="rgb(124 58 237 / 0.7)" strokeWidth="1.5" />
          </svg>
        </li>
        <li data-stage="mana" data-lit={modelRunning || modelDone || undefined}>
          <Orb size="md" lit={modelRunning || modelDone} busy={modelRunning} label="Mana AI" caption={model ? [model.label, model.text].filter(Boolean).join(' · ') : null} gradient="from-ai to-brand" />
        </li>
        <li>
          <ul className="space-y-3" aria-label="Then">
            {steps.map((s) => {
              const I = s.icon
              return (
                <li key={s.key} className="flex items-center gap-2.5 text-sm" data-stage={s.key} data-lit={s.state === 'done' || undefined}>
                  <span className={`inline-flex size-7 items-center justify-center rounded-full ${s.state === 'done' ? 'bg-ok-soft text-ok' : s.state === 'running' ? 'bg-brand-soft text-brand' : 'bg-canvas text-ink-muted'}`}>
                    {s.state === 'running' ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <I aria-hidden="true" className="size-4" />}
                  </span>
                  <span className={s.state === 'waiting' ? 'text-ink-muted' : 'font-medium text-ink'}>{s.label}</span>
                </li>
              )
            })}
          </ul>
        </li>
      </ol>
    </div>
  )
}

/** The statements of Mana's ready draft, a few lines (AI DRAFT, for the doctor's review on the prescription page). */
export function ClinicalSummaryPreview({ items }: { items: ConsultItem[] }) {
  const shown = items.filter((i) => i.decision !== 'rejected').slice(0, 6)
  if (!shown.length) return null
  return (
    <section aria-label="Clinical summary" className="mt-5 rounded-2xl border border-ai/20 bg-ai-soft/50 px-5 py-4" data-testid="analysis-summary">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        Clinical summary
        <span className="rounded-md border border-ai/30 bg-surface px-1.5 py-px text-[0.625rem] font-bold tracking-wide text-ai">AI DRAFT</span>
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink">
        {shown.map((i) => (
          <li key={i.id}>{i.finalText ?? i.text}</li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-ink-muted">Written by Mana from the consultation and the record; you review, edit or remove each statement on the prescription page.</p>
    </section>
  )
}
