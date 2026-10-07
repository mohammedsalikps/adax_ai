import { type ClinicalFact, type Encounter, type EncounterAi, FACT_SECTION, FACT_STATE_LABELS, factState, type ReviewRequest } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Circle, ListChecks, Pencil, RefreshCw, X } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { type AiResponse, aiKey, useAiMutation } from '../../lib/ai.ts'
import { api, ApiError, errorMessage } from '../../lib/api.ts'
import { fmtOffset } from '../../lib/capture.ts'
import { isDemoTranscript, pointProvenance } from '../../lib/demoConsultation.ts'
import { fmtTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { EvidenceList } from '../ai/Evidence.tsx'
import { InsertButton } from '../ai/InsertButton.tsx'
import { HeroEmpty, PanelGroup } from '../hero/index.ts'
import { Button } from '../ui/Button.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { DemoAudioMark } from './DemoConsultation.tsx'
import { categoryLabel, groupPoints, pointFlags, pointGroupOf, pointLineKeys, pointNeedsTick, pointSpeaker, pointTime, pointWhere } from './live.ts'

export interface ExtractionControl {
  /** The fixed rules are running now. */
  running: boolean
  /** Why the last run did not finish (shown quietly; the next part, or "Find important points", runs them again). */
  error: string | null
  /** Points are found by themselves after each part (only the fixed rules on this computer do that). */
  auto: boolean
  /** "Find important points" can be used now (lines exist, the extractor is there, the consultation is open, consent is on record). */
  canRun: boolean
  run: () => void
}

/**
 * "Important points" under the conversation (DESIGN §5.4): what the fixed rules found in what was said, grouped (Symptoms, Duration, History,
 * Medicines, Allergy, Examination, Plan…), each a draft until the doctor confirms or rejects it, right there; the explicit tick when the server
 * requires it (who said it was guessed, a flag to check); where it came from on expand. Found again after each part; never confirmed by
 * anything but the doctor, and never written to the note but by "Add to note".
 */
export const ImportantPoints = memo(function ImportantPoints({
  encounter,
  ai,
  inserter,
  currentTranscriptId,
  onFocus,
  onShowEarlier,
  extraction,
}: {
  encounter: Pick<Encounter, 'id'>
  ai: EncounterAi
  inserter: NoteInserter
  /** The recording whose conversation the panel shows; a point from another one is in "Earlier recordings". */
  currentTranscriptId: string | null
  /** Points at a point's source lines, each named with its recording (live.ts lineKey): line labels restart at S1 in every recording. */
  onFocus: (lineKeys: string[]) => void
  /** Shows a point's source lines in an earlier recording (where they are), pointed at. Without it such a point's time is plain text. */
  onShowEarlier?: ((lineKeys: string[]) => void) | undefined
  extraction: ExtractionControl
}) {
  const ex = ai.status.extraction
  const { groups, rejected, toReview, confirmed } = groupPoints(ai.facts, ai.transcripts)
  const hasLines = ai.transcripts.some((t) => t.segments.length > 0)
  const skipped = ai.jobs.find((j) => j.kind === 'extraction' && j.status === 'succeeded')?.summary?.skippedLines
  const shown = groups.reduce((n, g) => n + g.points.length, 0)
  const focus: PointFocus = { currentTranscriptId, onFocus, onShowEarlier }
  return (
    <PanelGroup
      label="Important points"
      icon={ListChecks}
      testId="important-points"
      actions={
        extraction.running ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted" data-testid="points-updating">
            <RefreshCw aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
            Updating…
          </span>
        ) : extraction.canRun ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden="true" className="size-4" />} onClick={extraction.run}>
            Find important points
          </Button>
        ) : undefined
      }
    >
      {/* Read out politely when the count changes; the list itself says the rest. */}
      <p className="sr-only" aria-live="polite">
        {toReview ? `${toReview} important point${toReview === 1 ? '' : 's'} to review` : confirmed ? `${confirmed} confirmed` : ''}
      </p>
      {!ex.available && <HeroEmpty>Important points are not available: {ex.reason ?? 'the extractor is switched off.'}</HeroEmpty>}
      {ex.available && !hasLines && <HeroEmpty testId="points-empty">Points appear here as the conversation is transcribed.</HeroEmpty>}
      {ex.available && hasLines && shown === 0 && rejected.length === 0 && !extraction.running && <HeroEmpty testId="points-empty">{extraction.auto ? 'No important points found yet. They are looked for after each part.' : 'No important points found yet.'}</HeroEmpty>}
      {typeof skipped === 'number' && skipped > 0 && (
        <p className="mb-2 text-xs text-ink-muted">
          {skipped} line{skipped === 1 ? ' is' : 's are'} not in English, the only language the rules read: nothing was found in {skipped === 1 ? 'it' : 'them'}.
        </p>
      )}
      {extraction.error && (
        <p className="mb-2 text-xs text-pending" data-testid="points-error">
          The points could not be updated just now ({extraction.error}).
        </p>
      )}
      <div className="space-y-3">
        {groups.map((g) => (
          <PointList key={g.key} label={g.label} points={g.points} ai={ai} encounterId={encounter.id} inserter={inserter} focus={focus} />
        ))}
      </div>
      {rejected.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">Rejected ({rejected.length})</summary>
          <ul className="mt-1">
            {rejected.map((f) => (
              <PointRow key={f.id} f={f} ai={ai} encounterId={encounter.id} inserter={inserter} focus={focus} />
            ))}
          </ul>
        </details>
      )}
    </PanelGroup>
  )
})

/** Where a point's source lines are shown, and how to point at them. */
interface PointFocus {
  currentTranscriptId: string | null
  onFocus: (lineKeys: string[]) => void
  onShowEarlier?: ((lineKeys: string[]) => void) | undefined
}

function PointList({ label, points, ai, encounterId, inserter, focus }: { label: string; points: ClinicalFact[]; ai: EncounterAi; encounterId: string; inserter: NoteInserter; focus: PointFocus }) {
  const id = useId()
  return (
    <div>
      <h4 id={id} className="text-xs font-medium text-ink-muted">
        {label}
      </h4>
      <ul aria-labelledby={id}>
        {points.map((f) => (
          <PointRow key={f.id} f={f} ai={ai} encounterId={encounterId} inserter={inserter} focus={focus} />
        ))}
      </ul>
    </div>
  )
}

function PointRow({ f, ai, encounterId, inserter, focus }: { f: ClinicalFact; ai: EncounterAi; encounterId: string; inserter: NoteInserter; focus: PointFocus }) {
  const state = factState(f.status)
  const t = ai.transcripts.find((x) => x.id === f.transcriptId)
  const speaker = pointSpeaker(f, t)
  const [ticked, setTicked] = useState(false)
  const [forceTick, setForceTick] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(f.text)
  const tickId = useId()
  const qc = useQueryClient()
  const m = useAiMutation<ReviewRequest>(encounterId, (body) => api<AiResponse>(`/ai-review/fact/${f.id}`, { method: 'POST', body }))
  const undecided = f.status === 'pending' || f.status === 'deferred'
  const needsTick = undecided && (forceTick || pointNeedsTick(f, t))
  const blocked = needsTick && !ticked
  const at = pointTime(f, ai.transcripts)
  const firstLine = f.sourceSegmentIds[0]
  // Its lines are pointed at with their recording: in the conversation shown, or in the earlier recording they are in (never the current
  // recording's line that only shares the label).
  const where = pointWhere(f, focus.currentTranscriptId)
  const lines = pointLineKeys(f, f.sourceSegmentIds)
  const { onFocus, onShowEarlier } = focus
  const showLines = where === 'current' ? () => onFocus(lines) : onShowEarlier ? () => onShowEarlier(lines) : null
  const section = FACT_SECTION[f.category]
  const flags = pointFlags(f, speaker.guessed)
  // The server has the last word: a tick it asks for is shown; a point a newer run replaced meanwhile is not dwelt on, the list is read again.
  const act = (body: ReviewRequest) =>
    m.mutate(body, {
      onSuccess: () => setEditing(false),
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'confirmation_required') setForceTick(true)
        if (e instanceof ApiError && e.code === 'already_decided') void qc.invalidateQueries({ queryKey: aiKey(encounterId) })
      },
    })
  const decide = (action: 'accepted' | 'rejected' | 'deferred') => act(action === 'accepted' ? { action, confirmFlags: ticked } : { action })
  const pending = (a: string) => m.isPending && m.variables?.action === a
  return (
    <li className="border-t border-line/70 py-2.5 first:border-t-0" data-testid="important-point" data-state={state} data-category={f.category}>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
        <span className="mt-0.5 shrink-0" aria-hidden="true">
          {state === 'confirmed' ? <Check className="size-4 text-ok" /> : state === 'rejected' ? <X className="size-4 text-ink-muted" /> : <Circle className={`size-4 ${f.flags.includes('red_flag') ? 'text-down' : 'text-pending'}`} strokeDasharray="3 3" />}
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <p className={`text-sm leading-6 break-words ${state === 'rejected' ? 'text-ink-muted line-through' : ''}`}>
            {f.finalText ?? f.text}
            {f.negated && <span className="text-ink-muted"> · denied</span>}
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
            {/* A draft says so to a screen reader; on screen its dashed mark and its Confirm / Reject say it. */}
            {state === 'extracted' && f.status !== 'deferred' ? (
              <span className="sr-only">{FACT_STATE_LABELS.extracted}. </span>
            ) : (
              <>
                <span className={state === 'confirmed' ? 'font-medium text-ok' : ''}>{f.status === 'deferred' ? 'Set aside' : FACT_STATE_LABELS[state === 'superseded' ? 'extracted' : state]}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            {pointGroupOf(f.category).categories.length > 1 && (
              <>
                <span>{categoryLabel(f.category)}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className={speaker.guessed || speaker.contradicted ? 'text-pending' : ''}>{speaker.text}</span>
            {at !== null && firstLine && (
              <>
                <span aria-hidden="true">·</span>
                {showLines ? (
                  <button type="button" className="rounded tabular-nums underline-offset-2 hover:text-ink hover:underline" onClick={showLines} aria-label={`Show line at ${fmtOffset(at)} ${where === 'current' ? 'in the conversation' : 'in an earlier recording'}`}>
                    {fmtOffset(at)}
                  </button>
                ) : (
                  <span className="tabular-nums">{fmtOffset(at)}</span>
                )}
                {where === 'earlier' && <span data-testid="point-earlier-recording">in an earlier recording</span>}
              </>
            )}
          </p>
          {state !== 'rejected' && (flags.length > 0 || f.speakerChanged) && (
            <ul className="mt-0.5 space-y-0.5 text-xs" aria-label="Review flags">
              {flags.map((x) => (
                <li key={x.flag} className={x.tone === 'down' ? 'font-medium text-down' : 'text-pending'}>
                  ⚑ {x.text}
                </li>
              ))}
              {f.speakerChanged && (
                <li className="text-pending" data-testid="speaker-changed">
                  ⚑ A speaker of its source line was changed after it was found: who said it may be out of date.
                </li>
              )}
            </ul>
          )}
        </div>
        {undecided && !editing && (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="subtle" icon={<Check aria-hidden="true" className="size-4" />} disabled={blocked} loading={pending('accepted')} onClick={() => decide('accepted')} aria-describedby={needsTick ? tickId : undefined}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} loading={pending('rejected')} onClick={() => decide('rejected')}>
              Reject
            </Button>
          </div>
        )}
      </div>
      {needsTick && (
        <label className="mt-1.5 ml-6 flex items-start gap-2 text-xs font-medium">
          <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span id={tickId}>I have checked this against the conversation and the record</span>
        </label>
      )}
      {editing && (
        <div className="mt-2 ml-6 space-y-2">
          <TextAreaField label="Edit before confirming" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} disabled={!draft.trim() || blocked} loading={pending('edited')} onClick={() => act({ action: 'edited', text: draft, confirmFlags: ticked })}>
              Confirm edited text
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {m.isError && <p className="mt-1 ml-6 text-xs text-down">{errorMessage(m.error)}</p>}
      {state === 'confirmed' && section && (
        // A quiet text action (premium design), not a full button: "+ Add to Chief complaint".
        <div className="ml-6 [&_button]:min-h-7 [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-0 [&_button]:text-xs [&_button]:font-semibold [&_button]:text-brand-strong [&_button]:shadow-none [&_button:hover]:underline">
          <InsertButton inserter={inserter} section={section} text={f.finalText ?? f.text} subject={{ type: 'fact', id: f.id }} />
        </div>
      )}
      {state !== 'rejected' && (
        <details className="group/point mt-1 ml-6 text-xs">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">Details</summary>
          <div className="mt-1.5 space-y-1.5">
            {/* The conversation says once that it is synthetic demo audio; each point says so here, under Details. */}
            {isDemoTranscript(t) && <DemoAudioMark>From synthetic demo audio</DemoAudioMark>}
            <p className="text-ink-muted" data-testid="point-provenance">
              {pointProvenance(f.producedBy, state === 'extracted')} · {fmtTime(f.createdAt)}
            </p>
            <EvidenceList evidence={f.evidence} onFocusSegments={(ids) => onFocus(pointLineKeys(f, ids))} />
            {undecided && !editing && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="ghost" icon={<Pencil aria-hidden="true" className="size-4" />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                {f.status === 'pending' && (
                  <Button size="sm" variant="ghost" loading={pending('deferred')} onClick={() => decide('deferred')}>
                    Set aside
                  </Button>
                )}
              </div>
            )}
          </div>
        </details>
      )}
    </li>
  )
}
