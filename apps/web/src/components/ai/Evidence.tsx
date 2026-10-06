import { type Evidence, PROVENANCE_LABELS, type Provenance } from '@adaxai/contracts'
import { ChevronDown } from 'lucide-react'
import { Badge } from '../ui/Feedback.tsx'

const SOURCE_LABEL: Record<string, string> = {
  transcript_segment: 'Transcript',
  allergy: 'Allergy list',
  patient: 'Patient record',
  observation: 'Vital signs',
  diagnosis: 'Previous diagnosis',
  prescription_item: 'Prescription',
  encounter_note: 'Consultation note',
  prior_encounter: 'Previous consultation',
  thermal_capture: 'Thermal measurement',
  clinical_image: 'Clinical photograph',
}

export const provenanceLabel = (p: string) => PROVENANCE_LABELS[p as Provenance] ?? p

/** Where each supporting or conflicting statement comes from, kept visibly distinct. */
export function EvidenceList({ evidence, onFocusSegments }: { evidence: Evidence[]; onFocusSegments?: (ids: string[]) => void }) {
  if (!evidence.length) return <p className="text-xs text-ink-muted">No supporting source could be verified.</p>
  const supports = evidence.filter((e) => e.relation === 'supports')
  const conflicts = evidence.filter((e) => e.relation === 'conflicts')
  const list = (items: Evidence[]) => (
    <ul className="mt-1 space-y-1">
      {items.map((e) => (
        <li key={e.id} className="py-1">
          <span className="font-mono text-ink-muted">{e.sourceRef}</span> <Badge tone={e.provenance === 'record' ? 'notice' : e.provenance.endsWith('measured') ? 'ok' : 'neutral'}>{provenanceLabel(e.provenance)}</Badge>{' '}
          <span className="text-ink-muted">{SOURCE_LABEL[e.sourceType] ?? e.sourceType}:</span> “{e.excerpt}”{e.note && <span className="block text-ink-muted">{e.note}</span>}
        </li>
      ))}
    </ul>
  )
  return (
    <details
      className="group/evidence text-xs"
      onToggle={(ev) => {
        if ((ev.currentTarget as HTMLDetailsElement).open) onFocusSegments?.(evidence.filter((e) => e.sourceType === 'transcript_segment').map((e) => e.sourceRef))
      }}
    >
      <summary className="inline-flex max-w-full cursor-pointer list-none items-center gap-1 rounded-md text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open/evidence:rotate-180" />
        Sources: {supports.map((e) => e.sourceRef).join(', ') || 'none'}
        {conflicts.length > 0 && <span className="font-medium text-down"> · conflicts with {conflicts.map((e) => e.sourceRef).join(', ')}</span>}
      </summary>
      {supports.length > 0 && list(supports)}
      {conflicts.length > 0 && (
        <>
          <p className="mt-2 font-medium text-down">Conflicting</p>
          {list(conflicts)}
        </>
      )}
    </details>
  )
}
