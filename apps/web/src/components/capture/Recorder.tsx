import { Mic, MicOff, Pause, Play, Square } from 'lucide-react'
import type { AiResponse } from '../../lib/ai.ts'
import { clinicianReason } from '../../lib/capture.ts'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { LevelBar, RecordingClock } from './LiveWaveform.tsx'
import { CONSENT_WITHDRAWN, useRecorder } from './useRecorder.ts'

export { CONSENT_WITHDRAWN }

/**
 * Live recording in the browser, to the local speech service, as the capture panel shows it (the consultation workspace's live transcription
 * uses the same pipeline, useRecorder, with its own controls). Nothing starts by itself here: recording needs a click, the patient's recorded
 * consent and a ready local speech service, and the browser's own permission. The level bar is the microphone's real signal; there are no
 * guessed words, only finished text per part.
 */
export function Recorder({
  encounterId,
  chunkSeconds,
  consentGranted,
  consentWithdrawn,
  onUpdate,
  onPart,
  onStopped,
}: {
  encounterId: string
  chunkSeconds: number
  /** The patient's recording consent as the screen last knew it: without it nothing is offered, and a recording in progress stops. */
  consentGranted: boolean
  /** The latest recording of this consultation was ended because consent was withdrawn (still true after a reload). */
  consentWithdrawn: boolean
  onUpdate: (r: AiResponse) => void
  /** A part was stored and transcribed. */
  onPart?: (transcriptId: string) => void
  /** Called when the doctor stops, after the last part was sent and the recording closed. */
  onStopped: (transcriptId: string) => void
}) {
  const rec = useRecorder({ encounterId, chunkSeconds, consentGranted, onUpdate, onPart, onStopped })
  const { state, problem, warning, status } = rec

  // No consent: nothing is offered. What stopped a recording stays on screen (the consent block above says what is needed).
  const shownProblem = problem?.text ?? (state === 'idle' && !consentGranted && consentWithdrawn ? CONSENT_WITHDRAWN : null)
  if (!consentGranted && state === 'idle') return shownProblem ? <Alert tone="error">{shownProblem}</Alert> : null
  if (!rec.supported) {
    return <Alert tone="info">This browser cannot record from a microphone. Use a current Chrome, Edge, Firefox or Safari, or add the transcript another way (below).</Alert>
  }

  const s = status.data
  const canStart = !!s?.canRecord && state === 'idle'
  const recording = state === 'recording' || state === 'paused' || state === 'finishing'
  return (
    <div className="space-y-2" data-testid="recorder">
      <div className="flex flex-wrap items-center gap-2">
        {state === 'idle' || state === 'starting' ? (
          <Button size="sm" icon={<Mic aria-hidden="true" className="size-4" />} onClick={() => void rec.start()} disabled={!canStart} loading={state === 'starting'} aria-describedby={!canStart && s?.blockedReason ? 'recorder-blocked' : undefined}>
            Start recording
          </Button>
        ) : (
          <>
            {state === 'paused' ? (
              <Button size="sm" variant="secondary" icon={<Play aria-hidden="true" className="size-4" />} onClick={rec.resume}>
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="secondary" icon={<Pause aria-hidden="true" className="size-4" />} onClick={rec.pause} disabled={state === 'finishing'}>
                Pause
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<Square aria-hidden="true" className="size-4" />} onClick={() => void rec.finish()} loading={state === 'finishing'}>
              Stop
            </Button>
          </>
        )}
        {recording && (
          <p className={`inline-flex items-center gap-2 text-sm font-medium ${state === 'paused' ? 'text-pending' : 'text-down'}`} data-testid="recording-state">
            {state === 'paused' ? <MicOff aria-hidden="true" className="size-4" /> : <span className="size-2.5 animate-pulse rounded-full bg-down motion-reduce:animate-none" aria-hidden="true" />}
            <span role="status">{state === 'finishing' ? 'Finishing…' : state === 'paused' ? 'Paused' : 'Recording'}</span>
            <RecordingClock elapsedMs={rec.elapsedMs} running={state === 'recording'} />
          </p>
        )}
      </div>
      {recording && (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <LevelBar getAnalyser={rec.getAnalyser} active={state === 'recording'} />
          <span>
            Microphone level · {rec.sent} part{rec.sent === 1 ? '' : 's'} sent{rec.pending > 0 ? ` · ${rec.pending} sending` : ''}
          </span>
        </div>
      )}
      {!canStart && state === 'idle' && s?.blockedReason && (
        <p id="recorder-blocked" className="text-sm text-ink-muted">
          {clinicianReason(s.blockedReason, 'Recording cannot start now.')}
        </p>
      )}
      {shownProblem && <Alert tone="error">{shownProblem}</Alert>}
      {warning && <Alert tone="warning">{warning}</Alert>}
      <p className="text-xs text-ink-muted">Sent in {chunkSeconds}-second parts to the speech service on this machine; each part appears when its transcription is finished. The audio is stored with the consultation.</p>
    </div>
  )
}
