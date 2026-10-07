import type { ThermalCaptureSource } from '@adaxai/contracts'
import { thermalSourceLabel } from '../../lib/thermal.ts'
import { SimulatedBadge } from '../clinical/DeviceReadingsCard.tsx'

const STYLE: Record<Exclude<ThermalCaptureSource, 'simulator'>, string> = {
  live_capture: 'border-brand/30 bg-brand-soft text-brand-strong',
  gallery_import: 'border-ink/60 bg-surface text-ink',
  file_upload: 'border-line bg-canvas text-ink-muted',
}

/**
 * Where a thermal image came from, in words, wherever a capture is listed or shown: LIVE CAPTURE (from a camera in the consultation), IMPORTED
 * (an earlier file chosen from the device), UPLOADED (a file on the thermal pages), or SIMULATED with the device card's dashed edge, so that a
 * simulator's numbers never pass for a measurement anywhere. Live and imported are what the sending screen said; every stored file was checked
 * to be radiometric. A capture whose source is not known (an older list row) shows nothing rather than a guess.
 */
export function ThermalSourceBadge({ capture, compact = false, simulatedLabel }: { capture: { captureSource?: ThermalCaptureSource | null | undefined; simulated?: boolean | null | undefined }; compact?: boolean; simulatedLabel?: string }) {
  const label = thermalSourceLabel(capture)
  if (!label) return null
  const simulated = !!capture.simulated || capture.captureSource === 'simulator'
  return (
    <span data-testid="thermal-source" data-source={simulated ? 'simulator' : capture.captureSource} className="relative inline-flex max-w-full">
      <span className="sr-only">Source: </span>
      {simulated ? (
        <SimulatedBadge compact={compact} {...(simulatedLabel && { what: simulatedLabel })} />
      ) : (
        <span className={`inline-flex items-center rounded-md border font-semibold tracking-wide whitespace-nowrap ${compact ? 'px-1.5 py-px text-[0.6875rem] leading-4' : 'px-2 py-0.5 text-xs'} ${STYLE[capture.captureSource as Exclude<ThermalCaptureSource, 'simulator'>]}`}>
          {label}
        </span>
      )}
    </span>
  )
}
