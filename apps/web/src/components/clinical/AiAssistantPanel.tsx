import { type AiDraftItem, type Encounter, type EncounterAi, type Transcript } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Check, Pencil, ShieldAlert, Sparkles, X } from 'lucide-react'
import { useId, useState } from 'react'
import { aiKey, newIdempotencyKey, useAiMutation } from '../../lib/ai.ts'
import { api, ApiError, errorMessage } from '../../lib/api.ts'
import { focusLines } from '../../lib/focusLines.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { ActivityView } from '../ai/ActivityView.tsx'
import { InsertButton, SECTION_LABEL } from '../ai/InsertButton.tsx'
import { RecommendationsView } from '../ai/RecommendationsView.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, Spinner } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'
import { fmtDateTime } from '../../lib/format.ts'

function SuggestionCard({ item, transcript, encounterId, inserter, onFocusSources }: { item: AiDraftItem; transcript?: Transcript; encounterId: string; inserter: NoteInserter; onFocusSources: (ids: string[]) => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  const [confirmUnsupported, setConfirmUnsupported] = useState(false)
  const decide = useAiMutation<{ decision: 'accepted' | 'edited' | 'rejected'; text?: string }>(encounterId, (body) =>
    api(`/ai-draft-items/${item.id}/decision`, { method: 'POST', body: { ...body, confirmUnsupported } }),
  )
  const act = (decision: 'accepted' | 'edited' | 'rejected') =>
    decide.mutate(decision === 'edited' ? { decision, text } : { decision }, {
      onSuccess: () => {
        // Accepting does not write to the note: the doctor adds the accepted text with "Add to <section>" below, a separate act the server records.
        if (decision !== 'rejected') toast('success', `${decision === 'edited' ? 'Edited and accepted' : 'Accepted'}. It is not in the note yet: use “Add to ${SECTION_LABEL[item.section]}” to add it.`)
        setEditing(false)
      },
    })
  const sources = (transcript?.segments ?? []).filter((s) => item.sourceSegmentIds.includes(s.id))
  const decided = item.decision !== 'pending' && item.decision !== 'deferred'
  return (
    <li className={`rounded-lg border p-3 ${decided ? 'border-line bg-surface opacity-80' : 'border-ai/30 bg-ai-soft'}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone="ai" icon={<Sparkles aria-hidden="true" className="size-3" />}>
          AI draft
        </Badge>
        <span className="text-sm font-medium">{SECTION_LABEL[item.section]}</span>
        {item.decision === 'accepted' && <Badge tone="ok">Accepted</Badge>}
        {item.decision === 'edited' && <Badge tone="ok">Edited and accepted</Badge>}
        {item.decision === 'rejected' && <Badge>Rejected</Badge>}
      </div>
      {editing ? (
        <TextAreaField label="Edit the suggestion" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className={`text-sm ${item.decision === 'rejected' ? 'line-through' : ''}`}>{item.finalText ?? item.text}</p>
      )}
      {item.unsupported ? (
        <Alert tone="warning" className="mt-2">
          Not linked to any part of the transcript. It may be inaccurate.
          {!decided && (
            <label className="mt-1 flex items-center gap-2 font-medium">
              <input type="checkbox" className="size-4 accent-brand" checked={confirmUnsupported} onChange={(e) => setConfirmUnsupported(e.target.checked)} />I have checked this against the consultation
            </label>
          )}
        </Alert>
      ) : (
        <details className="mt-2 text-xs" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && onFocusSources(item.sourceSegmentIds)}>
          <summary className="cursor-pointer text-ink-muted">Source: {item.sourceSegmentIds.join(', ')}</summary>
          <ul className="mt-1 space-y-1">
            {sources.map((s) => (
              <li key={s.id} className="rounded bg-surface px-2 py-1">
                <span className="font-mono text-ink-muted">{s.id}</span> {s.speaker && <strong>{s.speaker}: </strong>}“{s.text}”
              </li>
            ))}
          </ul>
        </details>
      )}
      {decide.isError && <p className="mt-2 text-sm text-down">{errorMessage(decide.error)}</p>}
      {!decided && (
        <div className="mt-2 flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={decide.isPending} disabled={!text.trim() || (item.unsupported && !confirmUnsupported)} onClick={() => act('edited')}>
                Save edited text
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={decide.isPending} disabled={item.unsupported && !confirmUnsupported} onClick={() => act('accepted')}>
                Accept
              </Button>
              <Button size="sm" variant="secondary" icon={<Pencil aria-hidden="true" className="size-4" />} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} loading={decide.isPending} onClick={() => act('rejected')}>
                Reject
              </Button>
            </>
          )}
        </div>
      )}
      {/* The only way accepted text reaches the note: the doctor's own click, recorded on the server with a reference to this suggestion. */}
      {(item.decision === 'accepted' || item.decision === 'edited') && <InsertButton inserter={inserter} section={item.section} text={item.finalText ?? item.text} subject={{ type: 'draft_item', id: item.id }} />}
    </li>
  )
}

type Tab = 'draft' | 'recommendations' | 'activity'

/**
 * The older AI assistant of a consultation: note passages drafted from the transcript by a hosted model (off unless the server allows hosted
 * AI), recommendations from fixed safety rules (with AI suggestions only through the same hosted model), and the activity log, each reviewed
 * item by item. Accepting a passage does not write to the note: "Add to <section>" does, as a separate act, and signing is another. Recording,
 * the transcript and the important points are in the capture panel; the local AI draft, with its clinical summary, is ConsultationIntelligence.
 */
export function AiAssistantPanel({ encounter, inserter }: { encounter: Encounter; inserter: NoteInserter }) {
  const toast = useToast()
  const id = encounter.id
  const tabsId = useId()
  const q = useQuery({ queryKey: aiKey(id), queryFn: () => api<EncounterAi>(`/encounters/${id}/ai`) })
  const [tab, setTab] = useState<Tab>('draft')
  const draft = useAiMutation<string>(id, (transcriptId) => api(`/transcripts/${transcriptId}/drafts`, { method: 'POST', body: { idempotencyKey: newIdempotencyKey() } }))
  const recommend = useAiMutation<boolean>(id, (includeLlm) => api(`/encounters/${id}/recommendations`, { method: 'POST', body: { includeLlm, idempotencyKey: newIdempotencyKey() } }))
  // A failed job is listed under Activity (with Retry); refresh so it appears.
  const refreshOnError = { onError: () => void q.refetch() }

  if (q.isPending)
    return (
      <Card title="AI consultation assistant">
        <Spinner />
      </Card>
    )
  if (q.isError)
    return (
      <Card title="AI consultation assistant">
        <Alert tone="error">{errorMessage(q.error)}</Alert>
      </Card>
    )
  const ai = q.data
  const latest = ai.transcripts.at(-1)
  const latestDraft = ai.drafts[0]
  const draftTranscript = ai.transcripts.find((t) => t.id === latestDraft?.transcriptId)
  const pending = latestDraft?.items.filter((i) => i.decision === 'pending').length ?? 0
  const live = latest?.status === 'live'
  const llm = ai.status.llm.available
  // Whether a hosted client exists at all (egress allowed AND a key set): then consultation text can leave this computer, for whichever of these
  // features is switched on. "Drafting available" alone is not the test: photograph descriptions, Mana summaries or a hosted extractor can exist without it.
  const hostedReachable = ai.status.egress.destination !== null
  const ex = ai.status.extraction
  const hostedFeatures = [llm && 'drafting and AI suggestions', ai.status.qa.available && 'Mana summaries', ai.status.vision.available && 'photograph descriptions', ex.available && !ex.local && 'the important points'].filter((x): x is string => !!x)
  const tabs: [Tab, string, number][] = [
    ['draft', 'Note suggestions', pending],
    ['recommendations', 'Recommendations', ai.recommendations.filter((r) => r.status === 'pending' || r.status === 'deferred').length],
    ['activity', 'Activity', ai.jobs.filter((j) => j.status === 'failed').length],
  ]

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 text-ai" />
          AI consultation assistant
        </span>
      }
    >
      <div className="@container space-y-4">
        <p className="text-xs text-ink-muted">
          An older assistant: note suggestions drafted from the transcript by a hosted model (off unless this server allows hosted AI), safety checks by fixed rules, and the activity log. Everything here is a draft for you to review. Accepting a suggestion does not put it in the note: “Add to …” does, as a separate step, and signing is always your separate action. The assistant is not clinically validated. The local AI draft, with its clinical summary, is in “Consultation intelligence”.
        </p>
        <ul className="flex flex-wrap gap-2 text-xs">
          <li>
            <Badge tone={llm ? 'ok' : 'neutral'}>AI drafting: {llm ? `available (${ai.status.llm.model})` : 'unavailable'}</Badge>
          </li>
          <li>
            <span data-testid="egress-badge">
              <Badge tone={ai.status.egress.hosted ? 'notice' : 'neutral'}>
                Hosted AI: {ai.status.egress.hosted ? (ai.status.egress.destination ? `allowed (to ${ai.status.egress.destination})` : 'allowed, no provider key') : 'off'}
              </Badge>
            </span>
          </li>
          <li>
            <Badge tone="notice">Safety rules: always on</Badge>
          </li>
        </ul>
        {hostedReachable ? (
          <p className="text-xs text-ink-muted" data-testid="external-disclosure">
            <strong className="font-semibold text-ink">External service.</strong> Hosted AI is allowed on this server. {hostedFeatures.length ? `${hostedFeatures.join(', ')} send` : 'The features that use it (none is switched on at the moment) would send'} consultation text (the patient’s name, MRN and phone number removed, which is best effort) to {ai.status.egress.destination}, which is not on this computer, after the patient’s consent and your click. Audio is never sent. Safety rules{ai.status.extraction.local ? ', the important points' : ''} and speech-to-text run {ai.status.stt.local ? 'on this computer' : `on ${ai.status.stt.host ?? 'another computer'}, not this one`}.
          </p>
        ) : (
          <p className="text-xs text-ink-muted" data-testid="egress-off-note">
            <strong className="font-semibold text-ink">Nothing leaves this computer.</strong> {ai.status.egress.hosted ? 'Hosted AI is allowed on this server but no provider key is configured.' : 'Hosted AI is switched off on this server: a server setting that this screen cannot change.'} Safety rules{ai.status.extraction.local ? ', the important points' : ''} and speech-to-text run {ai.status.stt.local ? 'here' : `on ${ai.status.stt.host ?? 'another computer'}, not this one`}.
          </p>
        )}
        {!ai.consent.granted && <p className="text-sm text-ink-muted">Record the patient’s consent in “Live transcription” to use drafting and record-aware suggestions.</p>}
        {ai.consent.granted && !ai.consent.current && (
          <Alert tone="info" title="Consent wording has changed">
            The patient agreed to an earlier wording that did not cover using their record for recommendations. Drafting still works. To use record-aware AI recommendations, read the current wording to the patient and record it in “Live transcription”.
          </Alert>
        )}
        {ai.consent.granted && latest && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Draft note passages from the transcript</p>
              <Button
                size="sm"
                icon={<Sparkles aria-hidden="true" className="size-4" />}
                disabled={!llm || live || !latest.segments.length}
                loading={draft.isPending}
                onClick={() => draft.mutate(latest.id, { onSuccess: () => (setTab('draft'), toast('success', 'Draft ready for review')), ...refreshOnError })}
              >
                {latestDraft?.transcriptId === latest.id ? 'Draft again' : 'Generate draft'}
              </Button>
            </div>
            {!llm && <Alert tone="info">{ai.status.llm.reason} Write the note yourself; the transcript is saved for reference.</Alert>}
            {draft.isError && (
              <Alert tone="error" title="Drafting failed">
                {errorMessage(draft.error)}
                {draft.error instanceof ApiError && draft.error.status === 502 ? ' See Activity to retry.' : ''}
              </Alert>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-sm text-ink-muted">
            Safety rules check the prescription against recorded allergies, vital signs, missing information and red-flag phrases.{ai.consent.granted && llm ? ' AI suggestions also use the record and transcript.' : ''}
          </p>
          <Button size="sm" variant="secondary" icon={<ShieldAlert aria-hidden="true" className="size-4" />} loading={recommend.isPending} onClick={() => recommend.mutate(ai.consent.granted && llm, { onSuccess: () => (setTab('recommendations'), toast('success', 'Recommendations updated')), ...refreshOnError })}>
            Get recommendations
          </Button>
        </div>
        {recommend.isError && <Alert tone="error">{errorMessage(recommend.error)}</Alert>}

        <div role="tablist" aria-label="Assistant output" className="flex flex-wrap gap-1 border-b border-line">
          {tabs.map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${tabsId}-${key}`}
              aria-selected={tab === key}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                const i = tabs.findIndex(([k]) => k === tab)
                const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]![0]
                setTab(next)
                document.getElementById(`${tabsId}-${next}`)?.focus()
              }}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? 'border-brand text-brand-strong' : 'border-transparent text-ink-muted hover:text-ink'}`}
            >
              {label}
              {n > 0 && <span className="ml-1 rounded-full bg-ai-soft px-1.5 text-xs text-ai">{n}</span>}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
          {tab === 'draft' &&
            (latestDraft ? (
              <section aria-label="Suggestions to review" className="space-y-2">
                <p className="text-sm font-medium">
                  Suggestions to review {pending > 0 && <Badge tone="ai">{pending} pending</Badge>}{' '}
                  <span className="text-xs font-normal text-ink-muted">
                    · {latestDraft.run.model} · prompt {latestDraft.run.promptVersion} · {fmtDateTime(latestDraft.createdAt)}
                  </span>
                </p>
                {latestDraft.items.length === 0 && <p className="text-sm text-ink-muted">The assistant found nothing to suggest from this transcript.</p>}
                <ul className="space-y-2">
                  {latestDraft.items
                    .filter((i) => i.decision !== 'superseded')
                    .map((i) => (
                      <SuggestionCard key={i.id} item={i} transcript={draftTranscript} encounterId={id} inserter={inserter} onFocusSources={focusLines} />
                    ))}
                </ul>
              </section>
            ) : (
              <p className="text-sm text-ink-muted">No note draft yet. Use “Generate draft” once there is a transcript.</p>
            ))}
          {tab === 'recommendations' && <RecommendationsView recommendations={ai.recommendations} jobs={ai.jobs} encounterId={id} inserter={inserter} onFocus={focusLines} />}
          {tab === 'activity' && <ActivityView ai={ai} encounterId={id} />}
        </div>
      </div>
    </Card>
  )
}
