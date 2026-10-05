import type { CaptureStatus, ConsultationAi, EncounterAi, ReasoningStatus, SpeechStatus } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { aiKey } from '../../lib/ai.ts'
import { api } from '../../lib/api.ts'
import { captureKey } from '../../lib/capture.ts'
import { consultKey } from '../../lib/consult.ts'
import { fmtClock } from '../../lib/devices.ts'
import { type BadgeTone, Badge } from '../ui/Feedback.tsx'
import { PanelBoundary } from '../ui/PanelBoundary.tsx'
import { DeviceStatusChip } from './DeviceReadingsCard.tsx'

/** Where a chip leads: the part of the tools column that says more. */
export type ToolSection = 'conversation' | 'draft' | 'devices'

/**
 * The state of what the consultation relies on, in words, under the patient's banner: the devices attached to the patient, the AI draft's
 * model and the local speech-to-text service. Each chip reads what the panel that owns it already fetched (an observer of the same query,
 * never fetching itself: no request and no audit entry of its own) and leads to that panel. A chip whose panel has not answered yet is not
 * shown, and one whose panel's last read failed says "not updated": the chips never guess, and an old state is never shown as current
 * without saying so. The time of the last check and the model's name are in each chip's accessible name and tooltip.
 */
export function ConsultationStatus({ encounterId, patientId, onSelect }: { encounterId: string; patientId: string; onSelect: (s: ToolSection) => void }) {
  return (
    <PanelBoundary label="The status of the devices and the AI" className="min-w-0">
      <div role="group" aria-label="What this consultation relies on" className="flex flex-wrap items-center gap-1.5" data-testid="consultation-status">
        <DeviceStatusChip patientId={patientId} onSelect={() => onSelect('devices')} />
        <ModelChip encounterId={encounterId} onSelect={() => onSelect('draft')} />
        <SpeechChip encounterId={encounterId} onSelect={() => onSelect('conversation')} />
      </div>
    </PanelBoundary>
  )
}

function Chip({ tone, label, detail, testId, onSelect }: { tone: BadgeTone; label: string; detail: string; testId: string; onSelect: () => void }) {
  return (
    <button type="button" onClick={onSelect} className="inline-flex min-h-control-sm items-center rounded-full" aria-label={`${label}. ${detail}`} title={detail} data-testid={testId}>
      <Badge tone={tone} dot>
        {label}
      </Badge>
    </button>
  )
}

const checked = (at: number) => `As last checked at ${fmtClock(new Date(at).toISOString())}.`

/** The words and colour of a provider's state; "not updated" (neutral) when the panel's last read failed and what it showed before is old. */
function chipState(s: ReasoningStatus | SpeechStatus, failed: boolean, words: { ready: string; unavailable: string; notConfigured: string }): { label: string; tone: BadgeTone } {
  const [label, tone]: [string, BadgeTone] = s.available ? [words.ready, 'ok'] : s.state === 'not_configured' ? [words.notConfigured, 'neutral'] : [words.unavailable, s.state === 'loading' ? 'warn' : 'down']
  return failed ? { label: `${label} · not updated`, tone: 'neutral' } : { label, tone }
}

/**
 * The model the AI draft uses, as the AI draft panel last heard it (that panel asks the model server itself). "Local" only when the model runs
 * on this computer; a hosted model is "allowed" (the server's setting), not "ready": nothing here has checked the hosted service.
 */
function ModelChip({ encounterId, onSelect }: { encounterId: string; onSelect: () => void }) {
  const q = useQuery({ queryKey: consultKey(encounterId), queryFn: () => api<ConsultationAi>(`/encounters/${encounterId}/consultation-ai`, { query: { fresh: 1 } }), enabled: false })
  const s = q.data?.status
  if (!s) return null
  const who = s.local ? 'Local AI' : s.mode === 'hosted' ? 'Hosted AI' : 'AI on another computer'
  const { label, tone } = chipState(s, q.isError, { ready: s.mode === 'hosted' ? `${who} allowed` : `${who} ready`, unavailable: `${who} unavailable`, notConfigured: 'AI drafting not set up' })
  return <Chip tone={tone} label={label} detail={`${s.model ? `Model ${s.model}. ` : ''}${checked(q.dataUpdatedAt)} Show the AI draft.`} testId="model-status-chip" onSelect={onSelect} />
}

/**
 * The speech-to-text service, from whichever of the transcription panel's two reads is newer: its status, re-read every 20 seconds (every 4
 * while recording), or the consultation's AI state (read when the panel opens and after each change). The status is not kept once the page
 * is gone (gcTime 0, as its owner sets it).
 */
function SpeechChip({ encounterId, onSelect }: { encounterId: string; onSelect: () => void }) {
  const capture = useQuery({ queryKey: captureKey(encounterId), queryFn: () => api<CaptureStatus>(`/encounters/${encounterId}/capture`), enabled: false, gcTime: 0 })
  const ai = useQuery({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`), enabled: false })
  const fromCapture = !!capture.data && capture.dataUpdatedAt >= ai.dataUpdatedAt
  const s = fromCapture ? capture.data?.speech : ai.data?.status.stt
  if (!s) return null
  const { label, tone } = chipState(s, fromCapture ? capture.isError : ai.isError, { ready: 'Speech-to-text ready', unavailable: 'Speech-to-text unavailable', notConfigured: 'Speech-to-text not set up' })
  return <Chip tone={tone} label={label} detail={`${s.model ? `Model ${s.model}. ` : ''}${checked(fromCapture ? capture.dataUpdatedAt : ai.dataUpdatedAt)} Show the transcription.`} testId="speech-status-chip" onSelect={onSelect} />
}
