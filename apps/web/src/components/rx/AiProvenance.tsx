import { INSERTION_SUBJECTS, NOTE_SECTIONS, type NoteFields, type NoteInsertion } from '@adaxai/contracts'
import { ListChecks, Sparkles } from 'lucide-react'
import { fmtDateTime } from '../../lib/format.ts'

/**
 * Where AI-produced text in the note came from (shown while editing, before signing and on the signed record). A thermal study summary is
 * composed by fixed rules, not by a model (DESIGN §5.7): it is said "Rule-composed text", in the neutral tone, without the AI's sparkle.
 */
export function AiProvenance({ insertions, section }: { insertions: NoteInsertion[]; section?: keyof NoteFields }) {
  const list = section ? insertions.filter((i) => i.section === section) : insertions
  if (!list.length) return null
  return (
    <ul className="mt-1 space-y-0.5 text-xs" aria-label={section ? 'AI-assisted text in this section' : 'AI-assisted text in this note'}>
      {list.map((i) => {
        const rules = i.subjectType === 'thermal_summary'
        const Icon = rules ? ListChecks : Sparkles
        return (
          <li key={i.id} className={rules ? 'text-ink-muted' : 'text-ai'} data-subject={i.subjectType}>
            <Icon aria-hidden="true" className="mr-1 inline size-3" />
            {section ? '' : `${NOTE_SECTIONS.find((s) => s.key === i.section)?.label}: `}
            {rules ? 'Rule-composed text' : 'AI-assisted text'} from {INSERTION_SUBJECTS[i.subjectType].toLowerCase()}
            {i.producedBy && ` (${i.producedBy})`}, inserted {fmtDateTime(i.insertedAt)}
            {i.insertedByName && ` by ${i.insertedByName}`} · {i.retained ? 'unchanged in the note' : 'edited or removed since'}
          </li>
        )
      })}
    </ul>
  )
}
