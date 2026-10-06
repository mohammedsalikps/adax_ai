import type { Encounter, ThermalCapture } from '@adaxai/contracts'
import { FlaskConical, Thermometer, X } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../../lib/api.ts'
import { usePatient } from '../../lib/clinical.ts'
import { useEncounter } from '../../lib/encounters.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { usePatientThermal, useThermal } from '../../lib/thermal.ts'
import { CONTAIN_DIALOG_EVENTS } from '../../lib/thermalStudy.ts'
import { Panel } from '../hero/Panel.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, ErrorState, Spinner } from '../ui/Feedback.tsx'
import { Card } from '../ui/Layout.tsx'
import { PanelBoundary } from '../ui/PanelBoundary.tsx'
import { ResearchModeSheet } from './ResearchMode.tsx'
import { ThermalSummaryCard } from './ThermalSummaryCard.tsx'
import { ThermalViewer } from './ThermalViewer.tsx'

/** Props of a thermal study (DESIGN §5.7, §7). */
export interface ThermalStudyProps {
  captureId: string
  /** The consultation it was opened from, when any (its measurements and summary then belong to that encounter's review). */
  encounter?: Encounter | undefined
  /** Back to where it was opened from (the Thermal page list, the consultation's thermal context). */
  onClose?: (() => void) | undefined
  // --- Additive, for the consultation's thermal workspace (the Thermal page passes none of them) ---
  /** The consultation note's inserter: an accepted, non-simulated summary of an approved image can then be added to the Examination. */
  inserter?: NoteInserter | undefined
  /** Whether the doctor may edit that consultation now (defaults to the encounter's own `canEdit`). */
  canEdit?: boolean | undefined
  /** Hears whether regions are drawn but not saved, so the screen around can ask before it discards them. */
  onDirtyChange?: ((dirty: boolean) => void) | undefined
  /** The heading level of the study's panel: 2 on a page, 3 inside an area that has its own h2 (the thermal workspace). */
  level?: 2 | 3
}

/**
 * The research view of the consultation this image was taken in ("Pediatric shock research", read only, research only), offered inside the
 * study's Details. It reads the images of one consultation, so an image uploaded for the patient only has none. The consultation, the patient's
 * images and record are read only once the doctor opens it (the research view itself only observes those queries).
 */
function ResearchEntry({ capture, encounter }: { capture: ThermalCapture; encounter?: Encounter | undefined }) {
  const [open, setOpen] = useState(false)
  const own = encounter && capture.encounterId === encounter.id ? encounter : undefined
  const loaded = useEncounter(open && !own && capture.encounterId ? capture.encounterId : undefined)
  usePatientThermal(capture.patientId, open)
  usePatient(open ? capture.patientId : undefined)
  const enc = own ?? loaded.data
  return (
    <Card title="Research">
      {capture.encounterId ? (
        <div className="space-y-2 text-sm">
          <p className="text-ink-muted">A read-only research view of the thermal images of the consultation this image was taken in. Research only: it never gives a clinical result.</p>
          <Button size="sm" variant="secondary" icon={<FlaskConical aria-hidden="true" className="size-4" />} onClick={() => setOpen(true)} data-testid="thermal-study-research-open">
            Pediatric shock research
          </Button>
          {open && !enc && loaded.isPending && <Spinner label="Opening the research view…" />}
          {open && !enc && loaded.isError && <Alert tone="error">{errorMessage(loaded.error)}</Alert>}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">This image was uploaded for the patient, not in a consultation: the research view reads the images of one consultation.</p>
      )}
      {enc && <ResearchModeSheet encounter={enc} open={open} onClose={() => setOpen(false)} />}
    </Card>
  )
}

/**
 * One thermal image as the doctor's clinical study (DESIGN §5.7): the large image with its colour scale and the temperature under the pointer,
 * ROI tools (rectangle, ellipse, polygon) with min / max / mean / SD per region and for the whole image, the doctor's review, and the summary
 * card (Approve measurements → Compose summary → Accept / Edit / Reject, the existing review rules: a summary is composed only from an approved
 * image and decided once). Engineering detail (emissivity, extractor, SHA-256, raw geometry, data origin, clinician labels, experimental flags,
 * the model status (MODEL UNAVAILABLE) and the research view) sits behind one "Details" disclosure. "Measurements only, not a diagnosis."
 *
 * Used by the Thermal page (in place, after an upload or a capture), the doctor's thermal links, the consultation's profile drawer and the
 * consultation's thermal workspace: one view of one record. Contract (DESIGN §7): `ThermalStudy({captureId, encounter?, onClose?})`.
 */
export function ThermalStudy({ captureId, encounter, onClose, inserter, canEdit, onDirtyChange, level = 2 }: ThermalStudyProps) {
  const q = useThermal(captureId)
  const c = q.data
  return (
    <Panel
      label="Thermal study"
      icon={Thermometer}
      as={level === 3 ? 'h3' : 'h2'}
      testId="thermal-study"
      actions={
        onClose && (
          <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {q.isPending && (
        <p role="status" className="text-sm text-ink-muted">
          Processing: measuring the temperatures…
        </p>
      )}
      {q.isError && <ErrorState title="The thermal image could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {c && (
        <PanelBoundary label="The thermal study">
          {/* The study's own dialogs (the research view, withdrawing a label) close themselves only, wherever the study is shown. */}
          <div className="contents" {...CONTAIN_DIALOG_EVENTS}>
            <ThermalViewer
              key={c.id}
              capture={c}
              variant="clinical"
              allowPolygon
              onDirtyChange={onDirtyChange}
              summary={
                <PanelBoundary label="The thermal summary" neutral>
                  <ThermalSummaryCard captureId={c.id} captureStatus={c.status} encounter={encounter} inserter={inserter} canEdit={canEdit} variant="clinical" />
                </PanelBoundary>
              }
              details={<ResearchEntry capture={c} encounter={encounter} />}
            />
          </div>
        </PanelBoundary>
      )}
    </Panel>
  )
}
