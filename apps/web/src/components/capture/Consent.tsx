import type { Encounter, EncounterAi } from '@adaxai/contracts'
import { ShieldCheck } from 'lucide-react'
import { useAiMutation } from '../../lib/ai.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { useToast } from '../ui/Toast.tsx'

/**
 * The patient's consent to recording: when it is on record, one quiet line saying so (`showGranted`); when it is not, what to ask the patient
 * (where the audio goes, what is stored, that declining does not affect their care) and the doctor's explicit act, "Patient agrees (verbal)",
 * which records it for this consultation. Nothing is recorded without it, and nothing here starts a recording by itself.
 */
export function RecordingConsent({ encounter, ai, showGranted = true, onRecorded }: { encounter: Pick<Encounter, 'id'>; ai: EncounterAi; showGranted?: boolean; onRecorded?: () => void }) {
  const toast = useToast()
  const consent = useAiMutation<{ method: 'verbal' | 'written' }>(encounter.id, (body) => api(`/encounters/${encounter.id}/ai-consent`, { method: 'POST', body }))
  if (ai.consent.granted) {
    if (!showGranted) return null
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
    <div className="rounded-lg bg-canvas p-3 text-sm" data-testid="recording-consent">
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
        <Button
          size="sm"
          loading={consent.isPending}
          onClick={() =>
            consent.mutate(
              { method: 'verbal' },
              {
                onSuccess: () => {
                  toast('success', 'Consent recorded for this consultation')
                  onRecorded?.()
                },
              },
            )
          }
        >
          Patient agrees (verbal)
        </Button>
      </div>
    </div>
  )
}
