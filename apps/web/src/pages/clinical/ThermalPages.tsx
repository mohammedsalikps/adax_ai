import type { PatientDetail, ThermalCapture, ThermalCaptureSource } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { PatientBanner } from '../../components/clinical/PatientBanner.tsx'
import { ThermalSourceBadge } from '../../components/thermal/ThermalSourceBadge.tsx'
import { ThermalUploadDialog } from '../../components/thermal/ThermalUploadDialog.tsx'
import { ThermalViewer } from '../../components/thermal/ThermalViewer.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Alert, Badge, EmptyState, Spinner } from '../../components/ui/Feedback.tsx'
import { Card, PageHeader } from '../../components/ui/Layout.tsx'
import { Table } from '../../components/ui/Table.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { usePatient, usePortalBase } from '../../lib/clinical.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { fmtC, usePatientThermal, useThermal } from '../../lib/thermal.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

const statusBadge = (s: string) => (s === 'approved' ? <Badge tone="ok">Approved</Badge> : s === 'rejected' ? <Badge>Rejected</Badge> : <Badge tone="warn">Awaiting review</Badge>)

/** Thermal images on the patient profile. */
export function PatientThermalCard({ patient }: { patient: PatientDetail }) {
  const base = usePortalBase()
  const q = usePatientThermal(patient.id)
  const [uploading, setUploading] = useState(false)
  const consented = patient.consents.some((c) => c.type === 'thermal_imaging' && c.status === 'granted')
  return (
    <Card title="Thermal images" actions={<Button size="sm" variant="secondary" icon={<Upload aria-hidden="true" className="size-4" />} disabled={!consented} onClick={() => setUploading(true)}>Upload</Button>}>
      {!consented && <Alert tone="info" className="mb-3">Record the patient’s consent to thermal imaging before uploading.</Alert>}
      {q.isPending && <Spinner />}
      {q.data && !q.data.length && <p className="text-sm text-ink-muted">No thermal images.</p>}
      <ul className="space-y-2">
        {q.data?.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Link to={`${base}/thermal/${c.id}`} className="font-medium text-brand-strong underline underline-offset-2">
              {c.protocol.bodyRegion} · {fmtDateTime(c.createdAt)}
            </Link>
            <span className="flex items-center gap-2 text-ink-muted tabular-nums">
              {fmtC(c.minC)}–{fmtC(c.maxC)} · {c.rois.length} region{c.rois.length === 1 ? '' : 's'} <ThermalSourceBadge capture={c} /> {statusBadge(c.status)}
            </span>
          </li>
        ))}
      </ul>
      {uploading && <ThermalUploadDialog patientId={patient.id} onClose={() => setUploading(false)} />}
    </Card>
  )
}

export function ThermalDetailPage() {
  const { captureId } = useParams()
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

interface ThermalListItem {
  id: string
  patientId: string
  patientName: string
  mrn: string
  status: string
  bodyRegion: string
  createdAt: string
  /** V6: where the image came from (a row without them shows no source rather than a guess). */
  captureSource?: ThermalCaptureSource
  simulated?: boolean
}

export function ThermalListPage() {
  useDocumentTitle('Thermal')
  const base = usePortalBase()
  const [status, setStatus] = useState<'draft' | ''>('draft')
  const q = useQuery({ queryKey: ['thermal', 'list', status], queryFn: () => api<{ captures: ThermalListItem[] }>('/thermal', { query: { status: status || undefined } }), select: (d) => d.captures })
  return (
    <>
      <PageHeader title="Thermal images" description="Upload from a patient’s record. Measurements only — not a diagnosis, not clinically validated." />
      <div role="group" aria-label="Filter" className="mb-4 inline-flex rounded-md border border-line bg-surface p-0.5">
        {(['draft', ''] as const).map((s) => (
          <button key={s || 'all'} type="button" aria-pressed={status === s} onClick={() => setStatus(s)} className={`rounded px-3 py-1.5 text-sm font-medium ${status === s ? 'bg-brand-soft text-brand-strong' : 'text-ink-muted hover:text-ink'}`}>
            {s === 'draft' ? 'Awaiting review' : 'All recent'}
          </button>
        ))}
      </div>
      <Card bodyClassName="">
        {q.isPending && <div className="px-5"><Spinner /></div>}
        {q.isError && <Alert tone="error" className="m-5">{errorMessage(q.error)}</Alert>}
        {q.data && (
          <Table
            caption="Thermal images"
            rows={q.data}
            rowKey={(r) => r.id}
            empty={<div className="p-5"><EmptyState title="Nothing here">No thermal images {status === 'draft' ? 'are awaiting review' : 'yet'}.</EmptyState></div>}
            columns={[
              { key: 'p', header: 'Patient', cell: (r) => <><p className="font-medium">{r.patientName}</p><p className="text-xs text-ink-muted">{r.mrn}</p></> },
              { key: 'r', header: 'Region', cell: (r) => <Link to={`${base}/thermal/${r.id}`} className="font-medium text-brand-strong underline underline-offset-2">{r.bodyRegion}</Link> },
              { key: 'src', header: 'Source', cell: (r) => <ThermalSourceBadge capture={r} /> },
              { key: 's', header: 'Status', cell: (r) => statusBadge(r.status) },
              { key: 'd', header: 'Uploaded', cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
            ]}
          />
        )}
      </Card>
    </>
  )
}
