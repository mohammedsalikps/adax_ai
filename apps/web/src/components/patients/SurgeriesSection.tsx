import { type PatientHistory, type PatientProcedure, ProcedureInput } from '@adaxai/contracts'
import { Plus, Scissors } from 'lucide-react'
import { useRef, useState } from 'react'
import { errorMessage, issuesToErrors } from '../../lib/api.ts'
import { useAddProcedure, useProcedureEnteredInError } from '../../lib/documents.ts'
import { fmtDate } from '../../lib/format.ts'
import { localDay, procedureWhen } from '../../lib/patientRecord.ts'
import { ReasonDialog } from '../clinical/HistoryDialogs.tsx'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { SelectField, TextAreaField, TextField } from '../ui/Form.tsx'
import { Menu } from '../ui/Menu.tsx'
import { useToast } from '../ui/Toast.tsx'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** A person's name without the marker the synthetic dataset adds to it. */
const person = (name: string | null) => name?.replace(/\s*\(synthetic\)$/i, '') ?? null

const procedureEntry = (p: PatientProcedure) => `${p.name}, ${procedureWhen(p)}; entered by ${person(p.enteredByName) ?? 'unknown'} on ${fmtDate(localDay(p.enteredAt))}`

/** Adds a surgery or another past procedure (doctors): the name, when it was done if known (year, or year and month), an optional note. */
export function AddSurgeryDialog({ patientId, onClose }: { patientId: string; onClose: () => void }) {
  const toast = useToast()
  const add = useAddProcedure(patientId)
  const sending = useRef(false)
  const [v, setV] = useState({ name: '', year: '', month: '', note: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const set = (k: keyof typeof v, value: string) => {
    setV((x) => ({ ...x, [k]: value }))
    setErrors((e) => ({ ...e, [k === 'year' ? 'performedYear' : k === 'month' ? 'performedMonth' : k]: '' }))
  }
  const save = () => {
    const parsed = ProcedureInput.safeParse({ name: v.name, performedYear: v.year.trim() ? Number(v.year) : null, performedMonth: v.month ? Number(v.month) : null, note: v.note })
    if (!parsed.success) {
      const out: Record<string, string> = {}
      for (const i of parsed.error.issues) out[i.path.join('.') || '_form'] ??= i.message
      return setErrors(out)
    }
    if (sending.current) return
    sending.current = true
    add.mutate(parsed.data, {
      onSettled: () => {
        sending.current = false
      },
      onSuccess: () => {
        toast('success', 'Surgery added to the history')
        onClose()
      },
      onError: (e) => setErrors(issuesToErrors(e)),
    })
  }
  const formError = add.isError && !Object.keys(issuesToErrors(add.error)).length ? errorMessage(add.error) : null
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a surgery or procedure"
      dismissible={!add.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={add.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        {formError && <Alert tone="error">{formError}</Alert>}
        <TextField label="Surgery or procedure" placeholder="Appendectomy" value={v.name} onChange={(e) => set('name', e.target.value)} error={errors.name} required maxLength={120} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Year (if known)" type="number" inputMode="numeric" min={1900} max={new Date().getFullYear()} value={v.year} onChange={(e) => set('year', e.target.value)} error={errors.performedYear} />
          <SelectField label="Month (optional)" value={v.month} onChange={(e) => set('month', e.target.value)} error={errors.performedMonth}>
            <option value="">Not known</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </SelectField>
        </div>
        <TextAreaField label="Note (optional)" rows={2} value={v.note} onChange={(e) => set('note', e.target.value)} error={errors.note} maxLength={300} />
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  )
}

/**
 * The surgeries and other past procedures on the history (in the past-history panel's Summary): each with when it was done (or that the
 * date is not recorded) and who entered it. Doctors add them and mark a mistake as entered in error (kept, with the reason); nurses read.
 * `procedures` undefined means the server did not send them: said as not available, never as none.
 */
export function SurgeriesSection({ h, patientId, canWrite }: { h: Pick<PatientHistory, 'procedures'>; patientId: string; canWrite: boolean }) {
  const toast = useToast()
  const markError = useProcedureEnteredInError(patientId)
  const [adding, setAdding] = useState(false)
  const [marking, setMarking] = useState<PatientProcedure | null>(null)
  const list = h.procedures
  return (
    <section aria-label="Surgeries and procedures" data-testid="history-surgeries">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Surgeries and procedures</h3>
        {canWrite && list !== undefined && (
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setAdding(true)}>
            Add surgery
          </Button>
        )}
      </div>
      {list === undefined ? (
        <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted">Surgeries are not available yet.</p>
      ) : list.length ? (
        <ul className="divide-y divide-line">
          {list.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2" data-testid="history-surgery">
              <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <Scissors className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">{p.name}</p>
                <p className="text-xs text-ink-muted">
                  {procedureWhen(p).replace(/^date/, 'Date')}
                  {p.note ? ` · ${p.note}` : ''}
                </p>
                <p className="text-xs text-ink-muted">
                  Entered by {person(p.enteredByName) ?? 'unknown'}, {fmtDate(localDay(p.enteredAt))}
                </p>
              </div>
              {canWrite && (
                <Menu
                  label={`Actions for ${p.name}, ${procedureWhen(p)}`}
                  items={[
                    {
                      label: 'Entered in error…',
                      tone: 'danger',
                      onSelect: () => {
                        markError.reset()
                        setMarking(p)
                      },
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted">No surgeries are recorded.</p>
      )}
      {adding && <AddSurgeryDialog patientId={patientId} onClose={() => setAdding(false)} />}
      {marking && (
        <ReasonDialog
          title={`Mark “${marking.name}” as entered in error`}
          entry={procedureEntry(marking)}
          intro="The entry stays in the record, marked as an error with your reason, and leaves the history. This cannot be undone."
          confirmLabel="Mark as entered in error"
          pending={markError.isPending}
          error={markError.error}
          onClose={() => setMarking(null)}
          onConfirm={(reason) =>
            markError.mutate(
              { id: marking.id, reason },
              {
                onSuccess: () => {
                  toast('success', 'Marked as entered in error')
                  setMarking(null)
                },
              },
            )
          }
        />
      )}
    </section>
  )
}
