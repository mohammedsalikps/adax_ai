import type { Encounter } from '@adaxai/contracts'
import { Thermometer } from 'lucide-react'
import { memo, useState } from 'react'
import { usePatient } from '../../lib/clinical.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { usePatientThermal } from '../../lib/thermal.ts'
import { Panel } from '../hero/Panel.tsx'
import { ResearchModeSheet } from '../thermal/ResearchMode.tsx'
import { ThermalWorkspace } from '../thermal/ThermalWorkspace.tsx'
import { Button } from '../ui/Button.tsx'
import { ThermalSummary } from './summaries/ThermalSummary.tsx'

/**
 * "Thermal" in the workspace's lower band (DESIGN §5.4, cols 9–12): the compact thermal context of this consultation, the newest image as a
 * small picture with its colour scale, range and approval (the module summary's own view, ThermalSummary), with Capture (no image yet) or
 * Open (the newest image) and [Open] for the thermal imaging workspace, which opens in place (ThermalWorkspace: camera, import, the clinical
 * study, Add to Examination through the note's inserter). The research view stays one quick action away.
 *
 * This panel owns the reads the summary only observes: the patient's thermal list and the patient's record (the thermal consent), as the
 * old thermal panel did. Nothing here measures or concludes anything by itself.
 */
export const ThermalContext = memo(function ThermalContext({ encounter, inserter }: { encounter: Encounter; inserter: NoteInserter }) {
  const studies = usePatientThermal(encounter.patient.id)
  usePatient(encounter.patient.id)
  const [open, setOpen] = useState<{ captureId: string | null } | null>(null)
  const [research, setResearch] = useState(false)
  const canEdit = encounter.canEdit
  // The newest image of this consultation, which "Open thermal" opens.
  const newest =
    (studies.data ?? []).filter((c) => c.encounterId === encounter.id).sort((a, b) => Date.parse(b.capturedAt ?? b.createdAt) - Date.parse(a.capturedAt ?? a.createdAt))[0]?.id ?? null
  return (
    <Panel
      label="Thermal"
      icon={Thermometer}
      testId="thermal-context"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setOpen({ captureId: null })} disabled={!canEdit} data-testid="thermal-open">
          Open<span className="sr-only"> thermal imaging</span>
        </Button>
      }
    >
      <ThermalSummary encounter={encounter} onCaptureThermal={() => setOpen({ captureId: null })} onOpenThermal={() => setOpen({ captureId: newest })} onResearch={() => setResearch(true)} />
      <p className="mt-2 text-xs text-ink-muted">Skin-surface temperature measurements only, not a diagnosis.</p>
      {open && <ThermalWorkspace encounter={encounter} inserter={inserter} canEdit={canEdit} initialCaptureId={open.captureId} onClose={() => setOpen(null)} />}
      <ResearchModeSheet encounter={encounter} open={research} onClose={() => setResearch(false)} />
    </Panel>
  )
})
