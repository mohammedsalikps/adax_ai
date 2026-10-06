import { TriangleAlert } from 'lucide-react'
import type { RecordLine } from '../../lib/patientRecord.ts'
import { KeyValue, KeyValueList } from '../hero/index.ts'

const TONE: Record<RecordLine['tone'], string> = { down: 'font-medium text-down', warn: 'font-medium text-pending', neutral: '' }

/**
 * The record's compact lines (lib/patientRecord.ts `recordLines`) as label/value rows: "Allergies  Penicillin (severe)". A missing value is
 * said in muted words ("Not recorded", "Not available yet"); a missing allergy status is a warning, never hidden. Each row has
 * `data-testid="record-line-<key>"`.
 */
export function RecordLines({ lines, className = '' }: { lines: RecordLine[]; className?: string }) {
  return (
    <KeyValueList className={className}>
      {lines.map((l) => (
        <KeyValue
          key={l.key}
          label={l.label}
          testId={`record-line-${l.key}`}
          value={
            <span className={l.missing && l.tone === 'neutral' ? 'text-ink-muted' : TONE[l.tone]}>
              {(l.tone === 'down' || (l.key === 'allergies' && l.tone === 'warn')) && <TriangleAlert aria-hidden="true" className="mr-1 inline size-3.5 -translate-y-px" />}
              {l.text}
            </span>
          }
        />
      ))}
    </KeyValueList>
  )
}
