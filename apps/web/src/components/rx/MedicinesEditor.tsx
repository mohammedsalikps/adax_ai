import { type DiagnosisInput, FREQUENCY_PRESETS, type Medication, type PrescriptionItemInput } from '@adaxai/contracts'
import { CalendarDays, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { durationLines } from '../../lib/prescriptionCourse.ts'
import { Button } from '../ui/Button.tsx'
import { SelectField, TextField } from '../ui/Form.tsx'
import { useToast } from '../ui/Toast.tsx'
import { RepeatMedicineMenu, rxFromMedication } from './RepeatMedicineMenu.tsx'
import { courseStart, DURATION_PRESETS, durationReading, emptyRx, RowKeys, settledDuration, withDurationText, withStartDate } from './rxModel.ts'

/**
 * The medicines of the prescription page (DESIGN §5.6), written by the doctor alone: one row per medicine (Medicine, strength and form; dose,
 * route, frequency; Duration; Instructions; Remove). The Duration is written as words ("5 days", "When needed (SOS)"); when the words give a
 * number of days the row also carries that course (durationDays) and its first day ("5 days from 6 Oct 2026": the consultation's date unless
 * the doctor changes it), and both are saved together with every autosave. Nothing an AI writes is ever put here.
 */
export function MedicinesEditor({ items, onChange, patientId, visitDate, readOnly }: { items: PrescriptionItemInput[]; onChange: (next: PrescriptionItemInput[]) => void; patientId: string; visitDate: string; readOnly?: boolean }) {
  const toast = useToast()
  const set = (i: number, fn: (p: PrescriptionItemInput) => PrescriptionItemInput) => onChange(items.map((d, j) => (j === i ? fn(d) : d)))
  // A row's own state (an open "Change start") stays with its medicine when a row above it is removed.
  const [rowKeys] = useState(() => new RowKeys())
  const keys = rowKeys.of(items.length)
  const remove = (i: number) => {
    rowKeys.remove(i)
    onChange(items.filter((_, j) => j !== i))
  }
  // A row added by the doctor's choice takes focus once it is drawn, so the doctor goes on in it.
  const [focusRow, setFocusRow] = useState<number | null>(null)
  useEffect(() => {
    if (focusRow === null) return
    document.querySelector<HTMLInputElement>(`[data-rx-row="${focusRow}"] input`)?.focus()
    setFocusRow(null)
  }, [focusRow, items.length])
  const add = (item: PrescriptionItemInput) => {
    onChange([...items, item])
    setFocusRow(items.length)
  }
  const repeat = (m: Medication) => {
    add(rxFromMedication(m))
    toast('success', `Medicine ${items.length + 1} filled from the medicine list. Check each field and add the duration.`)
  }
  return (
    <div className="@container/meds space-y-3" data-testid="rx-medicines">
      <datalist id="frequency-presets">
        {FREQUENCY_PRESETS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <datalist id="duration-presets">
        {DURATION_PRESETS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      {!items.length && <p className="text-sm text-ink-muted">No medicines prescribed.</p>}
      <ol className="divide-y divide-line">
        {items.map((p, i) => (
          <MedicineRow key={keys[i]} n={i + 1} item={p} visitDate={visitDate} readOnly={readOnly} onChange={(fn) => set(i, fn)} onRemove={() => remove(i)} />
        ))}
      </ol>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => add(emptyRx())} data-rx-add>
            Add medicine
          </Button>
          <RepeatMedicineMenu patientId={patientId} items={items} onRepeat={repeat} />
        </div>
      )}
    </div>
  )
}

function MedicineRow({ n, item: p, visitDate, readOnly, onChange, onRemove }: { n: number; item: PrescriptionItemInput; visitDate: string; readOnly?: boolean; onChange: (fn: (p: PrescriptionItemInput) => PrescriptionItemInput) => void; onRemove: () => void }) {
  const [changingStart, setChangingStart] = useState(false)
  const startId = useId()
  const reading = durationReading(p, visitDate)
  const field = (key: keyof PrescriptionItemInput) => ({
    value: (p[key] as string | null | undefined) ?? '',
    readOnly,
    onChange: (e: { target: { value: string } }) => onChange((x) => ({ ...x, [key]: e.target.value })),
  })
  return (
    <li className="min-w-0 py-3 first:pt-0" data-rx-row={n - 1}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold tabular-nums">Medicine {n}</p>
        {!readOnly && (
          <Button size="sm" variant="ghost" aria-label={`Remove medicine ${n}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 @sm/meds:grid-cols-2 @2xl/meds:grid-cols-12">
        <TextField label="Medicine" {...field('drugName')} className="@sm/meds:col-span-2 @2xl/meds:col-span-6" />
        <TextField label="Strength" placeholder="500 mg" {...field('strength')} className="@2xl/meds:col-span-3" />
        <TextField label="Form" placeholder="Tablet" {...field('form')} className="@2xl/meds:col-span-3" />
        <TextField label="Dose" placeholder="1 tablet" {...field('dose')} className="@2xl/meds:col-span-2" />
        <TextField label="Route" {...field('route')} className="@2xl/meds:col-span-2" />
        <TextField label="Frequency" list="frequency-presets" {...field('frequency')} className="@2xl/meds:col-span-4" />
        <div className="min-w-0 @2xl/meds:col-span-4">
          <TextField
            label="Duration"
            placeholder="5 days"
            list="duration-presets"
            value={p.duration ?? ''}
            readOnly={readOnly}
            onChange={(e) => onChange((x) => withDurationText(x, e.target.value))}
            // Only when leaving the field changes the words (a bare number written out): tabbing through saves nothing.
            onBlur={() => {
              if (settledDuration(p)) onChange((x) => settledDuration(x) ?? x)
            }}
            hint={reading.kind === 'empty' ? 'Days, or words such as “When needed (SOS)”' : undefined}
          />
          {reading.kind !== 'empty' && (
            <p className={`mt-1 text-xs ${reading.kind === 'course' ? 'text-ink' : 'text-ink-muted'}`} data-testid="rx-course" data-kind={reading.kind}>
              {reading.text}
              {reading.kind === 'course' && !readOnly && (
                <button type="button" className="ml-1.5 inline-flex min-h-control-sm items-center gap-1 font-medium text-brand-strong underline-offset-2 hover:underline" aria-expanded={changingStart} aria-controls={startId} onClick={() => setChangingStart((o) => !o)}>
                  <CalendarDays aria-hidden="true" className="size-3.5" />
                  Change start
                  <span className="sr-only"> of medicine {n}</span>
                </button>
              )}
            </p>
          )}
          {changingStart && reading.kind === 'course' && (
            <div id={startId} className="mt-1">
              <TextField
                label="Course starts"
                type="date"
                value={courseStart(p, visitDate) ?? ''}
                min={visitDate.slice(0, 10)}
                onChange={(e) => onChange((x) => withStartDate(x, e.target.value || null))}
              />
            </div>
          )}
        </div>
        <TextField label="Instructions" placeholder="After food" {...field('instructions')} className="@sm/meds:col-span-2 @2xl/meds:col-span-12" />
      </div>
    </li>
  )
}

/** A signed prescription's medicines, read as a document: one line each, the course as the printout says it ("5 days from 6 Oct 2026"). */
export function MedicinesList({ items, visitDate }: { items: PrescriptionItemInput[]; visitDate: string }) {
  if (!items.length) return <p className="text-sm text-ink-muted">No medicines prescribed.</p>
  return (
    <ol className="divide-y divide-line text-sm" data-testid="rx-medicines-signed">
      {items.map((p, i) => {
        const d = durationLines({ duration: p.duration ?? '', durationDays: p.durationDays ?? null, startDate: p.startDate ?? courseStart(p, visitDate) })
        return (
          <li key={i} className="py-2 first:pt-0">
            <p className="font-semibold">
              {i + 1}. {[p.drugName, p.strength, p.form].filter(Boolean).join(' ')}
            </p>
            <p className="text-ink-muted">
              {[p.dose, p.route, p.frequency, d.main].filter(Boolean).join(' · ')}
              {d.written && ` (${d.written})`}
            </p>
            {p.instructions && <p>{p.instructions}</p>}
          </li>
        )
      })}
    </ol>
  )
}

/** The diagnosis rows (at least one is needed to sign; the ICD-10 code is optional and checked for format only). */
export function DiagnosesEditor({ items, onChange, readOnly }: { items: DiagnosisInput[]; onChange: (next: DiagnosisInput[]) => void; readOnly?: boolean }) {
  const set = (i: number, patch: Partial<DiagnosisInput>) => onChange(items.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  return (
    <div className="@container/dx space-y-3" data-testid="rx-diagnoses">
      {!items.length && <p className="text-sm text-ink-muted">No diagnosis yet. At least one is needed to sign (provisional is fine).</p>}
      <ul className="space-y-3">
        {items.map((d, i) => (
          <li key={i} className="grid grid-cols-1 gap-3 @sm/dx:grid-cols-2 @2xl/dx:grid-cols-[minmax(10rem,1fr)_8rem_9rem_auto] @2xl/dx:items-end">
            <TextField label={`Diagnosis ${i + 1}`} value={d.description ?? ''} readOnly={readOnly} onChange={(e) => set(i, { description: e.target.value })} className="@sm/dx:col-span-2 @2xl/dx:col-span-1" />
            <TextField label="ICD-10 (optional)" value={d.code ?? ''} readOnly={readOnly} onChange={(e) => set(i, { code: e.target.value })} spellCheck={false} />
            <SelectField label="Type" value={d.kind ?? 'primary'} disabled={readOnly} onChange={(e) => set(i, { kind: e.target.value as DiagnosisInput['kind'] })}>
              <option value="provisional">Provisional</option>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </SelectField>
            {!readOnly && (
              <div className="flex justify-end @sm/dx:col-span-2 @2xl/dx:col-span-1">
                <Button variant="ghost" aria-label={`Remove diagnosis ${i + 1}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => onChange(items.filter((_, j) => j !== i))} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => onChange([...items, { description: '', code: '', kind: items.length ? 'secondary' : 'primary' }])}>
          Add diagnosis
        </Button>
      )}
    </div>
  )
}
