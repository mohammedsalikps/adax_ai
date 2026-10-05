import {
  MANA_PHASE_LABEL,
  MANA_QUESTIONS,
  MANA_SOURCE_KINDS,
  MANA_UNAVAILABLE,
  type ManaAnswerBlock,
  type ManaAnswerBody,
  type ManaAnswerSource,
  type ManaConversationState,
  type ManaEntity,
  type ManaFinding,
  type ManaMessage,
  type ManaQuestion,
  type ManaSourceItem,
} from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, FileText, LoaderCircle, MessageSquarePlus, RotateCcw, Send, ShieldAlert, Sparkles, Square, TriangleAlert } from 'lucide-react'
import { type FormEvent, Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../../lib/api.ts'
import { usePortalBase } from '../../lib/clinical.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import { manaConversationKey, type ManaScope, pendingMessage, useAskMana, useCancelMana, useManaConversation, useNewManaConversation, useSelectManaPatient } from '../../lib/manaAssistant.ts'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, type BadgeTone } from '../ui/Feedback.tsx'

const FINDING: Record<ManaFinding['kind'], { tone: BadgeTone; label: string }> = {
  conflict: { tone: 'down', label: 'Records disagree' },
  outdated: { tone: 'warn', label: 'Possibly outdated' },
  absent: { tone: 'neutral', label: 'Not in the records' },
  untrusted: { tone: 'warn', label: 'Unusual text, not used' },
}

const BLOCK_FLAG: Record<ManaAnswerBlock['flags'][number], { tone: BadgeTone; label: string }> = {
  involves_conflict: { tone: 'down', label: 'Records disagree' },
  record_outdated: { tone: 'warn', label: 'Only old records' },
  wording_differs: { tone: 'warn', label: 'Check the wording against the sources' },
  sources_added: { tone: 'warn', label: 'Also rests on another record: check the sources' },
}

/** A statement with the patients' handles (P1) put back as their names: the model never saw the names, the doctor should not have to read handles. */
function WithNames({ text, entities }: { text: string; entities: ManaEntity[] }) {
  const parts = text.split(/\b(P\d{1,2})\b/)
  return (
    <>
      {parts.map((p, i) => {
        const e = i % 2 === 1 ? entities.find((x) => x.alias === p) : undefined
        return e ? (
          <strong key={i} className="font-semibold" title={`${e.displayName} · MRN ${e.mrn}`}>
            {e.displayName}
          </strong>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      })}
    </>
  )
}

/**
 * Whom the answer is about, written by the server from the records that were read (not from what the model wrote): the name, the MRN, age and sex. An answer
 * that is about a patient always says which one, so that a name that was taken for another patient's is seen at once.
 */
function About({ subjects }: { subjects: ManaEntity[] }) {
  if (!subjects.length) return null
  return (
    <p className="mb-2 rounded-md bg-surface px-2 py-1 text-xs text-ink-muted" data-testid="mana-subjects">
      About{' '}
      {subjects.map((e, i) => (
        <Fragment key={e.alias}>
          {i > 0 && '; '}
          <strong className="font-semibold text-ink">{e.displayName}</strong> · MRN {e.mrn} · {e.ageSex}
        </Fragment>
      ))}
    </p>
  )
}

/** One record a statement rests on: what it is in words, when, in what state, what it says, and where to open it. */
function SourceItemCard({ item }: { item: ManaSourceItem }) {
  const base = usePortalBase()
  const link = item.link ? (item.link.to === 'encounter' ? `${base}/encounters/${item.link.id}` : `${base}/patients/${item.link.id}`) : null
  return (
    <li className="rounded-md border border-line bg-canvas px-2.5 py-2 text-xs">
      <p className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral" icon={<FileText aria-hidden="true" className="size-3" />}>
          {MANA_SOURCE_KINDS[item.kind]}
        </Badge>
        <span className="font-medium">{item.label}</span>
        {item.status && <Badge tone={/draft|not signed/i.test(item.status) ? 'warn' : 'notice'}>{item.status}</Badge>}
      </p>
      <p className="mt-1 [overflow-wrap:anywhere]">“{item.excerpt}”</p>
      {link && (
        <Link to={link} className="mt-1 inline-block font-medium text-brand-strong underline underline-offset-2">
          {item.link!.to === 'encounter' ? 'Open consultation' : 'Open patient record'}
        </Link>
      )}
    </li>
  )
}

function SourceBox({ s, entities }: { s: ManaAnswerSource; entities: ManaEntity[] }) {
  return (
    <div className="mt-1.5 rounded-lg border border-line p-2" data-testid={`mana-source-${s.ref}`}>
      <p className="text-xs">
        <span className="font-mono text-ink-muted">{s.ref}</span> <WithNames text={s.text} entities={entities} />
      </p>
      {s.items.length > 0 && (
        <ul className="mt-1.5 space-y-1.5" aria-label={`Records behind ${s.ref}`}>
          {s.items.map((it, i) => (
            <SourceItemCard key={i} item={it} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** The short name of a source on its chip: the record in words ("Allergy · 1 Sep 2026"), not an id. */
const chipLabel = (s: ManaAnswerSource) => s.items[0]?.label ?? s.label

function Block({ b, sources, entities }: { b: ManaAnswerBlock; sources: ManaAnswerSource[]; entities: ManaEntity[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const cited = b.refs.flatMap((r) => (sources.find((s) => s.ref === r) ? [sources.find((s) => s.ref === r)!] : []))
  return (
    <li className="text-sm" data-testid="mana-block">
      <p>
        <WithNames text={b.text} entities={entities} />
      </p>
      {b.flags.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-1">
          {b.flags.map((f) => (
            <Badge key={f} tone={BLOCK_FLAG[f].tone} wrap>
              {BLOCK_FLAG[f].label}
            </Badge>
          ))}
        </p>
      )}
      {cited.length > 0 && (
        <div className="mt-1.5">
          <ul className="flex flex-wrap gap-1.5" aria-label="Sources of this statement">
            {cited.map((s) => (
              <li key={s.ref}>
                <button
                  type="button"
                  aria-expanded={open === s.ref}
                  onClick={() => setOpen(open === s.ref ? null : s.ref)}
                  data-testid="mana-source-chip"
                  className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-brand/30 bg-brand-soft px-2.5 text-xs font-medium text-brand-strong transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                >
                  <FileText aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{chipLabel(s)}</span>
                  {open === s.ref ? <ChevronUp aria-hidden="true" className="size-3 shrink-0" /> : <ChevronDown aria-hidden="true" className="size-3 shrink-0" />}
                </button>
              </li>
            ))}
          </ul>
          {open && sources.find((s) => s.ref === open) && <SourceBox s={sources.find((s) => s.ref === open)!} entities={entities} />}
        </div>
      )}
    </li>
  )
}

function Findings({ findings, entities }: { findings: ManaFinding[]; entities: ManaEntity[] }) {
  if (!findings.length) return null
  return (
    <ul className="mt-2 space-y-2" aria-label="What the records show, found by rule" data-testid="mana-findings">
      {findings.map((f) => (
        <li key={f.ref} className="rounded-lg border border-line bg-surface p-2 text-sm" data-testid={`mana-finding-${f.kind}`}>
          <Badge tone={FINDING[f.kind].tone}>{FINDING[f.kind].label}</Badge>
          <p className="mt-1">
            <WithNames text={f.text} entities={entities} />
          </p>
          {f.items.length > 0 && (
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-ink-muted">Records ({f.items.length})</summary>
              <ul className="mt-1 space-y-1.5">
                {f.items.map((it, i) => (
                  <SourceItemCard key={i} item={it} />
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}

function AllSources({ a }: { a: ManaAnswerBody }) {
  if (!a.sources.length) return null
  const read = a.sources.filter((s) => !s.cited).length
  return (
    <details className="mt-2 text-xs" data-testid="mana-all-sources">
      <summary className="cursor-pointer text-ink-muted">
        Records read for this answer ({a.sources.length}
        {read ? `, ${read} not used` : ''})
      </summary>
      <div className="mt-1 space-y-1">
        {a.sources.map((s) => (
          <div key={s.ref}>
            <SourceBox s={s} entities={a.entities} />
            {!s.cited && <p className="ml-1 text-ink-muted">Read, and not used in the answer.</p>}
          </div>
        ))}
      </div>
    </details>
  )
}

function Candidates({ a, onSelect, disabled }: { a: ManaAnswerBody; onSelect: (alias: string) => void; disabled: boolean }) {
  return (
    <ul className="mt-2 space-y-1.5" aria-label="Patients Mana found" data-testid="mana-candidates">
      {a.candidates.map((c) => (
        <li key={c.alias}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(c.alias)}
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand disabled:opacity-60"
          >
            <span className="block font-semibold">{c.displayName}</span>
            <span className="block text-xs text-ink-muted">
              MRN {c.mrn} · {c.ageSex}
              {c.lastVisit ? ` · last visit ${fmtDate(c.lastVisit)}` : ' · no visit on record'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ManaMessageView({ m, question, onSelect, onRetry, busy, current }: { m: ManaMessage; question: string | null; onSelect: (alias: string) => void; onRetry: (text: string) => void; busy: boolean; current: boolean }) {
  const a = m.answer
  // The button is on a line of its own (inside an alert it would otherwise sit at the end of the last line of text).
  const retry = question ? (
    <div className="mt-2">
      <Button size="sm" variant="secondary" icon={<RotateCcw aria-hidden="true" className="size-4" />} disabled={busy} onClick={() => onRetry(question)}>
        Ask again
      </Button>
    </div>
  ) : null
  if (m.status === 'pending') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-ink-muted" data-testid="mana-working">
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        {m.phase ? MANA_PHASE_LABEL[m.phase] : 'Working'}…
      </p>
    )
  }
  if (m.status === 'unavailable') {
    return (
      <Alert tone="warning" title={MANA_UNAVAILABLE} live={false}>
        <span data-testid="mana-unavailable">Nothing was made up. Try again when the local model is running.</span>
        {retry}
      </Alert>
    )
  }
  if (m.status === 'failed') {
    return (
      <Alert tone="error" title="Mana could not answer" live={false}>
        <span data-testid="mana-error">{m.error?.message ?? 'Something went wrong.'}</span>
        {m.error?.retryable && retry}
      </Alert>
    )
  }
  if (m.status === 'cancelled') {
    return (
      <Alert tone="info" title="Stopped" live={false}>
        {m.error?.message ?? 'This question was stopped.'}
        {retry}
      </Alert>
    )
  }
  if (!a) return null
  return (
    <div data-testid="mana-answer" data-outcome={a.outcome} data-status={m.status}>
      <About subjects={a.subjects} />
      {m.status === 'unverified' && (
        <Alert tone="warning" title={a.notice ?? ''} live={false}>
          <span data-testid="mana-unverified">Nothing it wrote is shown. What the records say, found by rule, and the records that were read are below.</span>
        </Alert>
      )}
      {a.outcome === 'refused' && (
        <Alert tone="info" title="Mana did not do that" live={false}>
          <span data-testid="mana-refusal">{a.notice}</span>
        </Alert>
      )}
      {(a.outcome === 'clarify' || a.outcome === 'ambiguous') && (
        <p className="text-sm" data-testid="mana-clarify">
          <WithNames text={a.notice ?? ''} entities={a.entities} />
        </p>
      )}
      {a.outcome === 'ambiguous' && <Candidates a={a} onSelect={onSelect} disabled={busy || !current} />}
      {a.outcome === 'clarify' && a.candidates.length > 0 && <Candidates a={a} onSelect={onSelect} disabled={busy || !current} />}
      {a.outcome === 'not_established' && m.status !== 'unverified' && (
        <p className="flex items-start gap-1.5 text-sm" data-testid="mana-not-established">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <span>{a.notice}</span>
        </p>
      )}
      {a.blocks.length > 0 && (
        <ul className="space-y-2.5" aria-label="Mana’s answer">
          {a.blocks.map((b, i) => (
            <Block key={i} b={b} sources={a.sources} entities={a.entities} />
          ))}
        </ul>
      )}
      {a.removed > 0 && m.status !== 'unverified' && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-pending" data-testid="mana-removed">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {a.removed === 1 ? '1 statement' : `${a.removed} statements`} could not be checked against the records and {a.removed === 1 ? 'was' : 'were'} not shown.
        </p>
      )}
      <Findings findings={a.findings} entities={a.entities} />
      <AllSources a={a} />
      {m.model && (
        <details className="mt-2 text-xs text-ink-muted" data-testid="mana-details">
          <summary className="cursor-pointer">How this was made</summary>
          <p className="mt-1">
            {m.model.provider} · {m.model.model} · {m.model.local ? 'runs on this computer' : 'does not run on this computer'}
            {m.model.planPrompt && ` · plan ${m.model.planPrompt}`}
            {m.model.answerPrompt && ` · answer ${m.model.answerPrompt}`} · {m.model.tools}
          </p>
          {m.tools.length > 0 && (
            <p>
              Looked up: {m.tools.map((t) => `${t.tool.replace(/^get_/, '').replace(/_/g, ' ')} (${t.status.replace('_', ' ')})`).join(', ')}
            </p>
          )}
          {m.completedAt && <p>{fmtDateTime(m.completedAt)}</p>}
        </details>
      )}
    </div>
  )
}

const SUGGESTIONS = Object.entries(MANA_QUESTIONS) as [ManaQuestion, (typeof MANA_QUESTIONS)[ManaQuestion]][]

/** What assistive technology is told when an answer arrives: what happened, not the whole answer (which is in the conversation to be read). */
function announcement(m: ManaMessage): string {
  switch (m.status) {
    case 'unverified':
      return 'Mana could not safely verify that response.'
    case 'refused':
      return 'Mana did not do that.'
    case 'unavailable':
      return 'Mana is currently unavailable.'
    case 'failed':
      return 'Mana could not answer.'
    case 'cancelled':
      return 'The question was stopped.'
    case 'ready':
      return m.answer?.outcome === 'clarify' || m.answer?.outcome === 'ambiguous' ? 'Mana needs you to choose or to say more.' : m.answer?.outcome === 'not_established' ? 'Mana found nothing established in the records.' : 'Mana answered.'
    default:
      return ''
  }
}

/**
 * Mana AI, the doctor's clinical assistant. A conversation with the clinic's records: the doctor asks, the server works out what to look up, reads only what
 * the doctor may see, and a local model writes the answer from what was read; every statement shows the records it rests on. It is read-only. It is closed
 * until the doctor opens it, and nothing is asked of the server before that.
 */
export function ManaAssistant({ encounterId, patientId, defaultOpen = false }: ManaScope & { defaultOpen?: boolean }) {
  const scope: ManaScope = { encounterId, patientId }
  const [open, setOpen] = useState(defaultOpen)
  const conv = useManaConversation(scope, open)
  const ask = useAskMana(scope)
  const select = useSelectManaPatient(scope)
  const cancel = useCancelMana(scope)
  const fresh = useNewManaConversation(scope)
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [announce, setAnnounce] = useState<{ id: string; text: string } | null>(null)
  /** The answers the screen reader has been told about (or that were already there when the panel opened). */
  const heard = useRef<Set<string> | null>(null)
  const panelId = useId()
  const inputId = useId()
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const s: ManaConversationState | undefined = conv.data
  const pending = pendingMessage(s)
  const busy = !!pending || ask.isPending || select.isPending || fresh.isPending
  const available = s?.status.available ?? true

  // The newest message is brought into view when it arrives; a doctor reading an older one is not pulled away from it by the polling alone.
  const count = s?.messages.length ?? 0
  const last = s?.messages.at(-1)
  useEffect(() => {
    const el = logRef.current
    if (el && count) el.scrollTo({ top: el.scrollHeight })
  }, [count, last?.status])
  // A doctor who is at the end of the conversation stays at the end when the window is resized (the lines wrap differently, and the newest message would otherwise
  // slide below the fold); one who has scrolled up to read an older message is left where they are.
  const showing = open && !!s
  const atEnd = useRef(true)
  useEffect(() => {
    const el = logRef.current
    if (!el) return
    const onScroll = () => {
      atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    const onResize = () => {
      if (atEnd.current) el.scrollTo({ top: el.scrollHeight })
    }
    el.addEventListener('scroll', onScroll)
    window.addEventListener('resize', onResize)
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [showing])
  // Assistive technology hears that an answer arrived, not the whole answer; each one once, also when two answers in a row have the same words, and not the ones that
  // were already in the conversation when the panel was opened.
  useEffect(() => {
    if (!open) {
      heard.current = null
      setAnnounce(null)
      return
    }
    if (!s) return
    const done = s.messages.filter((m) => m.role === 'mana' && m.status !== 'pending')
    if (heard.current === null) {
      heard.current = new Set(done.map((m) => m.id))
      return
    }
    for (const m of done) {
      if (heard.current.has(m.id)) continue
      heard.current.add(m.id)
      setAnnounce({ id: m.id, text: announcement(m) })
    }
  }, [open, s])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const t = text.trim()
    if (t.length < 2 || busy || !available) return
    ask.mutate({ text: t }, { onSuccess: () => setText('') })
  }
  /** The button that was pressed (a suggestion, a patient to choose, "Ask again") is not on the screen while the answer is made: focus goes to the question box, not to the page. */
  const keepFocus = () => inputRef.current?.focus()
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const retryOf = (idx: number): string | null => {
    const prev = s?.messages[idx - 1]
    return prev?.role === 'doctor' && prev.text && !prev.text.startsWith('Selected ') ? prev.text : null
  }
  // The questions about one consultation are offered only in a conversation opened in it (the server refuses them anywhere else).
  const suggested = SUGGESTIONS.filter(([, q]) => (!q.needsPatient || !!s?.scopePatient) && (!q.needsConsultation || !!s?.conversation.scope.encounterId))
  const sp = s?.scopePatient

  return (
    <section aria-label="Mana AI, Doctor’s Clinical Assistant" className="min-w-0 rounded-xl border border-ai/30 bg-surface shadow-card" data-testid="mana-assistant" data-open={open}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <h2 className="min-w-0 text-sm leading-tight">
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wide text-ai">
            <Sparkles aria-hidden="true" className="size-4 shrink-0" />
            MANA AI
          </span>
          <span className="font-medium"> — Doctor’s Clinical Assistant</span>
        </h2>
        <div className="flex items-center gap-1.5">
          {open && (
            <Button size="sm" variant="ghost" loading={fresh.isPending} disabled={busy} icon={<MessageSquarePlus aria-hidden="true" className="size-4" />} onClick={() => fresh.mutate()} data-testid="mana-new">
              New conversation
            </Button>
          )}
          <Button
              size="sm"
              variant={open ? 'secondary' : 'primary'}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => {
                // Closing the panel discards what it loaded (the conversation, with the names of patients, is read again from the server when it is opened).
                if (open) qc.removeQueries({ queryKey: manaConversationKey(scope) })
                setOpen((o) => !o)
              }}
              data-testid="mana-toggle"
            >
            {open ? 'Close' : 'Open'}
            <span className="sr-only"> Mana AI</span>
          </Button>
        </div>
      </div>
      <div id={panelId} hidden={!open} className="border-t border-line px-4 pb-4 pt-3">
        {open && (
          <>
            {conv.isPending && (
              <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Opening the conversation…
              </p>
            )}
            {conv.isError && (
              <Alert tone={/unavailable/i.test(errorMessage(conv.error)) ? 'warning' : 'error'} title={/unavailable/i.test(errorMessage(conv.error)) ? MANA_UNAVAILABLE : 'Mana could not open'}>
                <span data-testid="mana-open-error">{errorMessage(conv.error)}</span>
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      qc.removeQueries({ queryKey: manaConversationKey(scope) })
                      void conv.refetch()
                    }}
                  >
                    Try again
                  </Button>
                </div>
              </Alert>
            )}
            {s && (
              <>
                <p className="text-xs text-ink-muted" data-testid="mana-context">
                  {sp ? (
                    <>
                      About <strong className="text-ink">{sp.displayName}</strong> · MRN {sp.mrn} · {sp.ageSex}. Ask about this patient, today’s queue, appointments, or your consultations.
                    </>
                  ) : (
                    'Ask about today’s queue, appointments, your consultations, or a patient by name.'
                  )}
                </p>
                {!available && (
                  <Alert tone="warning" title={MANA_UNAVAILABLE} className="mt-2">
                    <span data-testid="mana-status-unavailable">{s.status.reason ?? 'The local model is not running.'}</span> No answer is made without it, and nothing is made up. This panel looks again every few seconds.
                    <div className="mt-2">
                      <Button size="sm" variant="secondary" onClick={() => void qc.invalidateQueries({ queryKey: manaConversationKey(scope) })}>
                        Check again
                      </Button>
                    </div>
                  </Alert>
                )}
                <div ref={logRef} role="group" aria-label="Conversation with Mana" className="mt-3 max-h-[26rem] space-y-3 overflow-y-auto pr-1" tabIndex={0} data-testid="mana-log">
                  {s.messages.length === 0 && <p className="text-sm text-ink-muted">Nothing asked yet. Mana looks things up in the records you can already see, and shows where each statement comes from.</p>}
                  {s.messages.map((m, i) =>
                    m.role === 'doctor' ? (
                      <div key={m.id} className="flex justify-end" data-testid="mana-question">
                        <p className="max-w-[90%] rounded-lg rounded-br-sm bg-brand-soft px-3 py-1.5 text-sm text-brand-strong [overflow-wrap:anywhere]">{m.text}</p>
                      </div>
                    ) : (
                      <div key={m.id} className="rounded-lg border border-line bg-canvas p-3" data-testid="mana-message">
                        <ManaMessageView
                          m={m}
                          question={retryOf(i)}
                          busy={busy}
                          current={i === s.messages.length - 1}
                          onSelect={(alias) => {
                            select.mutate(alias)
                            keepFocus()
                          }}
                          onRetry={(t) => {
                            ask.mutate({ text: t })
                            keepFocus()
                          }}
                        />
                      </div>
                    ),
                  )}
                </div>
                {(ask.isError || select.isError || cancel.isError) && (
                  <Alert tone={/unavailable/i.test(errorMessage(ask.error ?? select.error ?? cancel.error)) ? 'warning' : 'error'} className="mt-2">
                    <span data-testid="mana-ask-error">{errorMessage(ask.error ?? select.error ?? cancel.error)}</span>
                  </Alert>
                )}
                {!busy && suggested.length > 0 && available && (
                  <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Suggested questions">
                    {suggested.map(([key, q]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          ask.mutate({ text: q.label, suggestion: key })
                          keepFocus()
                        }}
                        className="min-h-8 rounded-full border border-brand/30 bg-brand-soft px-3 text-xs font-medium text-brand-strong transition-colors hover:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand"
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                )}
                <form onSubmit={submit} className="mt-3">
                  <label htmlFor={inputId} className="sr-only">
                    Ask Mana
                  </label>
                  <div className="flex items-end gap-2">
                    <textarea
                      id={inputId}
                      ref={inputRef}
                      rows={3}
                      value={text}
                      maxLength={500}
                      disabled={!available}
                      placeholder="Ask Mana about this patient, today's queue, or hospital records..."
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={onKey}
                      className="min-h-[3.25rem] min-w-0 flex-1 resize-y rounded-md border border-line-strong bg-surface px-3 py-2 text-sm placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand disabled:opacity-60"
                      data-testid="mana-input"
                    />
                    {pending ? (
                      <Button
                        variant="secondary"
                        icon={<Square aria-hidden="true" className="size-4" />}
                        loading={cancel.isPending}
                        onClick={() => {
                          cancel.mutate(pending.id)
                          keepFocus()
                        }}
                        data-testid="mana-stop"
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button type="submit" loading={ask.isPending} disabled={busy || !available || text.trim().length < 2} icon={<Send aria-hidden="true" className="size-4" />} onClick={keepFocus} data-testid="mana-send">
                        Send
                      </Button>
                    )}
                  </div>
                </form>
                <p className="mt-2 text-xs text-ink-muted">
                  Mana AI is a doctor-facing AI assistant; its outputs require clinician review. It only reads records you can already see, and cannot prescribe, sign or change anything.
                </p>
              </>
            )}
          </>
        )}
      </div>
      <p role="status" className="sr-only">
        <span key={announce?.id ?? 'none'}>{announce?.text ?? ''}</span>
      </p>
    </section>
  )
}

