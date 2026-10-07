import type { Encounter } from '@adaxai/contracts'
import { Mic, Send, Sparkles } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Panel } from '../hero/Panel.tsx'
import { ManaAssistant } from './ManaAssistant.tsx'

/** The one-tap questions of the docked Mana (jury design, screen 3). Each is answered from the records by fixed rules (instant, no model). */
export const MANA_PANEL_CHIPS = [
  'Summarize this patient’s previous history.',
  'Summarize today’s consultation',
  'Show recent lab reports',
  'Any pending orders?',
] as const

/**
 * Mana docked in the consultation workspace (jury design, screen 3: "Mana — Your clinical AI assistant"). Until the doctor uses it, it shows its
 * one-tap questions and a question box and asks nothing of the server; the first question opens the conversation of this consultation (the same
 * one the floating Mana shows) and is asked at once. The answers, their sources, the voice button and the approve flow for a proposed medicine
 * are the global Mana's own (ManaAssistant, sheet variant): read-only, draft-only, never signing or completing anything.
 */
export function ManaPanel({ encounter, className = '' }: { encounter: Encounter; className?: string }) {
  const [opened, setOpened] = useState(false)
  const [first, setFirst] = useState<string | null>(null)
  const [text, setText] = useState('')
  const start = (q: string) => {
    if (q.trim().length < 2) return
    setFirst(q.trim())
    setOpened(true)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    start(text)
  }
  return (
    <Panel
      label="Mana"
      icon={Sparkles}
      testId="mana-panel"
      className={className}
      actions={<span className="text-xs text-ink-muted">Your clinical AI assistant</span>}
      bodyClassName={opened ? 'flex h-[30rem] min-h-0 flex-col overflow-hidden px-0 pb-0' : 'px-4 pt-1 pb-4 xl:px-5'}
    >
      {opened ? (
        <ManaAssistant variant="sheet" encounterId={encounter.id} patientId={encounter.patient.id} pendingAsk={first} onAsked={() => setFirst(null)} />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">Ask about this patient’s record, today’s consultation, results or orders. Answers come from the records; nothing is changed.</p>
          <div className="flex flex-col items-start gap-2" role="group" aria-label="Suggested questions" data-testid="mana-panel-chips">
            {MANA_PANEL_CHIPS.map((q) => (
              <button key={q} type="button" onClick={() => start(q)} className="rounded-xl border border-brand/25 bg-brand-soft px-3 py-2 text-left text-sm font-medium text-brand-strong transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand">
                {q.replace(/\.$/, '')}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-1.5 focus-within:border-brand">
            <label className="sr-only" htmlFor={`mana-panel-input-${encounter.id}`}>
              Ask Mana
            </label>
            <input
              id={`mana-panel-input-${encounter.id}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask Mana…"
              maxLength={500}
              className="min-h-9 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
              data-testid="mana-panel-input"
            />
            <button type="button" onClick={() => setOpened(true)} className="inline-flex size-9 items-center justify-center rounded-lg text-ink-muted hover:bg-canvas" aria-label="Open Mana to ask by voice">
              <Mic aria-hidden="true" className="size-4" />
            </button>
            <button type="submit" disabled={text.trim().length < 2} className="inline-flex size-9 items-center justify-center rounded-lg bg-brand text-white disabled:opacity-50" aria-label="Ask">
              <Send aria-hidden="true" className="size-4" />
            </button>
          </form>
        </div>
      )}
    </Panel>
  )
}
