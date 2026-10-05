import { BODY_SITES, type Encounter } from '@adaxai/contracts'
import { Thermometer } from 'lucide-react'
import { useMemo, useState } from 'react'
import { usePatient } from '../../lib/clinical.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { fmtC, usePatientThermal } from '../../lib/thermal.ts'
import { findNativeBridge } from '../../lib/thermalCamera.ts'
import { fmtTime } from '../../lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { Card } from '../ui/Layout.tsx'
import { ThermalSourceBadge } from './ThermalSourceBadge.tsx'
import { ThermalWorkspace } from './ThermalWorkspace.tsx'

/**
 * Thermal imaging in the consultation's tools column (V6): whether a camera can be reached from this device, the thermal images of THIS
 * consultation (each with where it came from), and the way into the thermal imaging workspace for this patient and this encounter. Images of
 * the patient's other visits stay in the profile's Documents. Nothing here measures or concludes anything by itself.
 */
export function ThermalPanel({ encounter, inserter, canEdit }: { encounter: Encounter; inserter: NoteInserter; canEdit: boolean }) {
  const p = encounter.patient
  const patient = usePatient(p.id)
  const studies = usePatientThermal(p.id)
  const mine = (studies.data ?? []).filter((c) => c.encounterId === encounter.id)
  const [open, setOpen] = useState<{ captureId: string | null } | null>(null)
  const bridge = useMemo(() => findNativeBridge() !== null, [])
  const consented = !!patient.data?.consents.some((c) => c.type === 'thermal_imaging' && c.status === 'granted')
  return (
    <Card
      title="Thermal imaging"
      actions={
        <Button size="sm" icon={<Thermometer aria-hidden="true" className="size-4" />} onClick={() => setOpen({ captureId: null })} disabled={!canEdit} data-testid="thermal-open">
          Open thermal imaging
        </Button>
      }
    >
      <div className="space-y-3 text-sm" data-testid="thermal-panel">
        <p className="text-ink-muted" data-testid="thermal-panel-camera">
          {bridge ? 'Camera bridge present: a FLIR ONE on this tablet’s USB-C port can be connected in the workspace.' : 'FLIR ONE not connected: this page is not running in the ADAXAI tablet app, so no thermal camera can be reached from here.'}
        </p>
        {patient.data && !consented && (
          <Alert tone="info" live={false}>
            The patient&apos;s consent to thermal imaging is not recorded. Record it on the patient&apos;s record before capturing; the server refuses a capture without it.
          </Alert>
        )}
        {studies.isError && <Alert tone="error">The thermal images could not be loaded.</Alert>}
        {mine.length ? (
          <ul className="space-y-2">
            {mine.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setOpen({ captureId: c.id })} className="flex min-h-control w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line px-3 py-2 text-left hover:bg-canvas" data-testid="thermal-panel-study">
                  <ThermalSourceBadge capture={c} />
                  <span className="font-medium">{c.protocol.bodySite ? BODY_SITES[c.protocol.bodySite] : c.protocol.bodyRegion}</span>
                  <span className="text-ink-muted tabular-nums">
                    {fmtTime(c.capturedAt ?? c.createdAt)} · {fmtC(c.minC)} to {fmtC(c.maxC)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">No thermal image in this consultation.</p>
        )}
        <p className="text-xs text-ink-muted">Thermal imaging measures skin-surface temperature. It does not measure pain and is not a diagnosis.</p>
      </div>
      {open && <ThermalWorkspace encounter={encounter} inserter={inserter} canEdit={canEdit} initialCaptureId={open.captureId} onClose={() => setOpen(null)} />}
    </Card>
  )
}
