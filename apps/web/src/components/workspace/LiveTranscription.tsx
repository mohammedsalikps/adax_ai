import { type Encounter, type EncounterAi, TRANSCRIPT_END_REASONS, type Transcript } from '@adaxai/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileAudio, History, Keyboard, ListChecks, LoaderCircle, Mic, MicOff, Pause, Play, PlayCircle, Square } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AiResponse, aiKey, useAiMutation } from '../../lib/ai.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { useStillSamePerson } from '../../lib/auth.tsx'
import { useAssignSpeakers, useAutoExtract } from '../../lib/capture.ts'
import { demoGate, isDemoTranscript, transcriptSourceLabel } from '../../lib/demoConsultation.ts'
import { focusLines, useFocusedLines } from '../../lib/focusLines.ts'
import { fmtTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { clearRecordingState, setRecordingState } from '../../lib/recordingState.ts'
import { RecordingConsent } from '../capture/Consent.tsx'
import { DemoAudioMark, DemoConsultation, useSimulatorAllowed } from '../capture/DemoConsultation.tsx'
import { ImportantPoints } from '../capture/ImportantPoints.tsx'
import { LiveWaveform, RecordingClock } from '../capture/LiveWaveform.tsx'
import { autoExtractAllowed, autoStartDecision, focusedLineIds, idleReason, NOT_RECORDING_ACTION, nextAutoIntent, notRecordingLine, otherRecordingId, panelContent, problemResolved, recordingSnapshot } from '../capture/live.ts'
import { ConversationView } from '../capture/TranscriptView.tsx'
import { useRecorder } from '../capture/useRecorder.ts'
import { useWordReveal } from '../capture/useWordReveal.ts'
import { HeroEmpty, Panel, SourceTag } from '../hero/index.ts'
import { Sheet } from '../hero/Sheet.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, LoadingState } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { Menu, type MenuItem } from '../ui/Menu.tsx'
import { useToast } from '../ui/Toast.tsx'

/** Props of the consultation's live transcription panel (DESIGN §5.4 column 1, §7). */
export interface LiveTranscriptionProps {
  encounter: Encounter
  /** The note's explicit, server-recorded insertion (never a silent client-side append). */
  inserter: NoteInserter
  /**
   * True only on the first mount after a NEW Start consultation (router state `autoRecord`): start the microphone recording at once when the
   * recording consent is on record and the local speech service can record; otherwise say plainly why it is not recording. Never the demo.
   * Read once, when the panel first mounts (the workspace may clear its navigation flag afterwards).
   */
  autoRecord: boolean
}

/**
 * "Live transcription" (DESIGN §5.4 column 1): the microphone's live waveform and the recording's state with small Pause / Resume / Stop, the
 * conversation as the local speech model transcribes it (part by part; a speaker only where the doctor said who it was), and below a line the
 * Important points the fixed rules find after each part, for the doctor to confirm or reject. Recording starts by itself only when the workspace
 * asked for it (a new Start consultation) and the patient's recording consent is on record, the local speech service can record and nothing
 * else is recording; otherwise one honest line says why, with the one action that helps. The other ways in (upload audio, type a transcript,
 * earlier recordings, the SIMULATED demo consultation where simulators are allowed) are in the panel's menu.
 *
 * The recording's state is published for the consultation's header (lib/recordingState.ts). Nothing here is ever invented: no speaker
 * identification, no guessed words, no recording state without a running microphone recorder; raw transcript and audio stay out of the audit.
 */
export function LiveTranscription({ encounter, inserter, autoRecord }: LiveTranscriptionProps) {
  const id = encounter.id
  // The request is read once, on the first mount: a reload, a resume or the flag cleared by the workspace never starts a recording.
  const [intent, setIntent] = useState<'pending' | 'done'>(() => (autoRecord ? 'pending' : 'done'))
  const q = useQuery({ queryKey: aiKey(id), queryFn: () => api<EncounterAi>(`/encounters/${id}/ai`) })
  useEffect(() => () => clearRecordingState(id), [id])
  // Only while there is nothing to show yet. A refresh that fails later (a network blip on a focus refetch) keeps the panel, and with it a
  // recording in progress, on the page: the panel says the refresh failed, the microphone carries on.
  const view = panelContent({ hasData: q.data !== undefined, isError: q.isError })
  if (view !== 'body' || q.data === undefined)
    return (
      <Panel label="Live transcription" icon={Mic} testId="live-transcription">
        {view === 'error' ? <Alert tone="error">{errorMessage(q.error)}</Alert> : <LoadingState label="Loading the transcription…" rows={3} />}
      </Panel>
    )
  return <LiveTranscriptionBody encounter={encounter} ai={q.data} aiAt={q.dataUpdatedAt} refreshError={q.isError ? errorMessage(q.error) : null} inserter={inserter} intent={intent} onIntentDone={() => setIntent('done')} />
}

function LiveTranscriptionBody({
  encounter,
  ai,
  aiAt,
  refreshError,
  inserter,
  intent,
  onIntentDone,
}: {
  encounter: Encounter
  ai: EncounterAi
  /** When `ai` was read or last updated (Date.now() ms), to weigh it against the capture status. */
  aiAt: number
  /** Why the last refresh of `ai` failed, while what is shown is from before it. */
  refreshError: string | null
  inserter: NoteInserter
  intent: 'pending' | 'done'
  onIntentDone: () => void
}) {
  const id = encounter.id
  const qc = useQueryClient()
  const toast = useToast()
  const samePerson = useStillSamePerson()
  const highlight = useFocusedLines()
  const open = encounter.status === 'in_progress' && !!encounter.canEdit
  const autoExtract = autoExtractAllowed(ai.status.extraction)
  const extract = useAutoExtract(id, autoExtract && open && ai.consent.granted)

  const onUpdate = useCallback(
    (r: AiResponse) => {
      if (r.consent) qc.setQueryData(aiKey(id), r)
      if (r.notice) toast('error', r.notice)
    },
    [qc, id, toast],
  )
  const rec = useRecorder({ encounterId: id, chunkSeconds: ai.status.liveChunkSeconds, consentGranted: ai.consent.granted, onUpdate, onPart: extract.schedule })

  // The recording open for this consultation, if any: this recorder's, the demo's, or one left open elsewhere (another window, a reload, or
  // one the API named when it refused a start, which the AI state may not know yet).
  const live = ai.transcripts.find((t) => t.status === 'live') ?? null
  const demoLive = !!live && isDemoTranscript(live)
  const [demoPlaying, setDemoPlaying] = useState(false)
  const demo = demoLive || demoPlaying
  const notOpenKey = ai.transcripts
    .filter((t) => t.status !== 'live' || isDemoTranscript(t))
    .map((t) => t.id)
    .join(' ')
  const notOpen = useMemo(() => new Set(notOpenKey.split(' ').filter(Boolean)), [notOpenKey])
  const otherId = otherRecordingId({ recorderIdle: rec.state === 'idle', aiLiveId: live?.id ?? null, aiAt, statusLiveId: rec.status.data?.live.transcriptId, statusAt: rec.status.dataUpdatedAt, notOpen })
  const reason =
    rec.state === 'idle' && !demo
      ? idleReason({ open, micSupported: rec.supported, consentGranted: ai.consent.granted, status: rec.status.data, otherRecordingOpen: !!otherId, problem: rec.problem?.reason ?? null })
      : null

  // What stopped the last attempt is not kept once a status read after it shows it is over (consent recorded here or anywhere else, the speech
  // service back, the other recording ended): the line then says what is true now, never a dead end.
  const { problem, clearProblem } = rec
  const statusData = rec.status.data
  const statusAt = rec.status.dataUpdatedAt
  useEffect(() => {
    if (problem && statusData && statusAt > problem.at && problemResolved(problem.reason, { consentGranted: ai.consent.granted, status: statusData, otherRecordingOpen: !!otherId })) clearProblem()
  }, [problem, statusData, statusAt, ai.consent.granted, otherId, clearProblem])
  // A recording ended elsewhere, or one open elsewhere: read the conversation again (its last lines, its end) rather than show it as it was.
  const problemReason = problem?.reason
  useEffect(() => {
    if (problemReason === 'ended' || problemReason === 'busy') void qc.invalidateQueries({ queryKey: aiKey(id) })
  }, [problemReason, qc, id])

  // Recording auto-start (DESIGN §5.4): once, when the workspace asked for it and nothing stands in the way. Waits only for the patient's consent
  // to be recorded here (then it starts as asked); any other obstacle ends the request, and the line below says why.
  const decision = autoStartDecision({ requested: intent === 'pending', recorderIdle: rec.state === 'idle', statusKnown: !!rec.status.data, reason })
  const started = useRef(false)
  useEffect(() => {
    if (intent !== 'pending') return
    if (demo) {
      onIntentDone()
      return
    }
    if (decision.kind === 'start') {
      if (started.current) return
      started.current = true
      onIntentDone()
      void rec.start()
    } else if (nextAutoIntent(decision) === 'done') onIntentDone()
  })

  // What the consultation's header shows: recording (with the time recorded), paused, or not recording and why. When this body leaves the
  // page its recorder ends, so the header goes back to idle with it: it never outlives the microphone.
  useEffect(() => {
    setRecordingState(id, recordingSnapshot({ recorder: rec.state, elapsedMs: rec.elapsedMs(), reason, now: Date.now() }))
  }, [id, rec.state, reason, rec.elapsedMs])
  useEffect(() => () => clearRecordingState(id), [id])

  // The other ways in, the earlier recordings and the demo.
  const [sheet, setSheet] = useState<null | 'earlier' | 'type'>(null)
  // A point found in an earlier recording points at its own lines there (labels restart at S1 in every recording), never at the current one's.
  const showEarlier = useCallback((keys: string[]) => {
    focusLines(keys)
    setSheet('earlier')
  }, [])
  const [askConsent, setAskConsent] = useState(false)
  const [showDemo, setShowDemo] = useState(false)
  // Each "Play demo consultation" is a new request, passed to the demo until it has taken it (never again after, even if it remounts).
  const [playRequest, setPlayRequest] = useState(0)
  const [playTaken, setPlayTaken] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadAudio = useAiMutation<{ blob: File }>(id, ({ blob }) => {
    const fd = new FormData()
    fd.append('source', 'audio_upload')
    fd.append('file', blob, blob.name)
    return api(`/encounters/${id}/audio`, { method: 'POST', body: fd })
  })
  const endOther = useAiMutation<string>(id, (tid) => api(`/transcripts/${tid}/end`, { method: 'POST', body: { reason: 'doctor_stopped' } }))
  const retry = useAiMutation<string>(id, async (jobId) => {
    const r = await api<{ encounter?: EncounterAi }>(`/ai-jobs/${jobId}/retry`, { method: 'POST' })
    return (r.encounter ?? (await api<EncounterAi>(`/encounters/${id}/ai`))) as AiResponse
  })
  const simulatorAllowed = useSimulatorAllowed()
  const demoOffer = demoGate({ open, simulatorAllowed, consentGranted: ai.consent.granted, canRecord: rec.status.data?.canRecord ?? null, recording: rec.state !== 'idle' || !!otherId })
  const canAddOther = open && ai.consent.granted

  const current = ai.transcripts.at(-1)
  const earlier = ai.transcripts.slice(0, -1)
  const failedJob = ai.jobs.find((j) => j.kind === 'transcription' && j.status === 'failed' && j.retryable)
  const withLines = [...ai.transcripts].reverse().find((t) => t.segments.length > 0)
  const recording = rec.state === 'recording' || rec.state === 'paused' || rec.state === 'finishing'

  const menu: MenuItem[] = [
    { label: 'Upload audio', icon: <FileAudio aria-hidden="true" className="size-4" />, disabled: !canAddOther || uploadAudio.isPending, onSelect: () => fileInput.current?.click() },
    { label: 'Type transcript', icon: <Keyboard aria-hidden="true" className="size-4" />, disabled: !canAddOther, onSelect: () => setSheet('type') },
    { label: earlier.length || ai.audio.length ? 'Earlier recordings' : 'Earlier recordings (none)', name: 'Earlier recordings', icon: <History aria-hidden="true" className="size-4" />, disabled: !earlier.length && !ai.audio.length, onSelect: () => setSheet('earlier') },
    ...(demoOffer.offered
      ? [
          {
            name: 'Play demo consultation (simulated)',
            label: (
              <span className="flex items-center gap-2">
                Play demo consultation <SourceTag kind="simulated" />
              </span>
            ),
            icon: <PlayCircle aria-hidden="true" className="size-4" />,
            disabled: demo,
            onSelect: () => {
              setShowDemo(true)
              setPlayRequest((n) => n + 1)
            },
          },
        ]
      : []),
  ]

  const action = reason ? NOT_RECORDING_ACTION[reason] : undefined
  return (
    <Panel label="Live transcription" icon={Mic} testId="live-transcription" actions={<Menu label="More transcription actions" items={menu} />}>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f && samePerson()) uploadAudio.mutate({ blob: f })
          e.target.value = ''
        }}
      />

      {/* The recording: waveform, state, small controls; or one honest line saying why nothing is being recorded, with the action that helps. */}
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2" data-testid="recorder">
        {recording ? (
          <>
            <LiveWaveform getAnalyser={rec.getAnalyser} recording={rec.state === 'recording'} className="min-w-16 flex-1 basis-24" />
            <p className={`inline-flex items-center gap-2 text-sm font-medium ${rec.state === 'paused' ? 'text-pending' : 'text-down'}`} data-testid="recording-state">
              {rec.state === 'paused' ? <MicOff aria-hidden="true" className="size-4" /> : <span className="size-2.5 rounded-full bg-down motion-safe:animate-pulse" aria-hidden="true" />}
              <span role="status">{rec.state === 'finishing' ? 'Finishing…' : rec.state === 'paused' ? 'Paused' : 'Recording'}</span>
              <RecordingClock elapsedMs={rec.elapsedMs} running={rec.state === 'recording'} />
              {rec.pending > 0 && (
                <span className="inline-flex text-ink-muted" title="Sending the last part to the speech service">
                  <LoaderCircle aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
                  <span className="sr-only">Sending</span>
                </span>
              )}
            </p>
            <div className="flex items-center gap-1">
              {rec.state === 'paused' ? (
                <Button size="sm" variant="ghost" icon={<Play aria-hidden="true" className="size-4" />} onClick={rec.resume}>
                  Resume
                </Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<Pause aria-hidden="true" className="size-4" />} onClick={rec.pause} disabled={rec.state === 'finishing'}>
                  Pause
                </Button>
              )}
              <Button size="sm" variant="secondary" icon={<Square aria-hidden="true" className="size-4" />} onClick={() => void rec.finish()} loading={rec.state === 'finishing'}>
                Stop
              </Button>
            </div>
          </>
        ) : demo ? (
          <p className="inline-flex flex-wrap items-center gap-2 text-sm text-ink-muted" data-testid="not-recording" data-reason="demo">
            Not recording — the demo consultation is playing <DemoAudioMark />
          </p>
        ) : rec.state === 'starting' ? (
          <p role="status" className="text-sm text-ink-muted" data-testid="recording-starting">
            Starting the microphone…
          </p>
        ) : (
          <>
            <p role="status" className="min-w-0 flex-1 text-sm text-ink-muted" data-testid="not-recording" data-reason={reason ?? 'none'}>
              {notRecordingLine(reason)}
            </p>
            {(!reason || action === 'start_new') && open && (
              <Button size="sm" variant="secondary" icon={<Mic aria-hidden="true" className="size-4" />} disabled={!rec.status.data?.canRecord} onClick={() => void rec.start()}>
                Start recording
              </Button>
            )}
            {/* Only while consent is not on record here: once it is (recorded here or elsewhere) there is nothing to record, and the line clears as soon as the status confirms it. */}
            {action === 'record_consent' && open && !askConsent && !ai.consent.granted && (
              <Button size="sm" variant="secondary" onClick={() => setAskConsent(true)}>
                Record consent
              </Button>
            )}
            {action === 'try_again' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  rec.clearProblem()
                  void rec.start()
                }}
              >
                Try again
              </Button>
            )}
            {action === 'end_other' && otherId && (
              <Button
                size="sm"
                variant="secondary"
                loading={endOther.isPending}
                onClick={() =>
                  endOther.mutate(otherId, {
                    onSuccess: () => {
                      // The refusal it caused is over: the line follows the status read now.
                      clearProblem()
                      void rec.status.refetch()
                    },
                  })
                }
              >
                End that recording
              </Button>
            )}
          </>
        )}
      </div>
      {rec.problem && !recording && <p className="mt-1 text-xs text-ink-muted">{rec.problem.text}</p>}
      {refreshError && (
        <p className="mt-1 text-xs text-pending" data-testid="transcription-refresh-error">
          The conversation could not be refreshed just now ({refreshError}). What is shown may be behind{recording ? '; the recording carries on' : ''}.
        </p>
      )}
      {rec.warning && (
        <Alert tone="warning" className="mt-2 text-sm">
          {rec.warning}
        </Alert>
      )}
      {endOther.isError && <p className="mt-1 text-xs text-down">{errorMessage(endOther.error)}</p>}
      {uploadAudio.isPending && <p className="mt-1 text-xs text-ink-muted">Uploading the audio…</p>}
      {uploadAudio.isError && <p className="mt-1 text-xs text-down">{errorMessage(uploadAudio.error)}</p>}
      {open && !ai.consent.granted && askConsent && (
        <div className="mt-2">
          <RecordingConsent
            encounter={encounter}
            ai={ai}
            showGranted={false}
            onRecorded={() => {
              setAskConsent(false)
              rec.clearProblem()
            }}
          />
        </div>
      )}
      {open && (showDemo || demoLive) && (
        <div className="mt-3">
          <DemoConsultation encounter={encounter} ai={ai} onUpdate={onUpdate} onActiveChange={setDemoPlaying} onPart={extract.schedule} playRequest={playRequest !== playTaken ? playRequest : 0} onPlayRequestHandled={() => setPlayTaken(playRequest)} onDismiss={() => setShowDemo(false)} />
        </div>
      )}

      {/* The conversation, as it is transcribed. */}
      <div className="mt-3">
        {current ? (
          <CurrentConversation t={current} encounterId={id} open={open} highlight={highlight} onRetry={failedJob ? () => retry.mutate(failedJob.id) : undefined} retrying={retry.isPending} />
        ) : (
          <HeroEmpty testId="conversation-empty">{open ? 'The conversation appears here as it is transcribed.' : 'Nothing was recorded in this consultation.'}</HeroEmpty>
        )}
      </div>

      <ImportantPoints
        encounter={encounter}
        ai={ai}
        inserter={inserter}
        currentTranscriptId={current?.id ?? null}
        onFocus={focusLines}
        onShowEarlier={showEarlier}
        extraction={{
          running: extract.running,
          error: extract.error,
          auto: autoExtract,
          canRun: open && ai.consent.granted && ai.status.extraction.available && !!withLines && !extract.running && (!autoExtract || withLines.status !== 'live'),
          run: () => withLines && extract.runNow(withLines.id),
        }}
      />

      <Sheet open={sheet === 'earlier'} onClose={() => setSheet(null)} title="Earlier recordings" subtitle="Earlier transcripts of this consultation, and its saved recordings" testId="earlier-recordings">
        <EarlierRecordings ai={ai} transcripts={earlier} encounterId={id} open={open} highlight={highlight} />
      </Sheet>
      <TypeTranscriptSheet open={sheet === 'type'} encounterId={id} onClose={() => setSheet(null)} />
    </Panel>
  )
}

/** Where a transcript came from, said once above it when it is not this consultation's microphone: the demo's mark, an upload, typed text. */
function TranscriptCaption({ t }: { t: Transcript }) {
  const demo = isDemoTranscript(t)
  const ended = t.endReason === 'consent_withdrawn' ? TRANSCRIPT_END_REASONS.consent_withdrawn : null
  if (!demo && !ended && (t.source === 'browser_recording' || t.audioOrigin === 'microphone')) return null
  return (
    <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted" data-testid="transcript-caption">
      {demo ? <DemoAudioMark /> : !ended && <span>{transcriptSourceLabel(t)}</span>}
      {demo && <span data-testid="demo-transcript-note">Computer voices reading a written script, transcribed by the speech model on this computer. Not a real consultation; no patient spoke.</span>}
      {ended && <span>{ended}</span>}
      <span>· {fmtTime(t.createdAt)}</span>
    </p>
  )
}

const CurrentConversation = memo(function CurrentConversation({ t, encounterId, open, highlight, onRetry, retrying }: { t: Transcript; encounterId: string; open: boolean; highlight: ReadonlySet<string>; onRetry?: (() => void) | undefined; retrying: boolean }) {
  const assign = useAssignSpeakers(encounterId, t.id)
  const shown = useWordReveal(t)
  return (
    <div data-testid="transcript-section" data-transcript-id={t.id} data-audio-origin={t.audioOrigin ?? undefined}>
      <TranscriptCaption t={t} />
      {assign.isError && <p className="mb-1 text-xs text-down">{errorMessage(assign.error)}</p>}
      {t.segments.length === 0 && t.chunks.length === 0 ? (
        <HeroEmpty>{t.status === 'live' ? 'Listening. The first lines appear when the first part has been transcribed.' : 'Nothing was heard in this recording.'}</HeroEmpty>
      ) : (
        <ConversationView transcript={shown} highlight={highlight} canAssign={open} assigning={assign.isPending} onAssign={(segmentId, speaker) => assign.mutate({ assignments: [{ segmentId, speaker }] })} onRetry={onRetry} retrying={retrying} follow={t.status === 'live'} />
      )}
    </div>
  )
})

function EarlierTranscript({ t, encounterId, open, highlight }: { t: Transcript; encounterId: string; open: boolean; highlight: ReadonlySet<string> }) {
  const assign = useAssignSpeakers(encounterId, t.id)
  // A point found in this recording points at its lines (named with this recording, never a bare label): opened, and brought into view.
  const pointedAt = focusedLineIds(highlight, t.id, { bare: false }).join(' ')
  const [expanded, setExpanded] = useState(pointedAt !== '')
  const box = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!pointedAt) return
    setExpanded(true)
    // After the frame is laid out: the sheet that has just opened is not yet shown while its content's effects run.
    const frame = requestAnimationFrame(() => box.current?.scrollIntoView?.({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [pointedAt])
  return (
    <details ref={box} open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)} className="group border-t border-line py-2 first:border-t-0" data-testid="earlier-transcript" data-transcript-id={t.id}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {isDemoTranscript(t) ? <DemoAudioMark /> : <span className="font-medium">{transcriptSourceLabel(t)}</span>}
        <span className="text-xs text-ink-muted">
          {fmtTime(t.createdAt)} · {t.segments.length} line{t.segments.length === 1 ? '' : 's'}
          {t.endReason === 'consent_withdrawn' ? ` · ${TRANSCRIPT_END_REASONS.consent_withdrawn}` : ''}
        </span>
      </summary>
      <div className="mt-2">
        {assign.isError && <p className="mb-1 text-xs text-down">{errorMessage(assign.error)}</p>}
        <ConversationView transcript={t} highlight={highlight} canAssign={open} assigning={assign.isPending} onAssign={(segmentId, speaker) => assign.mutate({ assignments: [{ segmentId, speaker }] })} follow={false} />
      </div>
    </details>
  )
}

function EarlierRecordings({ ai, transcripts, encounterId, open, highlight }: { ai: EncounterAi; transcripts: Transcript[]; encounterId: string; open: boolean; highlight: ReadonlySet<string> }) {
  if (!transcripts.length && !ai.audio.length) return <HeroEmpty>This consultation has no earlier recording.</HeroEmpty>
  return (
    <div className="space-y-4">
      {transcripts.length > 0 && (
        <section aria-label="Earlier transcripts">
          {[...transcripts].reverse().map((t) => (
            <EarlierTranscript key={t.id} t={t} encounterId={encounterId} open={open} highlight={highlight} />
          ))}
        </section>
      )}
      {ai.audio.length > 0 && (
        <section aria-labelledby="saved-recordings">
          <h3 id="saved-recordings" className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <ListChecks aria-hidden="true" className="size-4 text-ink-muted" />
            Saved recordings
          </h3>
          <ul className="space-y-3 text-xs text-ink-muted" aria-label="Saved recordings">
            {ai.audio.map((a) => (
              <li key={a.fileId}>
                <audio controls preload="none" src={`/api/files/${a.fileId}`} className="w-full" aria-label={`Recording from ${fmtTime(a.createdAt)}`} />
                {fmtTime(a.createdAt)} · {(a.sizeBytes / 1024).toFixed(0)} KB · {a.transcriptId ? 'transcribed' : 'not transcribed yet'}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function TypeTranscriptSheet({ open, encounterId, onClose }: { open: boolean; encounterId: string; onClose: () => void }) {
  const [text, setText] = useState('')
  const save = useAiMutation<{ text: string }>(encounterId, (body) => api(`/encounters/${encounterId}/transcripts`, { method: 'POST', body: { ...body, source: 'typed' } }))
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Type a transcript"
      subtitle="Typed text is not recorded speech: it has no times or language."
      dismissible={!save.isPending}
      testId="type-transcript"
      footer={
        <Button
          disabled={!text.trim()}
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { text },
              {
                onSuccess: () => {
                  setText('')
                  onClose()
                },
              },
            )
          }
        >
          Save typed transcript
        </Button>
      }
    >
      <TextAreaField label="Type or paste a transcript" hint="One line per thing said. Start a line with “Doctor:” or “Patient:” to say who spoke." rows={10} value={text} onChange={(e) => setText(e.target.value)} />
      {save.isError && (
        <Alert tone="error" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
    </Sheet>
  )
}
