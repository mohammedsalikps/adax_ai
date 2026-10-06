import type { ThermalCapture, ThermalWorkspaceEventRequest } from '@adaxai/contracts'
import { Camera, Upload, UserRound, X } from 'lucide-react'
import { type MouseEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { KeyValue, KeyValueList } from '../../components/hero/KeyValue.tsx'
import { PageTitle } from '../../components/hero/PageTitle.tsx'
import { Panel, SECTION_LABEL } from '../../components/hero/Panel.tsx'
import { ageSex } from '../../components/clinical/PatientBanner.tsx'
import { RecentThermalImages, type ThermalListItem } from '../../components/thermal/RecentThermalImages.tsx'
import { useDiscardRegions } from '../../components/thermal/DiscardRegions.tsx'
import { ThermalPatientPicker } from '../../components/thermal/ThermalPatientPicker.tsx'
import { ThermalStudy } from '../../components/thermal/ThermalStudy.tsx'
import { ThermalUploadDialog } from '../../components/thermal/ThermalUploadDialog.tsx'
import { CameraPane } from '../../components/thermal/ThermalWorkspace.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Badge, ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { PatientAvatar } from '../../components/ui/PatientAvatar.tsx'
import { usePatient } from '../../lib/clinical.ts'
import { useDevices } from '../../lib/devices.ts'
import { useMyConsultations } from '../../lib/encounters.ts'
import { fmtDate, fmtTime } from '../../lib/format.ts'
import { sendThermalEvent, useThermal } from '../../lib/thermal.ts'
import { findNativeBridge } from '../../lib/thermalCamera.ts'
import {
  type ActionState,
  cameraOffer,
  CAPTURE_NEEDS_CONSULTATION,
  choosePatient,
  clearPatient,
  closeStudy,
  effectivePatientId,
  openConsultationFor,
  openStudy,
  readThermalParams,
  studyArea,
  type ThermalConsent,
  thermalAcquisition,
  thermalConsent,
  type ThermalPageParams,
  thermalSearch,
} from '../../lib/thermalStudy.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

const CONSENT_TONE: Record<ThermalConsent['state'], 'ok' | 'warn' | 'neutral'> = { granted: 'ok', outdated: 'warn', withdrawn: 'neutral', not_recorded: 'neutral' }

/** Why an action is not possible, or what it will do. "My consultations" is a link in the one sentence that names it. */
function ActionNote({ id, state, hint }: { id: string; state: ActionState; hint: ReactNode }) {
  if (state.block === 'no_consultation') {
    const [before] = CAPTURE_NEEDS_CONSULTATION.split('My consultations')
    return (
      <p id={id} className="text-sm text-ink-muted" data-testid="thermal-capture-reason">
        {before}
        <Link to="/doctor/queue" className="font-medium text-brand-strong underline underline-offset-2">
          My consultations
        </Link>
      </p>
    )
  }
  return (
    <p id={id} className="text-sm text-ink-muted">
      {state.reason ?? hint}
    </p>
  )
}

/**
 * The camera on the Thermal page, in place: the same camera pane as the consultation's thermal workspace (FLIR ONE through the tablet app's
 * bridge; "FLIR ONE not connected" in a browser; the labelled simulator only where the deployment allows one). A capture goes into the doctor's
 * consultation of this patient in progress, the only place the API takes one. Opening it is recorded for that consultation (audit), as the
 * workspace's opening is.
 */
function CameraPanel({ patient, encounterId, bridgePresent, guard, onBusyChange, onCaptured, onClose, busy }: {
  patient: { id: string; fullName: string; mrn: string }
  encounterId: string
  bridgePresent: boolean
  guard: (go: () => void) => void
  onBusyChange: (busy: boolean) => void
  onCaptured: (c: ThermalCapture) => void
  onClose: () => void
  busy: boolean
}) {
  const bridge = useMemo(() => findNativeBridge(), [])
  const event = useCallback((e: ThermalWorkspaceEventRequest) => void sendThermalEvent(encounterId, e), [encounterId])
  useEffect(() => {
    event({ event: 'workspace_opened', adapter: 'native_bridge', state: bridgePresent ? 'bridge_present' : 'no_bridge' })
  }, [event, bridgePresent])
  const headingId = useId()
  // The camera pane's own surfaces (status, preview, capture) are the panels here: no frame around them, only the section label.
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3" data-testid="thermal-camera">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className={`flex items-center gap-2 ${SECTION_LABEL}`}>
          <Camera aria-hidden="true" className="size-4 text-ink-muted" />
          Camera
        </h2>
        <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} onClick={onClose} disabled={busy}>
          Close camera
        </Button>
      </div>
      <CameraPane patient={patient} encounterId={encounterId} where="your consultation in progress" bridge={bridge} event={event} guard={guard} onBusyChange={onBusyChange} onCaptured={onCaptured} />
    </section>
  )
}

/**
 * The doctor's Thermal page (`/doctor/thermal`; DESIGN §5.7, spec §13/§14): the patient (search, or one of today's patients; `?patientId=`
 * preselects) with their thermal-imaging consent and the doctor's consultation of them in progress; then [Upload thermal image] and [Capture
 * thermal image]. Upload stores the radiometric file for the patient, and in that consultation when there is one. Capture goes only into that
 * consultation (the API's rule): without one it says how to start it. After either, the thermal study opens in place (`?capture=`). Below:
 * "Recent thermal images" (the facility's images awaiting review, or all recent), each opening in place. Nothing here diagnoses, scores or
 * claims a camera that is not there.
 */
export function ThermalPage() {
  useDocumentTitle('Thermal')
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const params = readThermalParams(search)
  const study = useThermal(params.captureId ?? undefined)
  const patientId = effectivePatientId(params, study.data?.patientId)
  const patient = usePatient(patientId ?? undefined)
  const mine = useMyConsultations('in_progress', !!patientId)
  const open = openConsultationFor(mine.data?.items ?? [], patientId, mine.data?.today)
  // Judged once the consultations are known: a consent given for that consultation only covers an image taken in it.
  const consent = patient.data && !mine.isPending ? thermalConsent(patient.data.consents, open?.encounterId) : null
  const acq = thermalAcquisition({
    patient: !patientId ? 'none' : patient.data ? 'ready' : patient.isError ? 'error' : 'loading',
    consultations: mine.data ? 'ready' : mine.isError ? 'error' : 'loading',
    consent,
    openEncounterId: open?.encounterId ?? null,
  })
  const devices = useDevices({ enabled: !!patientId })
  const bridgePresent = useMemo(() => findNativeBridge() !== null, [])
  const offer = cameraOffer({ bridge: bridgePresent, simulatorAllowed: devices.data?.simulatorAllowed })
  const [uploading, setUploading] = useState(false)
  /** The patient the camera was opened for: it shows only while that patient is the page's. */
  const [cameraFor, setCameraFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const studyRef = useRef<HTMLDivElement>(null)
  const uploadNote = useId()
  const captureNote = useId()
  /** Regions drawn on the open study but not saved: asked about before anything discards them. */
  const { guard, onDirtyChange, isDirty, dialog: discardQuestion } = useDiscardRegions()

  const go = useCallback((p: ThermalPageParams) => setSearch(thermalSearch(p)), [setSearch])
  const onBusyChange = useCallback((b: boolean) => {
    busyRef.current = b
    setBusy(b)
  }, [])
  const showStudy = useCallback((c: { id: string; patientId: string }) => go(openStudy(c)), [go])
  const choose = (id: string) => guard(() => go(choosePatient(id)))
  const change = () => {
    if (busyRef.current) return
    guard(() => {
      setCameraFor(null)
      go(clearPatient())
    })
  }

  // A study opened (after an upload, a capture or from the list) is brought into view.
  useEffect(() => {
    if (!params.captureId) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    studyRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }, [params.captureId])
  // The camera shows only for the patient it was opened for, and only while Capture is possible (a consultation signed meanwhile closes it).
  const cameraShown = !!patientId && cameraFor === patientId && acq.capture.enabled && !!open && !!patient.data
  // One note under both buttons when they are blocked for the same reason; otherwise each says its own.
  const sharedBlock = !!acq.upload.block && acq.upload.block === acq.capture.block

  const p = patient.data
  const where = open ? 'your consultation in progress' : 'the patient only (no consultation of yours is in progress)'
  const uploadHint = open ? 'A radiometric JPEG from a FLIR camera; it goes into your consultation in progress.' : 'A radiometric JPEG from a FLIR camera; it is stored with the patient.'

  // A study shown is always the chosen patient's (a link naming another patient's study does not show it beside this patient).
  const studyShown = !!params.captureId && (!study.data || study.data.patientId.toLowerCase() === patientId)
  // The camera beside the study, or the study alone: the study keeps one place (key) either way, so opening or closing the camera never mounts
  // it again and regions drawn but not saved stay.
  const area = studyArea({ camera: cameraShown, study: studyShown })

  return (
    <>
      <PageTitle title="Thermal" subtitle="Upload or capture a thermal image for a patient." />
      <div className="space-y-4">
        <Panel
          label="Patient"
          icon={UserRound}
          testId="thermal-patient"
          actions={
            patientId && (
              <Button size="sm" variant="ghost" onClick={change} disabled={busy}>
                Change patient
              </Button>
            )
          }
        >
          {!patientId && <ThermalPatientPicker onChoose={choose} />}
          {patientId && patient.isPending && <LoadingState rows={2} label="Loading the patient…" />}
          {patientId && patient.isError && !p && <ErrorState title="The patient could not be loaded" error={patient.error} onRetry={() => void patient.refetch()} retrying={patient.isFetching} />}
          {p && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <PatientAvatar name={p.fullName} />
                <div className="min-w-0">
                  <p className="font-semibold [overflow-wrap:anywhere]" data-testid="thermal-patient-name">
                    {p.fullName}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {ageSex(p)} · MRN <span className="font-mono">{p.mrn}</span>
                  </p>
                </div>
              </div>
              <KeyValueList>
                <KeyValue
                  label="Thermal consent"
                  testId="thermal-consent"
                  value={
                    consent && (
                      <Badge tone={CONSENT_TONE[consent.state]} dot>
                        {consent.label}
                      </Badge>
                    )
                  }
                  missing="Checking…"
                  hint={
                    consent &&
                    !consent.granted && (
                      <Link to={`/doctor/patients/${p.id}`} className="font-medium text-brand-strong underline underline-offset-2">
                        Open the patient’s page
                      </Link>
                    )
                  }
                />
                <KeyValue
                  label="Consultation"
                  testId="thermal-consultation"
                  value={open ? `Yours, in progress · token ${open.visit.tokenNumber} · started ${open.visit.visitDate === mine.data?.today ? fmtTime(open.startedAt) : fmtDate(open.visit.visitDate)}` : mine.data ? 'None of yours in progress' : null}
                  missing={mine.isError ? 'Could not be checked' : 'Checking…'}
                />
              </KeyValueList>
            </div>
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-2" role="group" aria-label="Add a thermal image">
          <div className="space-y-1.5">
            <Button size="lg" className="w-full" icon={<Upload aria-hidden="true" className="size-5" />} disabled={!acq.upload.enabled || busy} aria-describedby={sharedBlock ? captureNote : uploadNote} onClick={() => guard(() => setUploading(true))} data-testid="thermal-upload">
              Upload thermal image
            </Button>
            {!sharedBlock && <ActionNote id={uploadNote} state={acq.upload} hint={uploadHint} />}
          </div>
          <div className="space-y-1.5">
            <Button
              size="lg"
              variant="secondary"
              className="w-full"
              icon={<Camera aria-hidden="true" className="size-5" />}
              disabled={!acq.capture.enabled || cameraShown}
              aria-describedby={captureNote}
              onClick={() => setCameraFor(patientId)}
              data-testid="thermal-capture-open"
            >
              Capture thermal image
            </Button>
            {!sharedBlock && <ActionNote id={captureNote} state={acq.capture} hint={offer.line} />}
          </div>
          {sharedBlock && (
            <div className="sm:col-span-2">
              <ActionNote id={captureNote} state={acq.capture} hint={offer.line} />
            </div>
          )}
        </div>

        {area && (
          <div className={area.columns ? 'grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)]' : undefined} data-testid="thermal-study-area">
            {area.slots.map((slot) =>
              slot === 'camera' ? (
                p &&
                open && (
                  <CameraPanel
                    key={slot}
                    patient={p}
                    encounterId={open.encounterId}
                    bridgePresent={bridgePresent}
                    guard={guard}
                    onBusyChange={onBusyChange}
                    onCaptured={showStudy}
                    onClose={() => setCameraFor(null)}
                    busy={busy}
                  />
                )
              ) : slot === 'study' ? (
                <div key={slot} ref={studyRef} className="min-w-0 scroll-mt-4">
                  {params.captureId && <ThermalStudy key={params.captureId} captureId={params.captureId} onDirtyChange={onDirtyChange} onClose={() => guard(() => go(closeStudy({ ...params, patientId })))} />}
                </div>
              ) : (
                <Panel key={slot} label="Thermal study" as="h2">
                  <p className="text-sm text-ink-muted">No image yet. Connect the camera, choose the region and capture: the measurements appear here.</p>
                </Panel>
              ),
            )}
          </div>
        )}

        <RecentThermalImages
          href={(r: ThermalListItem) => `/doctor/thermal${thermalSearch(openStudy(r))}`}
          onOpen={(r: ThermalListItem, e: MouseEvent<HTMLAnchorElement>) => {
            // The link goes where it says, in place; unsaved regions are asked about first.
            if (!isDirty()) return
            e.preventDefault()
            guard(() => navigate(`/doctor/thermal${thermalSearch(openStudy(r))}`))
          }}
        />
      </div>

      {uploading && p && (
        <ThermalUploadDialog
          patientId={p.id}
          encounterId={acq.encounterId ?? undefined}
          variant="simple"
          context={`For ${p.fullName} (MRN ${p.mrn}), ${where}.`}
          onClose={() => setUploading(false)}
          onUploaded={(c) => {
            setUploading(false)
            showStudy(c)
          }}
        />
      )}
      {discardQuestion}
    </>
  )
}
