import { type ClinicalFact, type Encounter, type EncounterAi, FACT_CATEGORIES, FACT_FLAGS, FACT_SECTION, FACT_STATE_LABELS, type FactFlag, factState, type Transcript } from '@adaxai/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, FileAudio, ListChecks, Mic, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { type AiResponse, aiKey, useAiMutation } from '../../lib/ai.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { useStillSamePerson } from '../../lib/auth.tsx'
import { clinicianReason, fmtOffset, languageName, useAssignSpeakers, useExtractPoints } from '../../lib/capture.ts'
import { isDemoTranscript, newLineIds, pointProvenance, revealMs, revealText, transcriptSourceLabel } from '../../lib/demoConsultation.ts'
import { focusLines, useFocusedLines } from '../../lib/focusLines.ts'
import { fmtDateTime, fmtTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { EvidenceList } from '../ai/Evidence.tsx'
import { InsertButton } from '../ai/InsertButton.tsx'
import { ReviewControls } from '../ai/ReviewControls.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, Spinner } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'
import { DemoAudioMark, DemoConsultation, useReducedMotion } from './DemoConsultation.tsx'
import { Recorder } from './Recorder.tsx'
import { TranscriptView } from './TranscriptView.tsx'

const ATTRIBUTION: Record<string, string> = { patient_reported: 'Patient said', clinician_stated: 'Doctor said', other_speaker: 'Speaker not identified' }

/** Seconds, for where the cursor is on a line's source: the first source line's time, as m:ss, if it has one. */
const timeOf = (ai: EncounterAi, f: ClinicalFact) => {
  const t = ai.transcripts.find((x) => x.id === f.transcriptId)
  const starts = f.sourceSegmentIds.map((id) => t?.segments.find((s) => s.id === id)?.startMs).filter((x): x is number => typeof x === 'number')
  return starts.length ? Math.min(...starts) : null
}

/**
 * The capture side of a consultation, in two cards with three visibly different kinds of content: the RAW transcript (what the system
 * heard), EXTRACTED drafts (what the system thinks may matter) and what the doctor CONFIRMED. Nothing moves from one to the next without the
 * doctor, and none of it is part of the record until the doctor puts it into the note.
 */
export function CapturePanel({ encounter, inserter }: { encounter: Encounter; inserter: NoteInserter }) {
  const id = encounter.id
  const q = useQuery({ queryKey: aiKey(id), queryFn: () => api<EncounterAi>(`/encounters/${id}/ai`) })
  const highlight = useFocusedLines()
  if (q.isPending)
    return (
      <Card title="Live transcription">
        <Spinner />
      </Card>
    )
  if (q.isError)
    return (
      <Card title="Live transcription">
        <Alert tone="error">{errorMessage(q.error)}</Alert>
      </Card>
    )
  return (
    <>
      <LiveTranscriptionCard encounter={encounter} ai={q.data} highlight={highlight} />
      <ImportantPointsCard encounter={encounter} ai={q.data} inserter={inserter} onFocus={focusLines} />
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------------------------

function ConsentLine({ encounter, ai }: { encounter: Encounter; ai: EncounterAi }) {
  const toast = useToast()
  const consent = useAiMutation<{ method: 'verbal' | 'written' }>(encounter.id, (body) => api(`/encounters/${encounter.id}/ai-consent`, { method: 'POST', body }))
  if (ai.consent.granted) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-ok" data-testid="recording-consent">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Recording consent {ai.consent.scope === 'encounter' ? 'recorded for this consultation' : 'recorded (ongoing)'} · {fmtDateTime(ai.consent.recordedAt)}
        </span>
      </p>
    )
  }
  return (
    <div className="rounded-lg border border-line p-3 text-sm" data-testid="recording-consent">
      <p className="font-medium">The patient’s consent to recording is needed</p>
      <p className="mt-1 text-ink-muted">
        Ask the patient whether this consultation may be recorded. The audio is turned into text by a speech model that runs on {ai.status.stt.local ? 'this computer; it is not sent to any other service' : `${ai.status.stt.host ?? 'another computer'}, which is not this one (the clinic’s own setting); it is not sent to a hosted service`}, and it is stored with the consultation.
        {ai.status.egress.destination ? ` Hosted AI is switched on for this server: text from the consultation (without name or contact details) may also go to ${ai.status.egress.destination}, which is not on this computer, for the AI steps the doctor chooses. The audio never does.` : ''} Declining does not affect their care.
      </p>
      {consent.isError && (
        <Alert tone="error" className="mt-2">
          {errorMessage(consent.error)}
        </Alert>
      )}
      <div className="mt-3">
        <Button size="sm" loading={consent.isPending} onClick={() => consent.mutate({ method: 'verbal' }, { onSuccess: () => toast('success', 'Consent recorded for this consultation') })}>
          Patient agrees (verbal)
        </Button>
      </div>
    </div>
  )
}

function LiveTranscriptionCard({ encounter, ai, highlight }: { encounter: Encounter; ai: EncounterAi; highlight: ReadonlySet<string> }) {
  const toast = useToast()
  const qc = useQueryClient()
  const id = encounter.id
  const samePerson = useStillSamePerson()
  const [text, setText] = useState('')
  const open = encounter.status === 'in_progress' && encounter.canEdit
  const extract = useExtractPoints(id)
  const saveTranscript = useAiMutation<{ text: string }>(id, (body) => api(`/encounters/${id}/transcripts`, { method: 'POST', body: { ...body, source: 'typed' } }))
  const uploadAudio = useAiMutation<{ blob: File }>(id, ({ blob }) => {
    const fd = new FormData()
    fd.append('source', 'audio_upload')
    fd.append('file', blob, blob.name)
    return api(`/encounters/${id}/audio`, { method: 'POST', body: fd })
  })
  const retry = useAiMutation<string>(id, async (jobId) => {
    const r = await api<{ encounter?: EncounterAi }>(`/ai-jobs/${jobId}/retry`, { method: 'POST' })
    return (r.encounter ?? (await api<EncounterAi>(`/encounters/${id}/ai`))) as AiResponse
  })
  const stt = ai.status.stt
  const live = ai.transcripts.some((t) => t.status === 'live')
  // The demo consultation holds the recording (playing, or its recording left open): the microphone recorder waits, as starting would be refused.
  const [demoPlaying, setDemoPlaying] = useState(false)
  const demoLive = ai.transcripts.some((t) => t.status === 'live' && isDemoTranscript(t))
  const latest = ai.transcripts.at(-1)
  const earlier = ai.transcripts.slice(0, -1)
  const onUpdate = useCallback(
    (r: AiResponse) => {
      if (r.consent) qc.setQueryData(aiKey(id), r)
      if (r.notice) toast('error', r.notice)
    },
    [qc, id, toast],
  )
  const failedJob = ai.jobs.find((j) => j.kind === 'transcription' && j.status === 'failed' && j.retryable)

  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Mic aria-hidden="true" className="size-4 text-ink-muted" />
          Live transcription
        </span>
      }
      actions={
        demoLive ? (
          // Synthetic demo audio is never shown as a recording (the red Recording badge is the microphone's).
          <DemoAudioMark />
        ) : live ? (
          <Badge tone="down" dot>
            Recording
          </Badge>
        ) : latest?.language ? (
          <Badge>{languageName(latest.language)}</Badge>
        ) : undefined
      }
      bodyClassName="space-y-3 p-4"
    >
      <div data-testid="live-transcription">
        <ConsentLine encounter={encounter} ai={ai} />

        <div className="mt-3 space-y-2">
          {stt.available ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted" data-testid="speech-status">
              <Badge tone={stt.local ? 'ok' : 'notice'} dot>
                {stt.local ? 'Local' : 'Another computer'}
              </Badge>
              <span>
                {stt.local ? `Speech-to-text runs on this computer (${stt.model}). Audio is sent to no other service.` : `Speech-to-text runs on ${stt.host ?? 'another computer'} (${stt.model}), which is not this computer: audio goes there. It is never sent to a hosted service.`} Not clinically validated.
              </span>
            </p>
          ) : (
            <Alert tone="warning" title="Local transcription unavailable" className="text-sm">
              {/* The service's reason without its setup instructions (a command to run is not the clinician's to do). */}
              <span data-testid="speech-unavailable">{clinicianReason(stt.reason)}</span>
              <span className="mt-1 block text-xs">
                No audio is ever sent to a hosted service instead. You can still add a typed transcript or upload a recording, which is transcribed here once the service is running.
              </span>
            </Alert>
          )}
          {open && !demoPlaying && !demoLive && <Recorder encounterId={id} chunkSeconds={ai.status.liveChunkSeconds} consentGranted={ai.consent.granted} consentWithdrawn={latest?.endReason === 'consent_withdrawn'} onUpdate={onUpdate} onStopped={(tid) => extract.mutate(tid, { onSuccess: () => toast('success', 'Important points updated: review them below') })} />}
          {open && (demoPlaying || demoLive) && <p className="text-xs text-ink-muted">The microphone recorder returns when the demo’s recording has ended.</p>}
          {open && <DemoConsultation encounter={encounter} ai={ai} onUpdate={onUpdate} onActiveChange={setDemoPlaying} />}
          {!open && <p className="text-sm text-ink-muted">Recording is closed: this consultation is {encounter.status === 'signed' ? 'signed' : 'not open for editing'}.</p>}
        </div>
      </div>

      {latest && (
        <TranscriptSection
          t={latest}
          ai={ai}
          encounter={encounter}
          highlight={highlight}
          follow={live}
          open={open}
          onRetry={failedJob ? () => retry.mutate(failedJob.id) : undefined}
          retrying={retry.isPending}
          extractLoading={extract.isPending}
          onExtract={() => extract.mutate(latest.id, { onSuccess: () => toast('success', 'Important points updated: review them below') })}
          defaultOpen
        />
      )}
      {earlier.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-brand-strong">Earlier transcripts ({earlier.length})</summary>
          <div className="mt-2 space-y-3">
            {[...earlier].reverse().map((t) => (
              <TranscriptSection key={t.id} t={t} ai={ai} encounter={encounter} highlight={highlight} follow={false} open={open} extractLoading={extract.isPending} onExtract={() => extract.mutate(t.id)} />
            ))}
          </div>
        </details>
      )}
      {extract.isError && (
        <Alert tone="error" title="Important points could not be updated">
          {errorMessage(extract.error)}
        </Alert>
      )}

      {open && ai.consent.granted && (
        <details className="rounded-lg border border-line text-sm">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-medium">
            <ChevronDown aria-hidden="true" className="size-4" />
            Other ways to add a transcript
          </summary>
          <div className="space-y-3 border-t border-line p-3">
            <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-brand-strong underline underline-offset-2">
              <FileAudio aria-hidden="true" className="size-4" />
              Upload an audio file ({stt.local ? 'transcribed on this computer' : `transcribed on ${stt.host ?? 'another computer'}`})
              <input
                type="file"
                accept="audio/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f && samePerson()) uploadAudio.mutate({ blob: f })
                  e.target.value = ''
                }}
              />
            </label>
            {uploadAudio.isPending && <Spinner label="Uploading audio…" />}
            {uploadAudio.isError && <Alert tone="error">{errorMessage(uploadAudio.error)}</Alert>}
            <div className="space-y-2">
              <TextAreaField label="Or type or paste a transcript" hint="Typed text is not recorded speech: it has no times or language. One line per utterance; start lines with “Doctor:” or “Patient:” to label speakers." rows={4} value={text} onChange={(e) => setText(e.target.value)} />
              {saveTranscript.isError && <Alert tone="error">{errorMessage(saveTranscript.error)}</Alert>}
              <Button size="sm" variant="secondary" disabled={!text.trim()} loading={saveTranscript.isPending} onClick={() => saveTranscript.mutate({ text }, { onSuccess: () => setText('') })}>
                Save typed transcript
              </Button>
            </div>
          </div>
        </details>
      )}
      {ai.audio.length > 0 && (
        <ul className="space-y-1 text-xs text-ink-muted" aria-label="Saved recordings">
          {ai.audio.map((a) => (
            <li key={a.fileId}>
              <audio controls preload="none" src={`/api/files/${a.fileId}`} className="w-full" aria-label={`Recording from ${fmtDateTime(a.createdAt)}`} />
              {fmtDateTime(a.createdAt)} · {(a.sizeBytes / 1024).toFixed(0)} KB · {a.transcriptId ? 'transcribed' : 'not transcribed'}
            </li>
          ))}
        </ul>
      )}
      {ai.transcripts.length === 0 && !live && <p className="text-sm text-ink-muted">Nothing has been recorded or typed yet. What is heard appears here as raw transcript, line by line, with its time.</p>}
    </Card>
  )
}

/**
 * A transcript as it is drawn. A line that arrives while the transcript is live (a recording, or the demo consultation) appears word by word,
 * in at most 600 ms (lines that arrived together, together): only the words that arrived, never others, and only on the screen (the transcript
 * is not changed). With reduced motion, and for the lines already there when the transcript is first shown, at once.
 */
function useWordReveal(t: Transcript): Transcript {
  const reduced = useReducedMotion()
  const live = t.status === 'live'
  const known = useRef<{ tid: string; ids: Set<string> } | null>(null)
  const [starts, setStarts] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [now, setNow] = useState(0)
  // Before the browser paints the new line, so that it never shows whole and then starts again.
  useLayoutEffect(() => {
    const ids = t.segments.map((s) => s.id)
    const k = known.current
    if (!k || k.tid !== t.id) {
      known.current = { tid: t.id, ids: new Set(ids) }
      setStarts((m) => (m.size ? new Map() : m))
      return
    }
    const fresh = newLineIds(k.ids, ids)
    for (const x of fresh) k.ids.add(x)
    if (!fresh.length || !live || reduced) return
    const at = performance.now()
    setStarts((m) => new Map([...m, ...fresh.map((x) => [x, at] as const)]))
    setNow(at)
  }, [t.id, t.segments, live, reduced])
  // About 25 frames a second while words are appearing; nothing otherwise.
  useEffect(() => {
    if (!starts.size) return
    const timer = setInterval(() => setNow(performance.now()), 40)
    return () => clearInterval(timer)
  }, [starts])
  useEffect(() => {
    if (starts.size && [...starts].every(([x, at]) => now - at >= revealMs(t.segments.find((s) => s.id === x)?.text ?? ''))) setStarts(new Map())
  }, [now, starts, t.segments])
  return useMemo(() => {
    if (!starts.size || reduced) return t
    return {
      ...t,
      segments: t.segments.map((s) => {
        const at = starts.get(s.id)
        return at === undefined ? s : { ...s, text: revealText(s.text, now - at) }
      }),
    }
  }, [t, starts, now, reduced])
}

function TranscriptSection({
  t,
  ai,
  encounter,
  highlight,
  follow,
  open,
  onRetry,
  retrying,
  extractLoading,
  onExtract,
  defaultOpen = false,
}: {
  t: Transcript
  ai: EncounterAi
  encounter: Encounter
  highlight: ReadonlySet<string>
  follow: boolean
  open: boolean
  onRetry?: (() => void) | undefined
  retrying?: boolean
  extractLoading: boolean
  onExtract: () => void
  defaultOpen?: boolean
}) {
  const assign = useAssignSpeakers(encounter.id, t.id)
  const shown = useWordReveal(t)
  const mine = open && t.status !== 'live'
  const demo = isDemoTranscript(t)
  const unassigned = t.segments.filter((s) => !s.speaker).length
  return (
    <details open={defaultOpen || t.status === 'live'} className="group rounded-lg" data-testid="transcript-section" data-transcript-id={t.id} data-audio-origin={t.audioOrigin ?? undefined}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 py-1 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Badge>Raw transcript</Badge>
          {demo ? <DemoAudioMark /> : <span className="font-medium">{transcriptSourceLabel(t)}</span>}
        </span>
        <span className="text-xs text-ink-muted">
          {fmtTime(t.createdAt)} · {t.segments.length} line{t.segments.length === 1 ? '' : 's'}
          {t.language ? ` · ${languageName(t.language)}` : ''}
          {t.status === 'live' ? ' · live' : t.endReason === 'consent_withdrawn' ? ' · stopped: consent withdrawn' : ''}
        </span>
      </summary>
      {demo && (
        <p className="mb-1.5 text-xs font-medium text-ink" data-testid="demo-transcript-note">
          Synthetic demo audio: computer voices reading a written script through this computer’s speakers, transcribed by the speech model on this computer. Not a real consultation; no patient spoke.
        </p>
      )}
      <p className="mb-1.5 text-xs text-ink-muted">
        What the system heard, as heard. {t.source === 'browser_recording' || t.source === 'audio_upload' ? 'The speech model does not identify who spoke: you assign it, line by line, and it is kept as your review. ' : ''}
        {unassigned > 0 && t.segments.length > 0 ? `${unassigned} line${unassigned === 1 ? ' has' : 's have'} no speaker yet.` : ''}
      </p>
      {assign.isError && (
        <Alert tone="error" className="mb-1.5">
          {errorMessage(assign.error)}
        </Alert>
      )}
      <TranscriptView
        transcript={shown}
        highlight={highlight}
        canAssign={mine}
        assigning={assign.isPending}
        follow={follow}
        onAssign={(segmentId, speaker) => assign.mutate({ assignments: [{ segmentId, speaker }] })}
        onRetry={onRetry}
        retrying={retrying}
      />
      {t.segments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={<ListChecks aria-hidden="true" className="size-4" />} disabled={!open || t.status === 'live' || !ai.status.extraction.available || !ai.consent.granted} loading={extractLoading} onClick={onExtract}>
            Find important points
          </Button>
          <span className="text-xs text-ink-muted">Assign speakers first for a better reading.</span>
        </div>
      )}
    </details>
  )
}

// ---------------------------------------------------------------------------------------------------------------------------------------

function PointCard({ f, ai, encounterId, inserter, onFocus }: { f: ClinicalFact; ai: EncounterAi; encounterId: string; inserter: NoteInserter; onFocus: (ids: string[]) => void }) {
  const state = factState(f.status)
  const flags = f.flags as FactFlag[]
  const section = FACT_SECTION[f.category]
  const t = ai.transcripts.find((x) => x.id === f.transcriptId)
  // Nobody said who spoke the source line: the extractor guessed the side from the wording, and the card says so rather than "Patient said".
  const guessed = (f.attribution === 'patient_reported' || f.attribution === 'clinician_stated') && f.sourceSegmentIds.some((sid) => !t?.segments.find((x) => x.id === sid)?.speaker)
  // The doctor has since marked a source line as spoken by the other side: "Patient said" would be stale.
  const heard = f.sourceSegmentIds.map((sid) => t?.segments.find((x) => x.id === sid)?.speaker).filter((x): x is string => !!x)
  const contradicted = f.attribution === 'patient_reported' ? heard.find((x) => x === 'Doctor' || x === 'Nurse') : f.attribution === 'clinician_stated' ? heard.find((x) => ['Patient', 'Relative', 'Attendant'].includes(x)) : undefined
  const needsConfirm = !!contradicted || flags.some((x) => ['uncertain', 'no_source', 'conflicts_with_record', 'speaker_mismatch'].includes(x))
  // Found by the fixed rules: a draft to review, in the review colour with the rules' icon. Violet and Sparkles are for a model's output only.
  const rules = f.producedBy.provider === 'adaxai-rules'
  const draftTone = rules ? 'border-dashed border-pending/40 bg-pending-soft/30' : 'border-dashed border-ai/50 bg-ai-soft/40'
  const tone = state === 'confirmed' ? 'border-ok/40 bg-ok-soft/40' : state === 'rejected' ? 'border-line bg-canvas' : draftTone
  return (
    <li className={`rounded-lg border p-3 ${tone} ${flags.includes('red_flag') && state === 'extracted' ? 'border-down/50' : ''}`} data-testid="important-point" data-state={state} data-category={f.category}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {state === 'confirmed' ? (
          <Badge tone="ok" icon={<Check aria-hidden="true" className="size-3" />}>
            {FACT_STATE_LABELS.confirmed}
          </Badge>
        ) : state === 'rejected' ? (
          <Badge icon={<X aria-hidden="true" className="size-3" />}>{FACT_STATE_LABELS.rejected}</Badge>
        ) : (
          <Badge tone={rules ? 'warn' : 'ai'} icon={rules ? <ListChecks aria-hidden="true" className="size-3" /> : <Sparkles aria-hidden="true" className="size-3" />}>
            {f.status === 'deferred' ? 'Extracted draft (set aside)' : FACT_STATE_LABELS.extracted}
          </Badge>
        )}
        <span className="text-sm font-semibold">{FACT_CATEGORIES[f.category]}</span>
        {isDemoTranscript(t) && <DemoAudioMark>From synthetic demo audio</DemoAudioMark>}
        {f.negated && <Badge>Denied / negative</Badge>}
        <Badge tone={guessed || contradicted ? 'warn' : 'neutral'}>
          {contradicted ? `${ATTRIBUTION[f.attribution]}, but the source line is now marked ${contradicted}` : guessed ? `Speaker not assigned: guessed ${f.attribution === 'patient_reported' ? 'patient' : 'doctor'}` : ATTRIBUTION[f.attribution]}
        </Badge>
      </div>
      <p className={`text-sm break-words ${state === 'rejected' ? 'line-through' : ''}`}>{f.finalText ?? f.text}</p>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
        From
        {f.sourceSegmentIds.map((sid) => {
          const seg = t?.segments.find((x) => x.id === sid)
          return (
            <button key={sid} type="button" className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.6875rem] hover:bg-canvas" onClick={() => onFocus([sid])} aria-label={`Show line ${sid}${seg?.startMs != null ? ` at ${fmtOffset(seg.startMs)}` : ''} in the transcript`}>
              {seg?.startMs != null ? `${fmtOffset(seg.startMs)} · ` : ''}
              {sid}
            </button>
          )
        })}
        <span aria-hidden="true">·</span>
        <span title={`${f.producedBy.provider} ${f.producedBy.model}`} data-testid="point-provenance">
          {pointProvenance(f.producedBy, state === 'extracted')} · {fmtTime(f.createdAt)}
        </span>
      </p>
      {state !== 'rejected' && flags.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs" aria-label="Review flags">
          {flags.map((x) => (
            <li key={x} className={x === 'red_flag' || x === 'conflicts_with_record' ? 'font-medium text-down' : 'text-pending'}>
              ⚑ {FACT_FLAGS[x] ?? x}
              {x === 'uncertain' && f.uncertaintyReason ? `: ${guessed && f.uncertaintyReason.startsWith('Who said this was guessed') ? 'assign speakers, or check it against the conversation' : f.uncertaintyReason}` : ''}
            </li>
          ))}
        </ul>
      )}
      {f.speakerChanged && state !== 'rejected' && (
        <p className="mt-1 text-xs font-medium text-pending" data-testid="speaker-changed">
          ⚑ A speaker label of its source was changed after this was found: who said it may be out of date.{state === 'extracted' ? ' Find important points again.' : ''}
        </p>
      )}
      {state !== 'rejected' && (
        <div className="mt-1">
          <EvidenceList evidence={f.evidence} onFocusSegments={onFocus} />
        </div>
      )}
      <ReviewControls encounterId={encounterId} type="fact" id={f.id} text={f.text} status={f.status} confirm={needsConfirm ? 'flagged' : null} labels={{ accept: 'Confirm', edit: 'Edit', reject: 'Reject', defer: 'Set aside', saveEdited: 'Confirm edited text' }} editLabel="Edit before confirming" />
      {state === 'confirmed' && section && <InsertButton inserter={inserter} section={section} text={f.finalText ?? f.text} subject={{ type: 'fact', id: f.id }} />}
    </li>
  )
}

function ImportantPointsCard({ encounter, ai, inserter, onFocus }: { encounter: Encounter; ai: EncounterAi; inserter: NoteInserter; onFocus: (ids: string[]) => void }) {
  const ex = ai.status.extraction
  const facts = ai.facts
  const drafts = facts.filter((f) => factState(f.status) === 'extracted')
  const confirmed = facts.filter((f) => factState(f.status) === 'confirmed')
  const rejected = facts.filter((f) => factState(f.status) === 'rejected')
  const order = (a: ClinicalFact, b: ClinicalFact) => Number(b.flags.includes('red_flag')) - Number(a.flags.includes('red_flag')) || (timeOf(ai, a) ?? 1e12) - (timeOf(ai, b) ?? 1e12) || a.createdAt.localeCompare(b.createdAt)
  const skipped = ai.jobs.find((j) => j.kind === 'extraction' && j.status === 'succeeded')?.summary?.skippedLines
  const hasLines = ai.transcripts.some((t) => t.segments.length > 0)
  // The fixed rules find these points: the review colour, not the AI's violet (kept for an extractor that is a model).
  const byModel = ex.provider !== 'adaxai-rules'
  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <ListChecks aria-hidden="true" className={`size-4 ${byModel ? 'text-ai' : 'text-pending'}`} />
          Important points
        </span>
      }
      actions={drafts.length ? <Badge tone={byModel ? 'ai' : 'warn'}>{drafts.length} to review</Badge> : confirmed.length ? <Badge tone="ok">{confirmed.length} confirmed</Badge> : undefined}
      bodyClassName="space-y-3 p-4"
    >
      <div data-testid="important-points" className="space-y-3">
        <p className="text-xs text-ink-muted">
          <strong className="font-semibold text-ink">Extracted drafts</strong> are what the system thinks may matter, each tied to the transcript line it came from. They are not part of the record until you confirm them, and confirming does not write to the note: use “Add to note” for that.{' '}
          {ex.available ? (
            <span data-testid="extractor-status">
              Found by {ex.provider === 'adaxai-rules' ? 'fixed rules' : ex.provider} ({ex.version}) {ex.local ? 'on this computer' : 'by an external model'}, {ex.languages.join(', ') || 'English'} only. It matches words from lists: what it does not know it misses.
            </span>
          ) : (
            <span>{ex.reason}</span>
          )}
        </p>
        {typeof skipped === 'number' && skipped > 0 && (
          <Alert tone="info">
            {skipped} line{skipped === 1 ? ' is' : 's are'} not in a language the extractor reads (English only): nothing was extracted from {skipped === 1 ? 'it' : 'them'}. Read {skipped === 1 ? 'it' : 'them'} in the transcript.
          </Alert>
        )}
        {!hasLines && <p className="text-sm text-ink-muted">Points appear here once there is a transcript. Record the consultation, or add a transcript, then “Find important points”.</p>}
        {hasLines && facts.length === 0 && <p className="text-sm text-ink-muted">No important points have been found yet. Use “Find important points” under a transcript (it also runs when you stop a recording).</p>}
        {drafts.length > 0 && (
          <section aria-label="Extracted drafts" className="space-y-2">
            <h3 className="text-sm font-semibold">Extracted drafts ({drafts.length})</h3>
            <ul className="space-y-2">
              {[...drafts].sort(order).map((f) => (
                <PointCard key={f.id} f={f} ai={ai} encounterId={encounter.id} inserter={inserter} onFocus={onFocus} />
              ))}
            </ul>
          </section>
        )}
        {confirmed.length > 0 && (
          <section aria-label="Confirmed by the doctor" className="space-y-2">
            <h3 className="text-sm font-semibold">Doctor confirmed ({confirmed.length})</h3>
            <ul className="space-y-2">
              {[...confirmed].sort(order).map((f) => (
                <PointCard key={f.id} f={f} ai={ai} encounterId={encounter.id} inserter={inserter} onFocus={onFocus} />
              ))}
            </ul>
          </section>
        )}
        {rejected.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-ink-muted">Doctor rejected ({rejected.length})</summary>
            <ul className="mt-2 space-y-2">
              {[...rejected].sort(order).map((f) => (
                <PointCard key={f.id} f={f} ai={ai} encounterId={encounter.id} inserter={inserter} onFocus={onFocus} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  )
}
