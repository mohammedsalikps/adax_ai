import { NOTE_SECTIONS, type NoteFields, type NoteInsertion } from '@adaxai/contracts'
import { ChevronDown, NotebookPen } from 'lucide-react'
import { useId, useState } from 'react'
import { Panel } from '../hero/Panel.tsx'
import { Badge } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { AiProvenance } from './AiProvenance.tsx'

/** The note's sections on the prescription page's right column instead (Advice / diet is the Plan; Follow-up): never edited in two places. */
export const RX_COLUMN_SECTIONS: readonly (keyof NoteFields)[] = ['plan', 'followUp']

/**
 * "Clinical note" under the clinical summary (DESIGN §5.6): the typed note, folded by default. The chief complaint is always shown, because
 * signing needs it; the other sections open on demand. Read only once signed (or for anyone who cannot edit it).
 */
export function ClinicalNote({ note, insertions, onChange, readOnly, inserting, locked }: { note: NoteFields; insertions: NoteInsertion[]; onChange?: (key: keyof NoteFields, value: string) => void; readOnly: boolean; inserting?: boolean; locked?: boolean }) {
  const [open, setOpen] = useState(false)
  const restId = useId()
  const [first, ...rest] = NOTE_SECTIONS.filter((s) => !RX_COLUMN_SECTIONS.includes(s.key))
  const written = rest.filter((s) => note[s.key].trim()).length
  const section = (s: (typeof NOTE_SECTIONS)[number]) =>
    readOnly ? (
      <div key={s.key}>
        <p className="text-sm font-medium">{s.label}</p>
        <p className="mt-0.5 text-sm whitespace-pre-wrap">{note[s.key] || <span className="text-ink-muted">Not recorded</span>}</p>
      </div>
    ) : (
      <div key={s.key}>
        <TextAreaField label={s.label} hint={s.hint} rows={s.rows} value={note[s.key]} readOnly={inserting || locked} onChange={(e) => onChange?.(s.key, e.target.value)} />
        <AiProvenance insertions={insertions} section={s.key} />
      </div>
    )
  return (
    <Panel label="Clinical note" icon={NotebookPen} testId="rx-clinical-note" actions={inserting ? <Badge tone="ai">Inserting AI text…</Badge> : undefined}>
      <div className="space-y-4">
        {first && section(first)}
        <button type="button" className="inline-flex min-h-control-sm items-center gap-1.5 rounded-md text-left text-sm font-medium text-ink-muted hover:text-ink" aria-expanded={open} aria-controls={restId} onClick={() => setOpen((o) => !o)}>
          <ChevronDown aria-hidden="true" className={`size-4 transition-transform motion-safe:duration-150 ${open ? 'rotate-180' : ''}`} />
          {open ? 'Hide the rest of the note' : `Show the rest of the note (${written} of ${rest.length} sections written)`}
        </button>
        <div id={restId} hidden={!open} className="space-y-4">
          {rest.map(section)}
        </div>
      </div>
    </Panel>
  )
}
