import { type Observation, RecordVitalsRequest, TRIAGE_NOTE_MAX, VITAL_ORDER, VITALS, type VitalFlag, type VitalKind } from '@adaxai/contracts'
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../../lib/api.ts'
import { useVisitMutation } from '../../lib/clinical.ts'
import { fmtTime } from '../../lib/format.ts'
import { triageNoteDraft, useSaveTriageNote } from '../../lib/triageNote.ts'
import { latestPerKind } from '../../lib/vitals.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { TextAreaField, TextField } from '../ui/Form.tsx'
import { useToast } from '../ui/Toast.tsx'

const FLAG_TEXT: Record<VitalFlag, string> = { normal: '', low: 'Low', high: 'High', critical_low: 'Very low', critical_high: 'Very high' }

export const fmtValue = (o: Pick<Observation, 'kind' | 'value'>) => o.value.toFixed(VITALS[o.kind].decimals)

/** Flag shown as text + icon (not colour alone). Reference-range flags are a display aid, not a diagnosis. */
export function FlagLabel({ flag }: { flag: VitalFlag | null }) {
  if (!flag || flag === 'normal') return null
  const critical = flag.startsWith('critical')
  const Icon = critical ? TriangleAlert : flag.endsWith('low') ? ArrowDown : ArrowUp
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${critical ? 'text-down' : 'text-pending'}`}>
      <Icon aria-hidden="true" className="size-3" />
      {FLAG_TEXT[flag]}
    </span>
  )
}

/** Compact latest-vitals line for queue rows. */
export function VitalsInline({ vitals }: { vitals: Observation[] }) {
  if (!vitals.length) return <span className="text-sm text-ink-muted">No vitals yet</span>
  const sorted = [...vitals].sort((a, b) => VITAL_ORDER.indexOf(a.kind) - VITAL_ORDER.indexOf(b.kind))
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm tabular-nums">
      {sorted.map((o) => (
        <li key={o.id} className={o.flag && o.flag !== 'normal' ? 'font-medium' : ''}>
          <span className="text-ink-muted">{VITALS[o.kind].short}</span> {fmtValue(o)}
          <span className="text-xs text-ink-muted"> {o.unit}</span> <FlagLabel flag={o.flag} />
          {/* A value nobody on the staff measured says so, here too: it stands only because staff measured nothing of this kind. */}
          {o.source === 'device' && <span className="text-xs font-normal text-ink-muted"> ({o.validationStatus === 'simulated' ? 'simulated' : 'device, unverified'})</span>}
        </li>
      ))}
    </ul>
  )
}

const worst = (a: VitalFlag | null, b: VitalFlag | null): VitalFlag | null => {
  const rank = (f: VitalFlag | null) => (f === null ? -1 : f === 'normal' ? 0 : f.startsWith('critical') ? 2 : 1)
  return rank(a) >= rank(b) ? a : b
}

/** Where a reading came from and when, so a typed value, a device value and a simulator's value are never mistaken for each other. */
export function readingSource(o: Pick<Observation, 'source' | 'validationStatus' | 'measuredAt'>): string {
  const how = o.validationStatus === 'simulated' ? 'simulated, not a measurement' : o.source === 'device' ? 'device, unverified' : 'entered by staff'
  return `${fmtTime(o.measuredAt)} · ${how}`
}

/**
 * The latest vital signs as tiles. Each says when it was recorded and by whom or what (typed by staff, or from a device that is not
 * validated in this deployment); blood pressure is the two values together. What staff measured stands; a device's value is here only where
 * staff measured nothing of that kind. These tiles are not a live feed (a reading is as old as its time says): what an attached device is
 * sending now, and how current it is, is on the "Device readings" card.
 */
export function VitalsTiles({ vitals }: { vitals: Observation[] }) {
  if (!vitals.length) return <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted">No vital signs have been recorded for this visit.</p>
  const latest = latestPerKind(vitals)
  const by = (k: VitalKind) => latest.find((o) => o.kind === k)
  const sbp = by('systolic_bp')
  const dbp = by('diastolic_bp')
  const tiles: { key: string; label: string; value: string; unit: string; flag: VitalFlag | null; source: string }[] = []
  for (const k of ['heart_rate', 'spo2'] as const) {
    const o = by(k)
    if (o) tiles.push({ key: k, label: VITALS[k].label, value: fmtValue(o), unit: o.unit, flag: o.flag, source: readingSource(o) })
  }
  if (sbp || dbp) {
    const o = (sbp ?? dbp)!
    // The two numbers are the latest of each kind; if they were not taken together, the tile says when each was.
    const source = sbp && dbp && sbp.measuredAt !== dbp.measuredAt ? `Systolic ${readingSource(sbp)}; diastolic ${readingSource(dbp)}` : readingSource(o)
    tiles.push({ key: 'bp', label: 'Blood pressure', value: `${sbp ? fmtValue(sbp) : '—'}/${dbp ? fmtValue(dbp) : '—'}`, unit: 'mmHg', flag: worst(sbp?.flag ?? null, dbp?.flag ?? null), source })
  }
  for (const k of ['temperature', 'respiratory_rate', 'blood_glucose', 'pain_score', 'weight', 'height'] as const) {
    const o = by(k)
    if (o) tiles.push({ key: k, label: VITALS[k].label, value: fmtValue(o), unit: o.unit, flag: o.flag, source: readingSource(o) })
  }
  return (
    <ul className="grid grid-cols-2 gap-2" aria-label="Latest vital signs" data-testid="vitals-tiles">
      {tiles.map((t) => (
        <li key={t.key} className="rounded-lg border border-line bg-surface p-2.5">
          <p className="text-xs text-ink-muted">{t.label}</p>
          <p className="flex flex-wrap items-baseline gap-x-1 text-lg leading-tight font-semibold tabular-nums">
            {t.value}
            <span className="text-xs font-normal text-ink-muted">{t.unit}</span>
          </p>
          <p className="min-h-4">
            <FlagLabel flag={t.flag} />
          </p>
          <p className="text-[0.6875rem] leading-snug text-ink-muted">{t.source}</p>
        </li>
      ))}
    </ul>
  )
}

const ENTRY_KINDS: VitalKind[] = ['temperature', 'heart_rate', 'respiratory_rate', 'systolic_bp', 'diastolic_bp', 'spo2', 'blood_glucose', 'pain_score', 'weight', 'height']

/**
 * Nurse/doctor vitals entry. Empty fields are skipped; ranges are validated on both client and server.
 *
 * With `triageNote` (the visit's current note, null when there is none; the nurse's queue passes it), the dialog also has an optional
 * "Triage note" for the doctor (HERO final; at most 1000 characters; emptying it clears the note). A note alone can be saved without any
 * measurement. The note is saved first; if the measurements are then refused, the note stays saved and is not sent again.
 */
export function RecordVitalsDialog({ visitId, patientName, onClose, triageNote }: { visitId: string; patientName: string; onClose: () => void; triageNote?: string | null }) {
  const toast = useToast()
  const [values, setValues] = useState<Partial<Record<VitalKind, string>>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useVisitMutation<RecordVitalsRequest>(visitId, '/observations')
  const withNote = triageNote !== undefined
  const [note, setNote] = useState(triageNote ?? '')
  const [savedNote, setSavedNote] = useState<string | null>(triageNote ?? null)
  const saveNote = useSaveTriageNote(visitId)
  const noteDraft = triageNoteDraft(savedNote, note)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void run()
  }

  const run = async () => {
    const items = ENTRY_KINDS.filter((k) => values[k]?.trim()).map((kind) => ({ kind, value: Number(values[kind]) }))
    const noteChanged = withNote && noteDraft.changed
    if (noteChanged && noteDraft.tooLong) {
      setErrors((x) => ({ ...x, triageNote: `At most ${TRIAGE_NOTE_MAX} characters` }))
      return
    }
    if (noteChanged && !items.length) {
      // Only the note changed: no measurement is needed.
      saveNote.mutate(
        { note },
        {
          onSuccess: () => {
            toast('success', noteDraft.length ? `Triage note saved for ${patientName}` : `Triage note cleared for ${patientName}`)
            onClose()
          },
          onError: (err) => setErrors({ triageNote: errorMessage(err) }),
        },
      )
      return
    }
    const parsed = RecordVitalsRequest.safeParse({ items })
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const i of parsed.error.issues) {
        const idx = i.path[1]
        const item = typeof idx === 'number' ? items[idx] : undefined
        const key = item ? item.kind : '_form'
        next[key] ??= item && Number.isNaN(item.value) ? 'Enter a number' : i.message
      }
      setErrors(next)
      return
    }
    if (noteChanged) {
      try {
        await saveNote.mutateAsync({ note })
        setSavedNote(note.trim() || null)
      } catch (err) {
        setErrors({ triageNote: errorMessage(err) })
        return
      }
    }
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast('success', noteChanged ? `Vitals and triage note saved for ${patientName}` : `Vitals saved for ${patientName}`)
        onClose()
      },
      onError: (err) => {
        const issues = (err as { issues?: { path: string; message: string }[] }).issues ?? []
        setErrors(Object.fromEntries(issues.map((i) => [items[Number(i.path.split('.')[1])]?.kind ?? '_form', i.message])))
      },
    })
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Record vitals — ${patientName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="vitals-form" loading={save.isPending || saveNote.isPending}>
            Save vitals
          </Button>
        </>
      }
    >
      <form id="vitals-form" noValidate onSubmit={submit} className="space-y-4">
        <p className="text-sm text-ink-muted">
          Enter the measurements you took; leave the rest blank. Values are recorded as manual entries by you.{withNote && ' A triage note for the doctor is optional.'}
        </p>
        {errors._form && <Alert tone="error">{errors._form}</Alert>}
        {save.isError && !Object.keys(errors).length && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENTRY_KINDS.map((kind) => {
            const d = VITALS[kind]
            return (
              <TextField
                key={kind}
                label={`${d.label} (${d.unit})`}
                inputMode="decimal"
                autoComplete="off"
                value={values[kind] ?? ''}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [kind]: e.target.value }))
                  setErrors(({ [kind]: _x, ...rest }) => rest)
                }}
                error={errors[kind]}
                hint={d.reference ? `Adult reference ${d.reference[0]}–${d.reference[1]}` : undefined}
              />
            )
          })}
        </div>
        {withNote && (
          <TextAreaField
            label="Triage note"
            rows={3}
            maxLength={TRIAGE_NOTE_MAX}
            value={note}
            onChange={(e) => {
              setNote(e.target.value)
              setErrors(({ triageNote: _x, ...rest }) => rest)
            }}
            error={errors.triageNote}
            hint={`Optional, for the doctor: what you noticed at triage. ${noteDraft.length} of ${TRIAGE_NOTE_MAX} characters.${savedNote && !note.trim() ? ' Saving with this empty clears the note.' : ''}`}
          />
        )}
      </form>
    </Dialog>
  )
}
