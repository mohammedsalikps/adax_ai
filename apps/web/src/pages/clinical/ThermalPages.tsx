import type { PatientDetail, ThermalCapture } from '@adaxai/contracts'
import { Upload } from 'lucide-react'
import { type DialogHTMLAttributes, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { Sheet } from '../../components/hero/Sheet.tsx'
import { PatientBanner } from '../../components/clinical/PatientBanner.tsx'
import { useDiscardRegions } from '../../components/thermal/DiscardRegions.tsx'
import { ThermalSourceBadge } from '../../components/thermal/ThermalSourceBadge.tsx'
import { ThermalStudy } from '../../components/thermal/ThermalStudy.tsx'
import { ThermalUploadDialog } from '../../components/thermal/ThermalUploadDialog.tsx'
import { ThermalViewer } from '../../components/thermal/ThermalViewer.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Alert, Badge, Spinner } from '../../components/ui/Feedback.tsx'
import { Card, PageHeader } from '../../components/ui/Layout.tsx'
import { errorMessage } from '../../lib/api.ts'
import { useMe } from '../../lib/auth.tsx'
import { usePatient, usePortalBase } from '../../lib/clinical.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { fmtC, usePatientThermal, useThermal } from '../../lib/thermal.ts'
import { CONTAIN_DIALOG_EVENTS, captureStatusSpec, thermalConsent, thermalSearch } from '../../lib/thermalStudy.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

const statusBadge = (s: ThermalCapture['status']) => {
  const spec = captureStatusSpec(s)
  return <Badge tone={spec.tone}>{spec.label}</Badge>
}

/**
 * Thermal images on the patient profile (the nurse's profile, the doctor's patient page, the consultation's profile drawer). The doctor
 * uploads with the simplified dialog (file, body region, optional note); the nurse with the capture conditions as well.
 *
 * `encounterId`: the consultation it is shown in, which must be the doctor's own and in progress (the consultation's drawer): an upload goes
 * into that consultation (so it appears in the consultation's thermal context), and an image opens in place over it, as a thermal study in a
 * side sheet, instead of leaving it. `onUploaded` / `onOpen` let the screen around take an uploaded or chosen image itself instead. Without
 * any of them, an image opens on its own page and an upload goes there, as before. Regions drawn in the side sheet but not saved are asked
 * about ("Discard the unsaved regions?") before Escape, its close button, another image or an upload discards them, as on the Thermal page and
 * in the consultation's thermal workspace.
 */
export function PatientThermalCard({
  patient,
  encounterId,
  onUploaded,
  onOpen,
}: {
  patient: PatientDetail
  encounterId?: string | undefined
  onUploaded?: ((c: ThermalCapture) => void) | undefined
  onOpen?: ((c: ThermalCapture) => void) | undefined
}) {
  const base = usePortalBase()
  const { data: me } = useMe()
  const q = usePatientThermal(patient.id)
  const [uploading, setUploading] = useState(false)
  const [study, setStudy] = useState<string | null>(null)
  const { guard, onDirtyChange, isDirty, dialog: discardQuestion } = useDiscardRegions()
  const sheetWrap = useRef<HTMLDivElement>(null)
  // The same rule as the server (an ongoing grant, or one for this consultation, with the current wording).
  const consent = thermalConsent(patient.consents, encounterId)
  const inPlace = !!encounterId || !!onOpen
  const open = (c: ThermalCapture) => (onOpen ? onOpen(c) : guard(() => setStudy(c.id)))
  const closeStudy = () => guard(() => setStudy(null))
  // The browser can close the sheet without asking (Chromium lets a repeated Escape through); while regions are unsaved it is shown again, and
  // the sheet's own close handler (closeStudy) has asked, as the consultation's thermal workspace does. Only the sheet's own dialog: the study's
  // dialogs keep their events to themselves.
  const keepSheetOpen: Pick<DialogHTMLAttributes<HTMLDialogElement>, 'onClose'> = {
    onClose: (e) => {
      const d = e.target
      if (d instanceof HTMLDialogElement && d.parentElement === sheetWrap.current && !d.open && isDirty()) d.showModal()
    },
  }
  const studied = study ? q.data?.find((c) => c.id === study) : undefined
  return (
    <Card title="Thermal images" actions={<Button size="sm" variant="secondary" icon={<Upload aria-hidden="true" className="size-4" />} disabled={!consent.granted} onClick={() => guard(() => setUploading(true))}>Upload</Button>}>
      {!consent.granted && <Alert tone="info" className="mb-3">{consent.state === 'not_recorded' ? 'Record the patient’s consent to thermal imaging before uploading.' : consent.reason}</Alert>}
      {q.isPending && <Spinner />}
      {q.data && !q.data.length && <p className="text-sm text-ink-muted">No thermal images.</p>}
      <ul className="space-y-2">
        {q.data?.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            {inPlace ? (
              <button type="button" onClick={() => open(c)} className="min-h-control-sm text-left font-medium text-brand-strong underline underline-offset-2" data-testid="patient-thermal-open">
                {c.protocol.bodyRegion} · {fmtDateTime(c.createdAt)}
              </button>
            ) : (
              <Link to={`${base}/thermal/${c.id}`} className="font-medium text-brand-strong underline underline-offset-2">
                {c.protocol.bodyRegion} · {fmtDateTime(c.createdAt)}
              </Link>
            )}
            <span className="flex items-center gap-2 text-ink-muted tabular-nums">
              {fmtC(c.minC)}–{fmtC(c.maxC)} · {c.rois.length} region{c.rois.length === 1 ? '' : 's'} <ThermalSourceBadge capture={c} /> {statusBadge(c.status)}
            </span>
          </li>
        ))}
      </ul>
      {/*
        React passes a dialog's cancel and close events up its component tree: this card's dialogs may sit inside another dialog (the
        consultation's profile drawer), and Escape in them must close them only, not the drawer around them too.
      */}
      <div className="contents" {...CONTAIN_DIALOG_EVENTS}>
        {uploading && (
          <ThermalUploadDialog
            patientId={patient.id}
            encounterId={encounterId}
            variant={me?.role === 'doctor' ? 'simple' : 'full'}
            context={me?.role === 'doctor' ? `For ${patient.fullName} (MRN ${patient.mrn}), ${encounterId ? 'this consultation' : 'the patient’s record'}.` : undefined}
            onClose={() => setUploading(false)}
            onUploaded={onUploaded ?? (inPlace ? open : undefined)}
          />
        )}
        <div ref={sheetWrap} className="contents" {...keepSheetOpen}>
          <Sheet open={!!study} onClose={closeStudy} title={studied ? `Thermal image · ${studied.protocol.bodyRegion}` : 'Thermal image'} subtitle={`${patient.fullName} · MRN ${patient.mrn}`} width="wide" testId="patient-thermal-study">
            {study && <ThermalStudy key={study} captureId={study} level={3} onDirtyChange={onDirtyChange} />}
          </Sheet>
        </div>
        {/* Outside the sheet, so it is seen even while the browser has the sheet closed for a moment. */}
        {discardQuestion}
      </div>
    </Card>
  )
}

/**
 * One thermal image on its own page. The nurse's: the full viewer. The doctor's link (`/doctor/thermal/:captureId`, kept) opens the same study
 * on the Thermal page, in place, with its patient chosen: one place for a doctor's thermal images.
 */
export function ThermalDetailPage() {
  const { captureId } = useParams()
  const { data: me } = useMe()
  if (me?.role === 'doctor' && captureId) return <Navigate replace to={`/doctor/thermal${thermalSearch({ patientId: null, captureId })}`} />
  return <NurseThermalDetail captureId={captureId} />
}

function NurseThermalDetail({ captureId }: { captureId: string | undefined }) {
  const base = usePortalBase()
  const q = useThermal(captureId)
  const patient = usePatient(q.data?.patientId)
  useDocumentTitle('Thermal image')
  if (q.isPending) return <Spinner />
  if (q.isError) return <Alert tone="error">{errorMessage(q.error)}</Alert>
  const c: ThermalCapture = q.data
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link to={`${base}/patients/${c.patientId}`} className="text-brand-strong underline underline-offset-2">
          Patient record
        </Link>{' '}
        / <span className="text-ink-muted">Thermal image</span>
      </nav>
      {patient.data && <PatientBanner patient={{ ...patient.data, activeAllergies: patient.data.allergies.filter((a) => a.status === 'active').map((a) => a.substance) }} />}
      <PageHeader title={`Thermal image · ${c.protocol.bodyRegion}`} description={fmtDateTime(c.createdAt)} />
      <ThermalViewer key={c.id} capture={c} />
    </>
  )
}
