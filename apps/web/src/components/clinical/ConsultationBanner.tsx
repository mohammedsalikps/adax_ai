import type { Encounter } from '@adaxai/contracts'
import { TriangleAlert } from 'lucide-react'
import { Badge } from '../ui/Feedback.tsx'
import { useAllergies } from './AllergyItems.tsx'

/*
 * The patient's allergies in the consultation header (DESIGN §5.4: always visible). The earlier banner under the consultation bar (age, sex,
 * MRN, the vital-signs badge, the reason for the visit, the status chips) is replaced by the compact header (ConsultationHeader): its
 * identity line, VitalsSnapshot and the recording status; the reason for the visit and the conditions are in the patient history panel.
 */

/**
 * The allergies as chips (put them in a `ul`): each with its severity and a warning sign, read as "Allergy: Penicillin (Severe)"; "No known
 * allergies (recorded)" when that is what the record says; "Allergy status not recorded" when it says nothing (missing is not none); and a
 * warning when the list may be out of date. From the patient's record, falling back to the consultation's own list (see `useAllergies`),
 * which it keeps reading (every two minutes): the patient history panel only observes that read.
 */
export function AllergyChips({ encounter }: { encounter: Pick<Encounter, 'patient'> }) {
  const a = useAllergies(encounter)
  return (
    <>
      {a.chips.map((c) => (
        <li key={c.key}>
          <Badge tone={c.tone} wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
            <span className="sr-only">Allergy: </span>
            {c.text.replace(/^Allergy: /, '')}
          </Badge>
        </li>
      ))}
      {a.noKnown && (
        <li>
          <Badge wrap>No known allergies (recorded)</Badge>
        </li>
      )}
      {a.notRecorded && (
        <li>
          <Badge tone="warn" wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
            Allergy status not recorded
          </Badge>
        </li>
      )}
      {a.stale && (
        <li>
          <Badge tone="warn" wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
            Allergy list may be out of date
          </Badge>
        </li>
      )}
    </>
  )
}
