import type { CaptureStatus, Encounter, EncounterAi } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Mic, Play } from 'lucide-react'
import { aiKey } from '../../../lib/ai.ts'
import { api } from '../../../lib/api.ts'
import { captureKey } from '../../../lib/capture.ts'
import { DEMO_AUDIO_LABEL, demoConversationState, demoSummaryLines } from '../../../lib/demoConsultation.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { DEMO_PLAY_TESTID, DemoAudioMark } from '../../capture/DemoConsultation.tsx'
import { CLOSED_ONLY, OPEN_ONLY, QuickAction, runModuleAction } from '../ModuleShell.tsx'
import { conversationAiCore, conversationCaptureCore, conversationState, conversationView, isDemoAudio, NOT_UPDATED, safely, type SummaryState } from './state.ts'

export { DemoAudioMark }
export { useDemoConsultationOffered } from '../../capture/DemoConsultation.tsx'

/*
 * Module 1, the conversation: what the transcription panel (CapturePanel and its recorder) already read, observed. Both queries are the
 * panel's own, with the same key and the same function, never enabled here: nothing is asked of the server from this file, and the recorder's
 * status is kept no longer than the panel keeps it (gcTime 0).
 */

const aiQuery = (encounterId: string) => ({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`), enabled: false }) as const
const captureQuery = (encounterId: string) => ({ queryKey: captureKey(encounterId), queryFn: () => api<CaptureStatus>(`/encounters/${encounterId}/capture`), enabled: false, gcTime: 0 }) as const

/**
 * For the page: the conversation module's chip and what the workflow strip counts (transcripts and important points; null until read), and the
 * points the doctor confirmed (what an analysis reads of it). It re-renders only when these change, not on every poll of the recorder's status.
 */
/** Whether the recording now live is the demo consultation's (its audio synthetic): read alone, so that the chip changes only when it does. */
const liveDemoOf = (ai: EncounterAi | undefined): boolean => Array.isArray(ai?.transcripts) && ai.transcripts.some((t) => t?.status === 'live' && isDemoAudio(t))

export function useConversationModule(encounter: Pick<Encounter, 'id'>): { state: SummaryState; facts: InputModuleFacts['conversation']; confirmedPoints: number | null } {
  const ai = useQuery({ ...aiQuery(encounter.id), select: conversationAiCore })
  const liveDemo = useQuery({ ...aiQuery(encounter.id), select: liveDemoOf })
  const capture = useQuery({ ...captureQuery(encounter.id), select: conversationCaptureCore })
  const a = ai.data
  // Synthetic demo audio playing is never "Recording" (the microphone's word, in red).
  const state: SummaryState = demoConversationState(conversationState(a, capture.data, { ai: ai.isError, capture: capture.isError }), liveDemo.data === true)
  return { state, facts: a ? { transcripts: a.transcripts, points: a.points } : null, confirmedPoints: a ? a.confirmed : null }
}

function useConversationView(encounterId: string) {
  const ai = useQuery(aiQuery(encounterId))
  const capture = useQuery(captureQuery(encounterId))
  const failed = { ai: ai.isError, capture: capture.isError }
  return safely(() => conversationView({ ai: ai.data, capture: capture.data, failed, readAt: Math.max(ai.dataUpdatedAt, capture.dataUpdatedAt) || null }), {
    state: NOT_UPDATED,
    facts: null,
    confirmedPoints: null,
    lines: ['The conversation could not be read just now.'],
    compact: ['The conversation could not be read just now.'],
    meta: null,
    empty: false,
    demo: false,
  })
}

/** Record, by default: the module opens and its recorder's own "Start recording" is used (when it can start; else the panel says why). */
export const recordConversation = () => void runModuleAction('tools-conversation', { text: 'Start recording' })

/**
 * Play demo consultation, for `onPlayDemo`: the module opens and the transcription panel's own "Play demo consultation" is used (when it can
 * start; else the panel says why). The page passes it only where useDemoConsultationOffered says the demo is offered.
 */
export const playDemoConsultation = () => void runModuleAction('tools-conversation', { testId: DEMO_PLAY_TESTID })

/**
 * The summary of module 1. Closed, one or two short lines: with nothing recorded, "Not recorded yet" and Record (`onRecord`; by default the
 * recorder's own Start recording), and "Play demo consultation" where the page allows it (`onPlayDemo`: only where simulators are allowed and the
 * recording consent is present; the page decides, never this file: useDemoConsultationOffered, playDemoConsultation), marked SYNTHETIC AUDIO;
 * while recording, that it is (the Stop button is in the full panel) and since when, and while the demo plays, that synthetic demo audio is
 * playing (never "Recording", never in red); with a transcript, how much there is and the important points (found by fixed rules) waiting for
 * review or confirmed, and "Synthetic demo audio" when that is what was transcribed. Open, the same with the fuller wording.
 */
export function ConversationSummary({ encounter, onRecord = recordConversation, onPlayDemo }: { encounter: Pick<Encounter, 'id'>; onRecord?: () => void; onPlayDemo?: (() => void) | undefined }) {
  const v = useConversationView(encounter.id)
  // While recording, the newest transcript is the live one: `demo` says whether its audio is the demo's.
  const liveDemo = v.state.kind === 'recording' && v.demo
  const state = demoConversationState(v.state, liveDemo)
  const recording = state.kind === 'recording'
  const [first, second] = demoSummaryLines(v.compact, liveDemo)
  const lines = demoSummaryLines(v.lines, liveDemo)
  return (
    <div data-testid="summary-conversation" data-state={state.kind} data-demo={v.demo || undefined}>
      <div className={CLOSED_ONLY}>
        {v.empty ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
            <p className="text-ink-muted">{first}</p>
            <QuickAction icon={Mic} onClick={onRecord} testId="module-conversation-record">
              Record
            </QuickAction>
            {onPlayDemo && (
              <span className="inline-flex items-center gap-1.5">
                <QuickAction icon={Play} onClick={onPlayDemo} testId="module-conversation-demo" title={DEMO_AUDIO_LABEL}>
                  Play demo consultation<span className="sr-only"> (synthetic audio: computer voices, not a real consultation)</span>
                </QuickAction>
                <span aria-hidden="true" className="rounded-md border border-dashed border-ink/60 px-1 text-[0.625rem] leading-4 font-semibold tracking-wide text-ink">
                  SYNTHETIC
                </span>
              </span>
            )}
          </div>
        ) : (
          <p className={`flex flex-wrap items-center gap-x-1.5 ${recording ? 'font-medium text-down' : ''}`}>
            <span>{first}</span>
            {v.demo && <DemoAudioMark />}
          </p>
        )}
        {second && <p className="text-xs text-ink-muted">{second}</p>}
      </div>
      <div className={`space-y-0.5 ${OPEN_ONLY}`}>
        {lines.map((line, i) => (
          <p key={i} className={i ? 'text-ink-muted' : recording ? 'font-medium text-down' : ''}>
            {line}
          </p>
        ))}
        {v.demo && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            <DemoAudioMark /> Computer voices played through the speakers and transcribed by the local speech model: not a real consultation.
          </p>
        )}
      </div>
    </div>
  )
}

/** Where the conversation came from and when: the newest transcript's source and time, or the speech service and when it was checked. */
export function ConversationMeta({ encounter }: { encounter: Pick<Encounter, 'id'> }) {
  const v = useConversationView(encounter.id)
  return v.meta ? <span data-testid="summary-conversation-meta">{v.meta}</span> : null
}
