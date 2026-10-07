import type { AuscultationRecording, Encounter } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { ScanHeart, Stethoscope, Thermometer } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api.ts'
import { usePatientThermal } from '../../lib/thermal.ts'
import { auscultationsKey } from '../clinical/AuscultationCard.tsx'
import { Sheet } from '../hero/Sheet.tsx'
import { ThermalAnalysisSheet } from '../thermal/ThermalAnalysis.tsx'
import { PanelBoundary } from '../ui/PanelBoundary.tsx'
import { StethoscopePanel } from './StethoscopePanel.tsx'
import { openThermal } from './summaries/ThermalSummary.tsx'

/** The look of a clinical signal tile (premium design): a white tile with a coloured icon, a small label, the value large. */
export const SIGNAL_TILE = 'min-w-0 rounded-xl border border-line/70 bg-surface px-3 py-2.5 shadow-[0_1px_2px_rgb(15_23_42/0.03)]'

const subtleSimulated = <span className="ml-1 rounded border border-dashed border-ink-muted/50 px-1 text-[0.625rem] font-semibold tracking-wide text-ink-muted">SIMULATED</span>

/**
 * The stethoscope in the clinical signals (premium design): this consultation's recordings at a glance ("Recorded" / "Not recorded"; recordings
 * are never analysed), and the full stethoscope (site, Record, Upload, the simulator's recording, playback) in a sheet. Reads the patient's
 * recordings list the stethoscope panel itself reads (one query, shared).
 */
export function StethoscopeTile({ encounter }: { encounter: Encounter }) {
  const [open, setOpen] = useState(false)
  const patientId = encounter.patient.id
  const list = useQuery({ queryKey: auscultationsKey(patientId), queryFn: () => api<{ recordings: AuscultationRecording[] }>(`/patients/${patientId}/auscultations`), select: (d) => d.recordings })
  const mine = (list.data ?? []).filter((r) => r.encounterId === encounter.id)
  const simulated = mine.length > 0 && mine.every((r) => r.simulated)
  return (
    <li className={SIGNAL_TILE} data-testid="stethoscope-tile">
      <button type="button" onClick={() => setOpen(true)} className="block w-full text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand" aria-haspopup="dialog">
        <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          <Stethoscope aria-hidden="true" className="size-4 text-teal-600" />
          Stethoscope
        </span>
        <span className="mt-1 block text-sm leading-6 font-semibold">{mine.length ? 'Recorded' : list.isPending ? '…' : 'Not recorded'}</span>
        <span className="block text-[0.6875rem] leading-4 text-ink-muted">
          {mine.length ? `${mine.length} recording${mine.length === 1 ? '' : 's'} · not analysed` : 'Record or upload'}
          {simulated && subtleSimulated}
        </span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Stethoscope" subtitle="Recordings are kept with this consultation; they are not analysed by any model." width="wide" testId="stethoscope-sheet">
        <PanelBoundary label="The stethoscope" neutral>
          <StethoscopePanel encounter={encounter} />
        </PanelBoundary>
      </Sheet>
    </li>
  )
}

/**
 * Thermal in the clinical signals (premium design): this consultation's newest image ("Captured", SIMULATED when the simulator made it), with
 * [Capture] (the thermal workspace of the panel below) and [View analysis] (the thermal analysis dashboard: demonstration indices, not clinically
 * validated). Reads the patient's thermal list the thermal panel reads (one query, shared).
 */
export function ThermalTile({ encounter }: { encounter: Encounter }) {
  const [analysis, setAnalysis] = useState<string | null>(null)
  const studies = usePatientThermal(encounter.patient.id)
  const mine = (studies.data ?? []).filter((c) => c.encounterId === encounter.id).sort((a, b) => Date.parse(b.capturedAt ?? b.createdAt) - Date.parse(a.capturedAt ?? a.createdAt))
  const newest = mine[0]
  return (
    <li className={SIGNAL_TILE} data-testid="thermal-tile">
      <span className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <Thermometer aria-hidden="true" className="size-4 text-orange-500" />
        Thermal
      </span>
      <span className="mt-1 block text-sm leading-6 font-semibold">{newest ? 'Captured' : studies.isPending ? '…' : 'Not captured'}</span>
      <span className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] leading-5">
        {newest ? (
          <button type="button" onClick={() => setAnalysis(newest.id)} className="inline-flex items-center gap-1 font-semibold text-brand-strong hover:underline" data-testid="thermal-view-analysis">
            <ScanHeart aria-hidden="true" className="size-3.5" />
            View analysis
          </button>
        ) : (
          <button type="button" onClick={openThermal} disabled={!encounter.canEdit} className="font-semibold text-brand-strong hover:underline disabled:text-ink-muted disabled:no-underline" data-testid="thermal-tile-capture">
            Capture
          </button>
        )}
        {newest?.simulated && subtleSimulated}
      </span>
      <ThermalAnalysisSheet captureId={analysis} patient={{ name: encounter.patient.fullName, mrn: encounter.patient.mrn }} onClose={() => setAnalysis(null)} />
    </li>
  )
}
