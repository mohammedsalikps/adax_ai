import {
  CONSULT_NOTE_SECTION,
  CONSULT_SECTIONS,
  type ConsultDraft,
  type ConsultItem,
  type ConsultSection,
  type EncounterAi,
  factState,
  ITEM_FLAGS,
  NOTE_SECTIONS,
  type RecordCheck,
  type RecordFinding,
  SUPPORT_STATES,
  type SupportState,
} from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { BrainCircuit, Check, ChevronDown, Pencil, Plus, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { aiKey } from '../../lib/ai.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { useCancelDraft, useConsultationAi, useGenerateDraft, useReviewConsultItem } from '../../lib/consult.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, type BadgeTone, Spinner } from '../ui/Feedback.tsx'
import { SelectField, TextAreaField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'

/**
 * Local AI consultation intelligence: a DRAFT made by a language model that runs on this computer from the authorised record, the doctor's own notes
 * and the points the doctor confirmed during capture. Everything here is for the doctor to review: nothing is added to the note, the diagnoses or the
 * prescription except by a separate act after accepting a statement.
 */

/** The parts of a draft as the doctor reads them. */
const GROUPS: { title: string; sections: ConsultSection[] }[] = [
  { title: 'Clinical summary', sections: ['summary'] },
  { title: 'Current problem', sections: ['presenting_problem', 'symptoms', 'observations'] },
  { title: 'Relevant history', sections: ['relevant_history', 'allergies', 'medications'] },
  { title: 'Potential considerations', sections: ['potential_considerations'] },
  { title: 'Potential investigations', sections: ['potential_investigations'] },
  { title: 'Medication considerations', sections: ['potential_medication_considerations'] },
  { title: 'Missing information', sections: ['missing_information'] },
  { title: 'Conflicts and uncertainties', sections: ['uncertainties'] },
]

const SUPPORT_TONE: Record<SupportState, BadgeTone> = { supported: 'ok', inferred: 'ai', not_found: 'neutral', conflicting: 'down', outdated: 'warn' }

type View = 'not_run' | 'generating' | 'ready' | 'partial' | 'failed' | 'cancelled' | 'unavailable' | 'stale' | 'insufficient'
const VIEW_LABEL: Record<View, string> = {
  not_run: 'NOT RUN',
  generating: 'GENERATING',
  ready: 'READY FOR REVIEW',
  partial: 'PARTIALLY AVAILABLE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  unavailable: 'UNAVAILABLE',
  stale: 'STALE',
  insufficient: 'INSUFFICIENT INFORMATION',
}
const VIEW_TONE: Record<View, BadgeTone> = { not_run: 'neutral', generating: 'notice', ready: 'ai', partial: 'warn', failed: 'down', cancelled: 'neutral', unavailable: 'down', stale: 'warn', insufficient: 'neutral' }

function viewOf(draft: ConsultDraft | null, available: boolean): View {
  if (!draft) return available ? 'not_run' : 'unavailable'
  // With the model not there now, a draft that failed or was cancelled is not what matters: that no new draft can be made is.
  if (!available && (draft.status === 'failed' || draft.status === 'cancelled' || draft.status === 'unavailable')) return 'unavailable'
  if (draft.status === 'generating') return 'generating'
  if (draft.status === 'cancelled') return 'cancelled'
  if (draft.status === 'failed') return 'failed'
  if (draft.status === 'unavailable') return 'unavailable'
  if (draft.insufficient) return 'insufficient'
  if (draft.stale) return 'stale'
  return draft.status === 'partial' ? 'partial' : 'ready'
}

/** The title of the one alert that says the model cannot be used now. The server's reasons often start with the same words. */
const UNAVAILABLE = 'Local AI unavailable.'

/** What the server says about the model beyond the alert's title (null when it says nothing more). */
function beyondTitle(reason: string | null): string | null {
  const rest = (reason ?? '').replace(/^Local AI unavailable[.:]\s*/, '').trim()
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : null
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="tabular-nums">{clock(Math.max(0, now - new Date(since).getTime()))}</span>
}

// --- rules-based record check ------------------------------------------------------------------------------------------------------------

function Findings({ title, tone, items }: { title: string; tone: 'down' | 'warn' | 'neutral'; items: RecordFinding[] }) {
  if (!items.length) return null
  const cls = tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-pending' : 'text-ink-muted'
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wide ${cls}`}>{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((f, i) => (
          <li key={i}>
            {f.text}
            {f.refs.length > 0 && <span className="ml-1 font-mono text-xs text-ink-muted">[{f.refs.join(', ')}]</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function RecordCheckCard({ check }: { check: RecordCheck }) {
  const none = !check.conflicts.length && !check.outdated.length && !check.missing.length
  return (
    <div className="rounded-lg border border-line p-3" data-testid="record-check">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Record check</h3>
        <Badge tone="neutral">Fixed rules, not AI</Badge>
        <span className="text-xs text-ink-muted">{check.rulesVersion}</span>
      </div>
      {none ? (
        <p className="text-sm text-ink-muted">The rules found no conflict, old item or missing item in the record.</p>
      ) : (
        <div className="space-y-3">
          <Findings title="Conflicts" tone="down" items={check.conflicts} />
          <Findings title="Possibly out of date" tone="warn" items={check.outdated} />
          <Findings title="Missing" tone="neutral" items={check.missing} />
        </div>
      )}
    </div>
  )
}

// --- statements ----------------------------------------------------------------------------------------------------------------------------

function Sources({ item }: { item: ConsultItem }) {
  if (!item.sources.length) return <p className="text-xs text-ink-muted">No record item is cited.</p>
  return (
    <details className="group text-xs">
      <summary className="inline-flex cursor-pointer items-center gap-1 text-ink-muted">
        <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180" />
        Sources ({item.sources.length}): {item.sources.map((s) => s.ref).join(', ')}
        {item.sourceChanged && <span className="ml-1 font-medium text-pending">· changed since</span>}
      </summary>
      <ul className="mt-1.5 space-y-1.5">
        {item.sources.map((s) => (
          <li key={`${s.key}-${s.ref}`} className="rounded bg-canvas px-2 py-1.5">
            <p>
              <span className="font-mono text-ink-muted">{s.ref}</span> <span className="font-medium">{s.field}</span>
              <span className="text-ink-muted">
                {s.date ? ` · ${fmtDate(s.date)}` : ''}
                {s.status ? ` · ${s.status}` : ''}
              </span>
              {s.change === 'changed' && <span className="ml-1 font-medium text-pending">· changed since this draft</span>}
              {s.change === 'removed' && <span className="ml-1 font-medium text-down">· no longer in the record</span>}
            </p>
            <p className="mt-0.5">“{s.excerpt}”</p>
          </li>
        ))}
      </ul>
    </details>
  )
}

function StatementCard({ item, conflicts, encounterId, inserter }: { item: ConsultItem; conflicts: RecordFinding[]; encounterId: string; inserter: NoteInserter }) {
  const toast = useToast()
  // What the fixed rules found about the record items this statement rests on: shown with the statement, so the doctor sees what disagrees.
  const keys = new Set(item.sources.map((s) => s.key))
  const conflictsHere = item.flags.includes('record_conflict') ? conflicts.filter((c) => c.keys.some((k) => keys.has(k))) : []
  const review = useReviewConsultItem(encounterId)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.finalText ?? item.text)
  const [confirmed, setConfirmed] = useState(false)
  const [target, setTarget] = useState(CONSULT_NOTE_SECTION[item.section] ?? 'history')
  const [adding, setAdding] = useState(false)
  const decided = item.decision !== 'pending'
  const shown = item.finalText ?? item.text
  const blocked = item.needsConfirmation && !confirmed
  const act = (action: 'accepted' | 'edited' | 'rejected') =>
    review.mutate(
      { id: item.id, body: action === 'edited' ? { action, text: text.trim(), confirmFlags: confirmed } : { action, confirmFlags: confirmed } },
      { onSuccess: () => setEditing(false) },
    )
  const inNote = item.inNote || inserter.inserted('consultation_item', item.id)
  // A comment on the record (an uncertainty) is not text for the note.
  const insertable = CONSULT_NOTE_SECTION[item.section] !== null
  return (
    <li className={`rounded-lg border p-3 ${item.decision === 'rejected' ? 'border-line bg-canvas' : 'border-ai/30 bg-ai-soft'}`} data-testid="consult-statement" data-section={item.section} data-support={item.support} data-decision={item.decision}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Badge tone={SUPPORT_TONE[item.support]} dot>
          {SUPPORT_STATES[item.support].toUpperCase()}
        </Badge>
        {item.decision === 'accepted' && <Badge tone="ok">Accepted</Badge>}
        {item.decision === 'edited' && <Badge tone="ok">Edited and accepted</Badge>}
        {item.decision === 'rejected' && <Badge>Rejected</Badge>}
        {inNote && (
          <Badge tone="ai" icon={<Check aria-hidden="true" className="size-3" />}>
            In the note
          </Badge>
        )}
      </div>
      {editing ? <TextAreaField label="Edit before accepting" rows={3} value={text} onChange={(e) => setText(e.target.value)} /> : <p className={`text-sm ${item.decision === 'rejected' ? 'text-ink-muted line-through' : ''}`}>{shown}</p>}
      {item.flags.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-pending" aria-label="Checks to make">
          {item.flags.map((f) => (
            <li key={f} className="flex gap-1">
              <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {ITEM_FLAGS[f]}
            </li>
          ))}
        </ul>
      )}
      {conflictsHere.length > 0 && (
        <p className="mt-1 text-xs font-medium text-down" data-testid="statement-conflict">
          Found by the fixed rules, not by the AI: {conflictsHere.map((c) => c.text).join('; ')}
        </p>
      )}
      {item.rationale && <p className="mt-1.5 text-xs text-ink-muted">Why the AI listed this: {item.rationale}</p>}
      {item.uncertainty && <p className="mt-0.5 text-xs text-ink-muted">Uncertain: {item.uncertainty} (the AI’s own words, not a measured probability)</p>}
      <div className="mt-1.5">
        <Sources item={item} />
      </div>
      {review.isError && (
        <Alert tone="error" className="mt-2">
          {errorMessage(review.error)}
        </Alert>
      )}
      {!decided && (
        <div className="mt-2 space-y-2">
          {item.needsConfirmation && (
            <label className="flex items-start gap-2 text-sm font-medium">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I have checked this against the record</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            {editing ? (
              <>
                <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={review.isPending} disabled={!text.trim() || blocked} onClick={() => act('edited')}>
                  Save edited text
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={review.isPending && review.variables?.body.action === 'accepted'} disabled={blocked} onClick={() => act('accepted')}>
                  Accept
                </Button>
                <Button size="sm" variant="secondary" icon={<Pencil aria-hidden="true" className="size-4" />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} loading={review.isPending && review.variables?.body.action === 'rejected'} onClick={() => act('rejected')}>
                  Reject
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {(item.decision === 'accepted' || item.decision === 'edited') && !inNote && insertable && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <SelectField label="Add to note section" value={target} onChange={(e) => setTarget(e.target.value as typeof target)} className="min-w-0 flex-1">
            {NOTE_SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <Button
            size="sm"
            variant="secondary"
            loading={adding}
            icon={<Plus aria-hidden="true" className="size-4" />}
            onClick={async () => {
              setAdding(true)
              try {
                await inserter.insert(target, shown, { type: 'consultation_item', id: item.id })
                toast('success', 'Added to the note. Review it there.')
              } catch (e) {
                toast('error', errorMessage(e))
              } finally {
                setAdding(false)
              }
            }}
          >
            Add to note
          </Button>
        </div>
      )}
    </li>
  )
}

function DraftBody({ draft, encounterId, inserter }: { draft: ConsultDraft; encounterId: string; inserter: NoteInserter }) {
  const groups = GROUPS.map((g) => ({ ...g, items: draft.items.filter((i) => g.sections.includes(i.section)).sort((a, b) => g.sections.indexOf(a.section) - g.sections.indexOf(b.section) || a.position - b.position) }))
  const conflictsFromRules = draft.recordCheck.conflicts.length + draft.recordCheck.outdated.length
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const rules = g.title === 'Conflicts and uncertainties' && conflictsFromRules > 0
        // What the fixed rules find is not recorded is shown with the AI's own list of what is missing: the model names little of it.
        const missingFromRules = g.title === 'Missing information' && draft.recordCheck.missing.length > 0
        if (!g.items.length && !rules && !missingFromRules) return null
        return (
          <section key={g.title} aria-label={g.title} className="space-y-2" data-testid={`group-${g.title.toLowerCase().replace(/\W+/g, '-')}`}>
            <h3 className="text-sm font-semibold">{g.title}</h3>
            {g.sections.length > 1 && g.items.length > 0 && <p className="text-xs text-ink-muted">{g.sections.filter((s) => g.items.some((i) => i.section === s)).map((s) => CONSULT_SECTIONS[s]).join(' · ')}</p>}
            {rules && (
              <div className="space-y-3 rounded-lg border border-line p-3">
                <p className="text-xs text-ink-muted">Found by fixed rules, not by the AI.</p>
                <Findings title="Conflicts" tone="down" items={draft.recordCheck.conflicts} />
                <Findings title="Possibly out of date" tone="warn" items={draft.recordCheck.outdated} />
              </div>
            )}
            {missingFromRules && (
              <div className="space-y-3 rounded-lg border border-line p-3" data-testid="rules-missing">
                <p className="text-xs text-ink-muted">Found by fixed rules, not by the AI.</p>
                <Findings title="Not recorded" tone="neutral" items={draft.recordCheck.missing} />
              </div>
            )}
            {g.items.length > 0 && (
              <ul className="space-y-2">
                {g.items.map((i) => (
                  <StatementCard key={i.id} item={i} conflicts={draft.recordCheck.conflicts} encounterId={encounterId} inserter={inserter} />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

function DraftFacts({ draft }: { draft: ConsultDraft }) {
  const v = draft.validation
  const took = draft.latencyMs ? clock(draft.latencyMs) : null
  return (
    <details className="text-xs text-ink-muted" data-testid="draft-facts">
      <summary className="cursor-pointer">How this draft was made</summary>
      <ul className="mt-1.5 space-y-0.5">
        <li>
          Draft {draft.version} · made {fmtDateTime(draft.createdAt)}
          {draft.requestedByName ? ` for ${draft.requestedByName}` : ''}
          {took ? ` · took ${took}` : ''}
        </li>
        {draft.model && (
          <li>
            Model {draft.model.model} ({draft.model.provider}, {draft.model.local ? 'runs on this computer' : 'NOT on this computer'}
            {draft.model.weightsSha256 ? `, weights SHA-256 ${draft.model.weightsSha256.slice(0, 12)}…` : ''})
          </li>
        )}
        <li>
          Prompt {draft.promptVersion} · output form {draft.schemaVersion} · record rules {draft.rulesVersion}
        </li>
        <li>
          {draft.sourceCount} record item(s) were shown to the AI{draft.omittedCount > 0 ? `; ${draft.omittedCount} item(s) did not fit and were not shown (older and less central ones go first)` : ''}. Only points you confirmed were used; rejected and unreviewed points, the transcript and the audio were not.
        </li>
        {v && (
          <li>
            {v.produced} statement(s) came back; {v.kept} kept{v.removed > 0 ? `, ${v.removed} removed because they could not be verified against the record` : ''}
            {v.flagged > 0 ? `, ${v.flagged} marked for a check` : ''}.
          </li>
        )}
      </ul>
    </details>
  )
}

/**
 * What a draft is made from, in one line by the Generate button. The number of points the doctor confirmed is read from the copy of the
 * consultation's AI state that the capture panel keeps; this never asks the server for it (`enabled: false`), and without that copy the number is left out.
 */
function DraftInputs({ encounterId }: { encounterId: string }) {
  const capture = useQuery({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`), enabled: false })
  const n = capture.data ? capture.data.facts.filter((f) => factState(f.status) === 'confirmed').length : null
  return (
    <p className="text-xs text-ink-muted" data-testid="consult-inputs">
      {n === 0
        ? 'A draft is made from this patient’s record and your note for this visit, never from the raw transcript or the audio. No important point is confirmed yet: confirming them first gives the draft more to work with.'
        : `A draft is made from this patient’s record, your note for this visit and ${n === null ? 'the important points' : `the ${n} important point${n === 1 ? '' : 's'}`} you confirmed, never from the raw transcript or the audio.`}
    </p>
  )
}

// --- the panel -------------------------------------------------------------------------------------------------------------------------------

export function ConsultationIntelligence({ encounterId, inserter }: { encounterId: string; inserter: NoteInserter }) {
  const toast = useToast()
  const q = useConsultationAi(encounterId)
  const generate = useGenerateDraft(encounterId)
  const cancel = useCancelDraft(encounterId)
  const title = (
    <span className="inline-flex items-center gap-2">
      <BrainCircuit aria-hidden="true" className="size-4 text-ai" />
      Consultation intelligence
    </span>
  )
  if (q.isPending)
    return (
      <Card title={title}>
        <Spinner />
      </Card>
    )
  if (q.isError)
    return (
      <Card title={title}>
        <Alert tone="error">{errorMessage(q.error)}</Alert>
      </Card>
    )
  const ai = q.data
  const draft = ai.draft
  const view = viewOf(draft, ai.status.available)
  const check = draft?.recordCheck ?? ai.recordCheck
  const regenerate = () => generate.mutate(undefined, { onError: (e) => toast('error', errorMessage(e)) })
  // With nothing else in the way, the server gives the model's own reason as what stops a new draft: that is said once, in the alert about the model.
  // Anything else (the visit is closed, the consent is missing or old) is said as well, whether or not the model is there.
  const modelReason = ai.status.available ? null : (ai.status.reason ?? UNAVAILABLE)
  const blocked = ai.blockedReason && ai.blockedReason !== modelReason && ai.blockedReason !== UNAVAILABLE ? ai.blockedReason : null
  const why = beyondTitle(modelReason)
  // A draft that ended because the model was not there is told in that same alert, and only if it adds something to it.
  const draftWhy = draft?.status === 'unavailable' ? beyondTitle(draft.errorMessage) : null
  return (
    <Card title={title}>
      <div className="space-y-4" role="region" aria-label="AI consultation intelligence" data-testid="consult-panel" data-view={view}>
        <div className="flex flex-wrap items-center gap-1.5" aria-label="What this is">
          <Badge tone="ai">AI DRAFT</Badge>
          <Badge tone="ai">AI-GENERATED</Badge>
          <Badge tone="warn">REQUIRES DOCTOR REVIEW</Badge>
        </div>
        <p className="text-xs text-ink-muted">
          Made by a language model (what it is made from is said under the button). Nothing is added to the note, the diagnoses or the prescription until you accept a statement and add it yourself. Not clinically validated. “Supported by record” means the cited record items contain the statement’s words and figures; it does not mean the statement is right, so read the items.{' '}
          {ai.status.available ? (
            <span data-testid="consult-model">
              {ai.status.local ? `Local model ${ai.status.model}: it runs on this computer and nothing leaves it.` : `Hosted model ${ai.status.model}: NOT on this computer${ai.egress.destination ? ` (${ai.egress.destination})` : ''}.`}
            </span>
          ) : null}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="consult-status">
            <Badge tone={VIEW_TONE[view]} dot>
              {VIEW_LABEL[view]}
            </Badge>
          </span>
          {view === 'generating' && draft && (
            <span className="text-xs text-ink-muted" role="status" data-testid="consult-progress">
              {draft.phase === 'queued' ? 'Waiting for the local model' : 'The local model is writing the draft'} · <Elapsed since={draft.createdAt} /> (it can take a few minutes on this computer)
            </span>
          )}
          <span className="ml-auto flex flex-wrap gap-2">
            {view === 'generating' && draft && (
              <Button size="sm" variant="secondary" icon={<X aria-hidden="true" className="size-4" />} loading={cancel.isPending} onClick={() => cancel.mutate(draft.id)}>
                Cancel
              </Button>
            )}
            {view !== 'generating' && (
              <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-4" />} loading={generate.isPending} disabled={!ai.canGenerate} onClick={regenerate}>
                {draft ? (view === 'failed' || view === 'cancelled' || view === 'unavailable' ? 'Try again' : 'Generate a new draft') : 'Generate draft'}
              </Button>
            )}
          </span>
        </div>
        {view !== 'generating' && <DraftInputs encounterId={encounterId} />}

        {!ai.status.available && (
          <Alert tone="warning" title={UNAVAILABLE}>
            <span data-testid="consult-unavailable">{why ? `${why} ` : ''}No draft is made without it, and nothing is made up.</span> The record check below does not need AI.
            {draftWhy && draftWhy !== why && (
              <span className="mt-1 block">
                The last attempt: <span data-testid="consult-error">{draftWhy}</span>
              </span>
            )}
            <div className="mt-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden="true" className="size-4" />} loading={q.isFetching} onClick={() => void q.refetch()}>
                Check again
              </Button>
            </div>
          </Alert>
        )}
        {blocked && (
          <Alert tone="info">
            <span data-testid="consult-blocked">{blocked}</span>
          </Alert>
        )}
        {generate.isError && (
          <Alert tone="error" title="The draft could not be started">
            {errorMessage(generate.error)}
          </Alert>
        )}
        {draft && (draft.status === 'failed' || draft.status === 'cancelled') && (
          <Alert tone={draft.status === 'cancelled' ? 'info' : 'error'} title={draft.status === 'cancelled' ? 'Cancelled' : view === 'unavailable' ? 'The last attempt failed' : 'The draft could not be made'}>
            <span data-testid="consult-error">{draft.errorMessage ?? 'The draft could not be made.'}</span>{' '}
            {draft.retryable && !/try again|retry/i.test(draft.errorMessage ?? '') ? 'You can try again.' : ''}
          </Alert>
        )}
        {/* With the model there again, what ended this draft is history: the title says so instead of saying the model is unavailable. */}
        {draft?.status === 'unavailable' && ai.status.available && (
          <Alert tone="warning" title="The last attempt could not use the local AI">
            <span data-testid="consult-error">{draft.errorMessage}</span>
          </Alert>
        )}
        {view === 'insufficient' && (
          <Alert tone="info" title="Insufficient information">
            {draft?.model ? 'The AI said there is too little recorded for this consultation to draft from.' : 'There is too little recorded for this consultation for the AI to draft from, so it was not asked.'} Add the reason for the visit, your notes or the points from the conversation, then generate a new draft. The record check below says what is missing.
          </Alert>
        )}
        {ai.lastAttempt && draft && (view === 'ready' || view === 'partial' || view === 'stale' || view === 'insufficient') && (
          <Alert tone={ai.lastAttempt.status === 'cancelled' ? 'info' : 'warning'} title="The newest attempt did not finish">
            <span data-testid="consult-last-attempt">{ai.lastAttempt.errorMessage ?? 'The draft could not be made.'}</span> The draft below is the earlier one.
          </Alert>
        )}
        {view === 'partial' && draft && (
          <Alert tone="warning" title="Partially available">
            Some statements the AI wrote were removed because they could not be verified against the record{draft.validation ? ` (${draft.validation.removed})` : ''}. What is shown rests on record items you can open.
          </Alert>
        )}
        {draft?.stale && draft.staleSummary && (
          <Alert tone="warning" title="Stale">
            <span data-testid="consult-stale">{draft.staleSummary}</span>
          </Alert>
        )}

        {draft && (draft.status === 'ready' || draft.status === 'partial') && !draft.insufficient && <DraftBody draft={draft} encounterId={encounterId} inserter={inserter} />}
        {check && !(draft && (draft.status === 'ready' || draft.status === 'partial') && !draft.insufficient) && <RecordCheckCard check={check} />}
        {draft && draft.status !== 'generating' && <DraftFacts draft={draft} />}
        {ai.earlier.length > 0 && <p className="text-xs text-ink-muted">{ai.earlier.length} earlier draft(s) of this consultation are kept in the record; only the newest is shown.</p>}
      </div>
    </Card>
  )
}
