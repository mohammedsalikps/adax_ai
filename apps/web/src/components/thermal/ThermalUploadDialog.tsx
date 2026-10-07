import { BODY_SITES, type BodySite, CaptureProtocol, THERMAL_VIEWS, type ThermalCapture } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, errorMessage, issuesToErrors } from '../../lib/api.ts'
import { usePortalBase } from '../../lib/clinical.ts'
import { cacheThermalCapture, type ThermalUploadInput, uploadDemoThermalImage, uploadThermal } from '../../lib/thermal.ts'
import { simpleUploadProtocol } from '../../lib/thermalStudy.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { SelectField, TextAreaField, TextField } from '../ui/Form.tsx'

const num = (s: string) => (s.trim() === '' ? null : Number(s))
/** The server's words, plainly. A file without radiometric data is refused as NON-RADIOMETRIC, and nothing of it is stored. */
function refusal(e: unknown): string {
  const message = errorMessage(e)
  if (!(e instanceof ApiError) || e.code !== 'not_radiometric') return message
  return `${message.startsWith('NON-RADIOMETRIC') ? message : `NON-RADIOMETRIC: ${message}`} Nothing was stored.`
}

/** The refusals of an ordinary picture (no FLIR radiometric data; a PNG is not a FLIR file): the demo path is offered instead of an error. */
const ORDINARY_IMAGE = new Set(['not_radiometric', 'invalid_image'])
const isPicture = (f: File | null) => f?.type === 'image/png' || f?.type === 'image/jpeg'

/** Final demo polish: an ordinary PNG/JPEG is not a dead end. Where the deployment allows the simulator it is analysed as a DEMO (values simulated from its colours), said plainly. */
function DemoImageNotice() {
  return (
    <div role="status" className="flex gap-3 rounded-xl border border-brand/20 bg-brand-soft px-4 py-3 text-sm" data-testid="thermal-demo-notice">
      <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
      <div>
        <p className="font-semibold text-ink">Demo image detected</p>
        <p className="mt-0.5 text-ink-muted">Temperature metadata is unavailable. Continuing with simulated thermal analysis.</p>
      </div>
    </div>
  )
}

/**
 * Upload a FLIR radiometric JPEG with the conditions it was taken under. `source`: `file_upload` (the thermal pages; labelled UPLOADED) or
 * `gallery_import` (an earlier file chosen from the device in the consultation; labelled IMPORTED). After the upload the capture is shown on
 * its page, unless `onUploaded` takes it (the consultation keeps the doctor where they are). `variant="simple"` (the doctor's dialog, DESIGN
 * §5.7) asks only for the file, the body region from the fixed list and an optional note; `full` (default; the nurse's) asks for the capture
 * conditions as well. When `encounterId` is given the image belongs to that consultation, and the dialog says so.
 */
export function ThermalUploadDialog({
  patientId,
  encounterId,
  source = 'file_upload',
  onUploaded,
  onClose,
  variant = 'full',
  context,
}: {
  patientId: string
  encounterId?: string | undefined
  source?: 'gallery_import' | 'file_upload'
  onUploaded?: ((c: ThermalCapture) => void) | undefined
  onClose: () => void
  variant?: 'full' | 'simple'
  /** One line saying whose image this is and where it goes (the simple dialog), e.g. "For Anaya Demo (MRN …), your consultation in progress." */
  context?: string | undefined
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const base = usePortalBase()
  const importing = source === 'gallery_import'
  const simple = variant === 'simple'
  const [file, setFile] = useState<File | null>(null)
  const [v, setV] = useState({ bodyRegion: '', bodySite: '', view: 'anterior', roomTempC: '', acclimatisationMin: '', distanceM: '', notes: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const stored = (c: ThermalCapture) => {
    cacheThermalCapture(qc, c)
    onClose()
    if (onUploaded) onUploaded(c)
    else navigate(`${base}/thermal/${c.id}`)
  }
  const upload = useMutation({
    mutationFn: (input: ThermalUploadInput) => uploadThermal(patientId, input),
    onSuccess: stored,
    onError: (e) => setErrors(Object.fromEntries(Object.entries(issuesToErrors(e)).map(([k, m]) => [k.replace(/^protocol\./, ''), m]))),
  })
  // PATH B: the real extraction refused an ordinary picture: the same file and details go to the demo analysis when the doctor continues.
  const [demoInput, setDemoInput] = useState<ThermalUploadInput | null>(null)
  const demo = useMutation({ mutationFn: (input: ThermalUploadInput) => uploadDemoThermalImage(patientId, input), onSuccess: stored })
  const offerDemo = demoInput !== null && upload.isError && upload.error instanceof ApiError && ORDINARY_IMAGE.has(upload.error.code)
  // A new file is a new attempt: the demo offer was for the file it was made for.
  const pick = (f: File | null) => {
    setFile(f)
    setDemoInput(null)
    upload.reset()
    demo.reset()
  }
  const submit = () => {
    const protocol = simple
      ? simpleUploadProtocol(v)
      : { bodyRegion: v.bodyRegion, ...(v.bodySite ? { bodySite: v.bodySite as BodySite } : {}), view: v.view, roomTempC: num(v.roomTempC), acclimatisationMin: num(v.acclimatisationMin), distanceM: num(v.distanceM), notes: v.notes }
    const r = CaptureProtocol.safeParse(protocol)
    const next: Record<string, string> = r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]))
    // The simple dialog names the image by its site: the site is the one required field.
    if (simple && !v.bodySite) {
      delete next.bodyRegion
      next.bodySite = 'Choose the body region'
    }
    if (!file) next.file = 'Choose the radiometric JPEG from the camera'
    setErrors(next)
    if (Object.keys(next).length || !file) return
    const input = { file, protocol: protocol as CaptureProtocol, encounterId: encounterId ?? null, captureSource: source }
    demo.reset()
    setDemoInput(isPicture(file) ? input : null)
    upload.mutate(input)
  }
  return (
    <Dialog
      open
      wide={!simple}
      onClose={onClose}
      title={importing ? 'Import a thermal image' : 'Upload thermal image'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {offerDemo ? (
            <Button loading={demo.isPending} onClick={() => demo.mutate(demoInput)} data-testid="thermal-demo-continue">
              Continue analysis
            </Button>
          ) : (
            <Button loading={upload.isPending} onClick={submit}>
              {importing ? 'Import and extract' : 'Upload and extract'}
            </Button>
          )}
        </>
      }
    >
      {simple ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            {importing ? 'An earlier radiometric JPEG from a FLIR camera, saved on this device; it is labelled IMPORTED.' : 'The original radiometric JPEG exported from a FLIR camera.'} An ordinary PNG or JPEG has no temperature data: it can be analysed as a demo, with simulated values.
          </p>
          {context && (
            <p className="text-sm" data-testid="thermal-upload-context">
              {context}
            </p>
          )}
          {offerDemo ? <DemoImageNotice /> : upload.isError && !Object.keys(errors).length && <Alert tone="error">{refusal(upload.error)}</Alert>}
          {demo.isError && <Alert tone="error">{errorMessage(demo.error)}</Alert>}
          <div className="space-y-1">
            <label htmlFor="thermal-file" className="block text-sm font-medium">
              Radiometric JPEG <span className="font-normal text-ink-muted">(or a PNG/JPEG for a demo)</span> <span className="text-down" aria-hidden="true">*</span>
            </label>
            <input id="thermal-file" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" aria-invalid={!!errors.file} aria-describedby={errors.file ? 'thermal-file-err' : undefined} onChange={(e) => pick(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
            {errors.file && (
              <p id="thermal-file-err" className="text-xs font-medium text-down">
                {errors.file}
              </p>
            )}
          </div>
          <SelectField label="Body region" required value={v.bodySite} onChange={(e) => setV({ ...v, bodySite: e.target.value })} error={errors.bodySite ?? errors.bodyRegion} hint="A label for the image: nothing is inferred from it.">
            <option value="">Choose the region…</option>
            {Object.entries(BODY_SITES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </SelectField>
          <TextAreaField label="Note (optional)" rows={2} maxLength={500} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} error={errors.notes} placeholder="Right knee, anterior; room 22 °C" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <p className="text-sm text-ink-muted sm:col-span-2">
            {importing
              ? 'Choose an earlier radiometric JPEG from a FLIR camera, saved on this device. It is checked for temperature data like any upload, and is stored and shown labelled IMPORTED. Screenshots and ordinary images have no temperature data: they can be analysed as a demo, with simulated values.'
              : 'Upload the original radiometric JPEG exported from a FLIR camera. Screenshots and ordinary images have no temperature data: they can be analysed as a demo, with simulated values.'}
          </p>
          {offerDemo ? (
            <div className="sm:col-span-2">
              <DemoImageNotice />
            </div>
          ) : (
            upload.isError && !Object.keys(errors).length && <Alert tone="error" className="sm:col-span-2">{refusal(upload.error)}</Alert>
          )}
          {demo.isError && <Alert tone="error" className="sm:col-span-2">{errorMessage(demo.error)}</Alert>}
          <div className="space-y-1 sm:col-span-2">
            <label htmlFor="thermal-file" className="block text-sm font-medium">
              Radiometric JPEG <span className="font-normal text-ink-muted">(or a PNG/JPEG for a demo)</span> <span className="text-down" aria-hidden="true">*</span>
            </label>
            <input id="thermal-file" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" aria-invalid={!!errors.file} aria-describedby={errors.file ? 'thermal-file-err' : undefined} onChange={(e) => pick(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
            {errors.file && (
              <p id="thermal-file-err" className="text-xs font-medium text-down">
                {errors.file}
              </p>
            )}
          </div>
          <TextField label="Body region" required value={v.bodyRegion} onChange={(e) => setV({ ...v, bodyRegion: e.target.value })} error={errors.bodyRegion} placeholder="e.g. Both knees" />
          <SelectField label="Body site" value={v.bodySite} onChange={(e) => setV({ ...v, bodySite: e.target.value })} error={errors.bodySite} hint="Optional, from a fixed list. Recorded with the image; nothing is inferred from it.">
            <option value="">Not specified</option>
            {Object.entries(BODY_SITES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField label="View" value={v.view} onChange={(e) => setV({ ...v, view: e.target.value })}>
            {THERMAL_VIEWS.map((x) => (
              <option key={x} value={x}>
                {x.replace('_', ' ')}
              </option>
            ))}
          </SelectField>
          <TextField label="Room temperature (°C)" inputMode="decimal" value={v.roomTempC} onChange={(e) => setV({ ...v, roomTempC: e.target.value })} error={errors.roomTempC} />
          <TextField label="Acclimatisation (minutes)" inputMode="numeric" value={v.acclimatisationMin} onChange={(e) => setV({ ...v, acclimatisationMin: e.target.value })} error={errors.acclimatisationMin} hint="Time the skin was exposed to room air before capture." />
          <TextField label="Camera distance (m)" inputMode="decimal" value={v.distanceM} onChange={(e) => setV({ ...v, distanceM: e.target.value })} error={errors.distanceM} />
          <TextAreaField label="Notes" rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} className="sm:col-span-2" />
        </div>
      )}
    </Dialog>
  )
}
