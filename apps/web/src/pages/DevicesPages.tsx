import { DEVICE_INTEGRATIONS, DEVICE_KINDS, DEVICE_READING_KINDS, type Device, type DeviceInput, type DeviceIntegration, type DeviceKind, type PatientSummary, usesGateway, VITALS } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Link2, Plus, Unlink } from 'lucide-react'
import { useState } from 'react'
import { SimulatedBadge } from '../components/clinical/DeviceReadingsCard.tsx'
import { Button } from '../components/ui/Button.tsx'
import { Dialog } from '../components/ui/Dialog.tsx'
import { Alert, Badge, EmptyState, Spinner } from '../components/ui/Feedback.tsx'
import { SelectField, TextAreaField, TextField } from '../components/ui/Form.tsx'
import { Card, PageHeader } from '../components/ui/Layout.tsx'
import { Table } from '../components/ui/Table.tsx'
import { useToast } from '../components/ui/Toast.tsx'
import { api, errorMessage, issuesToErrors } from '../lib/api.ts'
import { devicesKey, useDevices } from '../lib/devices.ts'
import { fmtDateTime } from '../lib/format.ts'
import { useDocumentTitle } from '../lib/useDocumentTitle.ts'

function HardwareNotice() {
  return (
    <Alert tone="warning" title="No device has been connected or tested in this build" className="mb-6">
      This page manages the integration boundary: a device registry, assignment to patients, a token-authenticated API for a gateway, and stethoscope recordings. Readings that arrive through the gateway are stored as <em>device, unverified</em>; blood pressure is not accepted from any device. A record registered as a <strong>simulator</strong> is a program that generates values for development and tests: what it sends is stored and shown as <em>simulated</em> and is never a measurement. See docs/DEVICES.md for what physical device access is required.
    </Alert>
  )
}

/** What a device of this kind may send through the gateway: the gate (the same list the server enforces). */
const allowedKinds = (kind: DeviceKind) => DEVICE_READING_KINDS[kind].map((k) => VITALS[k].label.toLowerCase()).join(', ')

function RegisterDialog({ onClose, simulatorAllowed }: { onClose: () => void; simulatorAllowed: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState<DeviceInput>({ kind: 'wearable_band', label: '', serialNumber: '', integration: 'not_integrated', manufacturer: '', model: '', notes: '' })
  const save = useMutation({
    mutationFn: () => api<Device>('/admin/devices', { method: 'POST', body: { ...v, manufacturer: v.manufacturer || undefined, model: v.model || undefined, notes: v.notes || undefined } }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: devicesKey }), toast('success', 'Device registered'), onClose()),
  })
  const errors = save.isError ? issuesToErrors(save.error) : {}
  return (
    <Dialog
      open
      onClose={onClose}
      title="Register a device"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Register
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {save.isError && !Object.keys(errors).length && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <SelectField label="Type" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as DeviceKind })}>
          {Object.entries(DEVICE_KINDS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </SelectField>
        <TextField label="Name" required value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} error={errors.label} hint="How staff will recognise it, e.g. “Band 3, ward A”." />
        <TextField label="Serial number" required value={v.serialNumber} onChange={(e) => setV({ ...v, serialNumber: e.target.value })} error={errors.serialNumber} />
        <TextField label="Manufacturer (optional)" value={v.manufacturer ?? ''} onChange={(e) => setV({ ...v, manufacturer: e.target.value })} />
        <TextField label="Model (optional)" value={v.model ?? ''} onChange={(e) => setV({ ...v, model: e.target.value })} />
        <SelectField label="Integration" value={v.integration} onChange={(e) => setV({ ...v, integration: e.target.value as DeviceIntegration })} hint="Choose “gateway” only for a device whose gateway has been built and tested. This cannot be changed to or from “simulator” later.">
          {Object.entries(DEVICE_INTEGRATIONS)
            .filter(([k]) => k !== 'simulator' || simulatorAllowed)
            .map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
        </SelectField>
        {v.integration === 'simulator' && (
          <Alert tone="warning" title="This registers a simulator, not a device">
            A simulator is a program that generates values. Everything it sends is stored and shown as simulated, is never part of a patient’s record, and is never given to the AI or shown to the patient. The record stays a simulator for good.
          </Alert>
        )}
        {usesGateway(v.integration ?? 'not_integrated') && (
          <p className="text-xs text-ink-muted">
            {DEVICE_READING_KINDS[v.kind].length ? `Through the gateway this kind of device may send: ${allowedKinds(v.kind)}. Anything else, blood pressure included, is refused.` : 'This kind of device may send no readings through the gateway.'}
            {v.kind === 'smart_stethoscope' ? ' A stethoscope’s gateway may send recordings.' : ''}
          </p>
        )}
        <TextAreaField label="Notes (optional)" rows={2} value={v.notes ?? ''} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </div>
    </Dialog>
  )
}

/** Administrator: device registry, retirement and gateway tokens. */
export function AdminDevicesPage() {
  useDocumentTitle('Devices')
  const qc = useQueryClient()
  const list = useDevices()
  const q = { ...list, data: list.data?.devices }
  const [registering, setRegistering] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: devicesKey })
  const retire = useMutation({ mutationFn: (id: string) => api(`/admin/devices/${id}`, { method: 'PATCH', body: { status: 'retired' } }), onSuccess: refresh })
  const issue = useMutation({ mutationFn: (id: string) => api<{ token: string }>(`/admin/devices/${id}/token`, { method: 'POST' }), onSuccess: (d) => (setToken(d.token), refresh()) })
  const error = retire.error ?? issue.error
  return (
    <>
      <PageHeader
        title="Devices"
        actions={
          <Button icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setRegistering(true)}>
            Register device
          </Button>
        }
      />
      <HardwareNotice />
      {error && <Alert tone="error" className="mb-4">{errorMessage(error)}</Alert>}
      {token && (
        <Alert tone="info" title="Gateway token (shown once)" className="mb-4">
          <code className="block break-all">{token}</code>
          Copy it into the gateway configuration now. It cannot be shown again; issue a new one if it is lost.
        </Alert>
      )}
      <Card bodyClassName="">
        {q.isPending && <div className="p-5"><Spinner /></div>}
        {q.data && (
          <Table
            caption="Registered devices"
            rows={q.data}
            rowKey={(d) => d.id}
            empty={<div className="p-5"><EmptyState title="No devices registered" /></div>}
            columns={[
              { key: 'n', header: 'Device', cell: (d) => <><p className="flex flex-wrap items-center gap-2 font-medium">{d.label}{d.simulated && <SimulatedBadge what="SIMULATOR" />}</p><p className="text-xs text-ink-muted">{DEVICE_KINDS[d.kind]} · {[d.manufacturer, d.model].filter(Boolean).join(' ') || 'make not recorded'} · SN {d.serialNumber}</p></> },
              { key: 'i', header: 'Integration', cell: (d) => <span className="text-sm">{DEVICE_INTEGRATIONS[d.integration]}{d.hasToken ? <span className="block text-xs text-ink-muted">token issued {fmtDateTime(d.tokenCreatedAt)}</span> : null}{usesGateway(d.integration) ? <span className="block text-xs text-ink-muted">{d.lastSeenAt ? `last contact ${fmtDateTime(d.lastSeenAt)}` : 'no contact yet'}</span> : null}</span> },
              { key: 's', header: 'Status', cell: (d) => (d.status === 'active' ? <Badge tone="ok">Active</Badge> : <Badge>Retired</Badge>) },
              // Administrators manage devices, not patient records: they see that a device is in use, not by whom.
              { key: 'a', header: 'In use', cell: (d) => (d.assignment ? (d.assignment.patientName ? `${d.assignment.patientName} (${d.assignment.mrn})` : `Assigned to a patient since ${fmtDateTime(d.assignment.assignedAt)}`) : '—') },
              {
                key: 'x',
                header: <span className="sr-only">Actions</span>,
                cell: (d) =>
                  d.status === 'active' && (
                    <div className="flex flex-wrap gap-2">
                      {usesGateway(d.integration) && (
                        <Button size="sm" variant="secondary" icon={<KeyRound aria-hidden="true" className="size-4" />} loading={issue.isPending && issue.variables === d.id} onClick={() => issue.mutate(d.id)}>
                          {d.hasToken ? 'Replace token' : 'Issue token'}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" loading={retire.isPending && retire.variables === d.id} onClick={() => retire.mutate(d.id)}>
                        Retire
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        )}
      </Card>
      {registering && <RegisterDialog simulatorAllowed={!!list.data?.simulatorAllowed} onClose={() => setRegistering(false)} />}
    </>
  )
}

function AssignDialog({ device, onClose }: { device: Device; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [patientId, setPatientId] = useState('')
  const [until, setUntil] = useState('')
  const search = useQuery({ queryKey: ['patients', 'search', query], queryFn: () => api<{ patients: PatientSummary[] }>('/patients', { query: { q: query } }), enabled: query.trim().length >= 2, select: (d) => d.patients })
  const assign = useMutation({
    mutationFn: () => api<Device>(`/devices/${device.id}/assignments`, { method: 'POST', body: { patientId, ...(until && { validUntil: new Date(until).toISOString() }) } }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: devicesKey }), toast('success', 'Device assigned'), onClose()),
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Assign ${device.label}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!patientId} loading={assign.isPending} onClick={() => assign.mutate()}>
            Assign
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-muted">The patient must have consented to device readings. Readings are stored only while the device is assigned. If the patient has an open visit today, the readings are filed under it.</p>
        {device.simulated && <Alert tone="warning">This is a simulator, not a device: what it sends is generated, is shown as SIMULATED, and never becomes part of the patient’s record.</Alert>}
        {assign.isError && <Alert tone="error">{errorMessage(assign.error)}</Alert>}
        <TextField label="Find patient (name, MRN or phone)" value={query} onChange={(e) => setQuery(e.target.value)} />
        {search.data && (
          <SelectField label="Patient" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">Choose…</option>
            {search.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} · {p.mrn}
              </option>
            ))}
          </SelectField>
        )}
        <TextField label="Assigned until (optional)" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} hint="Readings measured after this time are refused. Leave empty to keep it assigned until someone ends it." />
      </div>
    </Dialog>
  )
}

/** Nurses and doctors: assign registered devices to patients and end assignments. */
export function StaffDevicesPage() {
  useDocumentTitle('Devices')
  const qc = useQueryClient()
  const toast = useToast()
  const list = useDevices()
  const q = { ...list, data: list.data?.devices }
  const [assigning, setAssigning] = useState<Device | null>(null)
  const end = useMutation({
    mutationFn: (assignmentId: string) => api(`/device-assignments/${assignmentId}/end`, { method: 'POST', body: { reason: 'Ended by staff' } }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: devicesKey }), toast('success', 'Assignment ended')),
  })
  const active = q.data?.filter((d) => d.status === 'active') ?? []
  return (
    <>
      <PageHeader title="Devices" description="Assign registered devices to patients. Administrators register devices." />
      <HardwareNotice />
      {end.isError && <Alert tone="error" className="mb-4">{errorMessage(end.error)}</Alert>}
      {q.isPending && <Spinner />}
      {q.data && !active.length && <EmptyState title="No devices registered">Ask an administrator to register devices.</EmptyState>}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {active.map((d) => (
          <li key={d.id}>
            <Card>
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {d.label}
                {d.simulated && <SimulatedBadge what="SIMULATOR" />}
              </p>
              <p className="text-xs text-ink-muted">
                {DEVICE_KINDS[d.kind]} · {DEVICE_INTEGRATIONS[d.integration]}
                {usesGateway(d.integration) ? ` · ${d.lastSeenAt ? `last contact ${fmtDateTime(d.lastSeenAt)}` : 'no contact yet'}` : ''}
              </p>
              {d.assignment ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    Assigned to <strong>{d.assignment.patientName}</strong> ({d.assignment.mrn}) since {fmtDateTime(d.assignment.assignedAt)}
                    {d.assignment.validUntil ? `, until ${fmtDateTime(d.assignment.validUntil)}` : ''}
                  </span>
                  <Button size="sm" variant="secondary" icon={<Unlink aria-hidden="true" className="size-4" />} loading={end.isPending && end.variables === d.assignment.id} onClick={() => end.mutate(d.assignment!.id)}>
                    End assignment
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="secondary" className="mt-2" icon={<Link2 aria-hidden="true" className="size-4" />} onClick={() => setAssigning(d)}>
                  Assign to patient
                </Button>
              )}
            </Card>
          </li>
        ))}
      </ul>
      {assigning && <AssignDialog device={assigning} onClose={() => setAssigning(null)} />}
    </>
  )
}
