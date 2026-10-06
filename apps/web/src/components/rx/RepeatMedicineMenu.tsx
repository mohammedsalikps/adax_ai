import type { Medication, PatientHistory, PrescriptionItemInput } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Pill, Repeat } from 'lucide-react'
import { api } from '../../lib/api.ts'
import { fmtDate } from '../../lib/format.ts'
import { historyKey } from '../../lib/history.ts'
import { Menu, type MenuItem } from '../ui/Menu.tsx'

/** A medicine on the patient's list as a prescription row: what the list records, the duration and instructions left for the doctor. */
export const rxFromMedication = (m: Pick<Medication, 'drugName' | 'strength' | 'form' | 'dose' | 'route' | 'frequency'>): PrescriptionItemInput => ({
  drugName: m.drugName,
  strength: m.strength ?? '',
  form: m.form ?? '',
  dose: m.dose,
  route: m.route ?? '',
  frequency: m.frequency,
  duration: '',
  instructions: '',
})

export const medicineName = (m: Pick<Medication, 'drugName' | 'strength' | 'form'>) => [m.drugName, m.strength, m.form].filter(Boolean).join(' ')

/** The class of a secondary control drawn as a link or a menu's button, the same as the secondary Button beside it (44px). */
export const SECONDARY_CONTROL = 'inline-flex min-h-control items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium shadow-card hover:bg-canvas'

/**
 * "Repeat a current medicine": a menu of the medicines the patient's record lists as current (the medicine list staff keep, not an earlier
 * prescription), each with its strength, form, dose and frequency as recorded. Choosing one adds a new row filled from that entry: the doctor's
 * act, and from then on the row is the doctor's to change like any other (the duration and the instructions are left for the doctor). It reads
 * the history the prescription's allergy list already reads (observed: no request of its own). Missing is not none: when the list is not read
 * yet, cannot be read, or has no current medicine, the menu says so and offers nothing.
 */
export function RepeatMedicineMenu({ patientId, items, onRepeat, triggerClassName = SECONDARY_CONTROL }: { patientId: string; items: PrescriptionItemInput[]; onRepeat: (m: Medication) => void; triggerClassName?: string }) {
  const history = useQuery({ queryKey: historyKey(patientId), queryFn: () => api<PatientHistory>(`/patients/${patientId}/history`), enabled: false })
  const current = history.data?.medications.filter((m) => m.status === 'current') ?? null
  const prescribed = new Set(items.map((p) => (p.drugName ?? '').trim().toLowerCase()).filter(Boolean))
  const note = (text: string): MenuItem => ({ label: text, name: text, disabled: true, onSelect: () => undefined })
  const menu: MenuItem[] = !current
    ? [note(history.isError ? 'The medicine list could not be read just now' : 'The medicine list has not been read yet')]
    : !current.length
      ? [note('No current medicines recorded')]
      : current.map((m) => {
          const name = medicineName(m)
          const how = [m.dose, m.route, m.frequency].filter(Boolean).join(' · ')
          const already = prescribed.has(m.drugName.trim().toLowerCase())
          return {
            name: `${name} ${m.id}`,
            icon: <Pill aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />,
            label: (
              <span className="min-w-0 py-1.5">
                <span className="block break-words">{name}</span>
                <span className="block text-xs font-normal break-words text-ink-muted">
                  {how}
                  {m.startedOn ? ` · on the list since ${fmtDate(m.startedOn)}` : ' · on the list'}
                  {already ? ' · already in this prescription' : ''}
                </span>
              </span>
            ),
            onSelect: () => onRepeat(m),
          }
        })
  return (
    <Menu
      label="Repeat a current medicine"
      items={menu}
      align="end"
      trigger={
        <>
          <Repeat aria-hidden="true" className="size-4" />
          Repeat a current medicine
        </>
      }
      triggerClassName={triggerClassName}
    />
  )
}
