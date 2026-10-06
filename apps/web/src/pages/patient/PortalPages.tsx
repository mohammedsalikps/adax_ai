import {
  type PortalConsent,
  type PortalCurrentPrescriptionItem,
  type PortalCurrentPrescriptionResponse,
  type PortalHome,
  type PortalProfile,
  type PortalRecord,
  type PortalRecordSummary,
  type PortalThermalReport,
  type PortalVisit,
  type PortalVital,
  VITAL_ORDER,
  VITALS,
} from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, ChevronRight, FileText, HeartPulse, Pill, Printer } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { HeroEmpty } from '../../components/hero/HeroEmpty.tsx'
import { KeyValue, KeyValueList } from '../../components/hero/KeyValue.tsx'
import { Panel, PanelGroup } from '../../components/hero/Panel.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Dialog } from '../../components/ui/Dialog.tsx'
import { TextField } from '../../components/ui/Form.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { markPortalWithdrawn } from '../../lib/sessionEnd.ts'
import { replaceSession } from '../../lib/session.ts'
import { Alert, Badge, EmptyState, Spinner } from '../../components/ui/Feedback.tsx'
import { Card, DescriptionList, PageHeader } from '../../components/ui/Layout.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import { portalPollInterval, usePortalActive } from '../../lib/portalActivity.ts'
import { courseLine, courseTone, durationLines } from '../../lib/prescriptionCourse.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

/**
 * Portal data is never kept beyond the page session: no persistence, short cache. `live`: what changes when the doctor completes a
 * consultation (home, records, today's prescription) is read again when the patient comes back to the app and every 60 s while the patient
 * is using it (no push; the next read shows it). Nobody there for 15 minutes: no more polling, so an unattended portal's session can still
 * time out (lib/portalActivity.ts).
 */
function usePortal<T>(path: string, opts: { live?: boolean } = {}) {
  const live = !!opts.live
  const active = usePortalActive(live)
  return useQuery({
    queryKey: ['portal', path],
    queryFn: () => api<T>(`/portal${path}`),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    ...(live && { refetchInterval: portalPollInterval(active), refetchOnWindowFocus: 'always' as const }),
  })
}

function Loading<T>({ q, children }: { q: { isPending: boolean; isError: boolean; error: unknown; data?: T }; children: (d: T) => ReactNode }) {
  if (q.isPending) return <Spinner />
  if (q.isError) return <Alert tone="error">{errorMessage(q.error)}</Alert>
  return <>{children(q.data as T)}</>
}

const VISIT_STATUS: Record<string, string> = { waiting: 'Waiting', in_triage: 'With the nurse', ready: 'Waiting for the doctor', in_consultation: 'With the doctor', completed: 'Completed', cancelled: 'Cancelled', no_show: 'Did not attend' }

function RecordLink({ r }: { r: PortalRecordSummary }) {
  return (
    <Link to={`/patient/records/${r.id}`} className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3 hover:bg-canvas" data-testid="portal-record">
      <FileText aria-hidden="true" className="size-5 shrink-0 text-brand" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{r.chiefComplaint || 'Consultation'}</span>
        <span className="block text-sm text-ink-muted">
          {fmtDate(r.signedAt)} · {r.doctorName} · {r.departmentName}
        </span>
        {r.diagnoses.length > 0 && <span className="block text-sm">{r.diagnoses.map((d) => d.description).join('; ')}</span>}
        {r.prescriptionCount > 0 && <span className="block text-xs text-ink-muted">{r.prescriptionCount} medicine{r.prescriptionCount === 1 ? '' : 's'} prescribed</span>}
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
    </Link>
  )
}

/** One medicine of a prescription: what to take, how, for how long, and where the course is today (from the clinic's calendar). */
function MedicineLine({ m, today }: { m: PortalCurrentPrescriptionItem; today: string }) {
  const duration = durationLines(m)
  const tone = courseTone(m.course)
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid="portal-medicine">
      <p className="font-medium">{[m.drugName, m.strength, m.form].filter(Boolean).join(' ')}</p>
      <p>{[m.dose, m.route, m.frequency].filter(Boolean).join(', ')}</p>
      <p className="text-ink-muted">
        {duration.main}
        {duration.written ? ` (${duration.written})` : ''}
      </p>
      {m.instructions && <p className="text-ink-muted">{m.instructions}</p>}
      <p className={`mt-1 text-sm ${tone === 'active' ? 'font-medium text-brand-strong' : 'text-ink-muted'}`} data-testid="portal-course" data-state={m.course.state}>
        {courseLine(m.course, today)}
      </p>
    </li>
  )
}

/**
 * Today's prescription (HERO final): the prescription of the newest consultation the doctor has completed, from the signed record (no
 * copy): doctor, date, diagnosis, medicines with their course, advice and follow-up. "Latest prescription" when it is not from today.
 */
function CurrentPrescriptionCard() {
  const q = usePortal<PortalCurrentPrescriptionResponse>('/prescriptions/current', { live: true })
  if (q.isPending) return <Spinner />
  if (q.isError) return <Alert tone="error">{errorMessage(q.error)}</Alert>
  const { today, prescription: p } = q.data
  return (
    <Panel
      label={p && p.date !== today ? 'Latest prescription' : 'Today’s prescription'}
      icon={Pill}
      testId="portal-current-prescription"
      className="mb-4"
      actions={
        p && (
          <Link to={`/patient/records/${p.recordId}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-strong underline underline-offset-2">
            Open the record
          </Link>
        )
      }
    >
      {!p ? (
        <HeroEmpty>Your prescription appears here after your doctor completes your consultation.</HeroEmpty>
      ) : (
        <>
          <p className="text-sm text-ink-muted">
            {p.doctorName}
            {p.doctorRegistrationNumber ? ` (reg. ${p.doctorRegistrationNumber})` : ''} · {p.departmentName} · {fmtDate(p.date)}
          </p>
          <PanelGroup label="Diagnosis">
            <p className="text-sm">{p.diagnoses.map((d) => d.description).join('; ') || <span className="text-ink-muted">Not recorded</span>}</p>
          </PanelGroup>
          <PanelGroup label="Medicines">
            {p.items.length ? (
              <ul className="divide-y divide-line text-sm">
                {p.items.map((m, i) => (
                  <MedicineLine key={i} m={m} today={today} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">No medicines prescribed.</p>
            )}
          </PanelGroup>
          <PanelGroup>
            <KeyValueList>
              <KeyValue label="Advice and diet" value={p.advice.trim() ? <span className="whitespace-pre-wrap">{p.advice}</span> : null} />
              <KeyValue label="Follow-up" value={p.followUp.trim() || null} />
            </KeyValueList>
          </PanelGroup>
          <p className="mt-3 text-xs text-ink-muted">Take medicines only as your doctor advised. This development build is not a valid prescription for a pharmacy.</p>
        </>
      )}
    </Panel>
  )
}

export function PortalHomePage() {
  useDocumentTitle('My health record')
  const q = usePortal<PortalHome>('/home', { live: true })
  return (
    <Loading q={q}>
      {(d) => (
        <>
          <PageHeader title={`Hello, ${d.profile.fullName}`} description={`Record number ${d.profile.mrn}. Only consultations your doctor has completed are shown here.`} />
          <CurrentPrescriptionCard />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card title="Follow-up advice">
              {!d.upcoming.length && <p className="text-sm text-ink-muted">No follow-up advice in your records.</p>}
              <ul className="space-y-3">
                {d.upcoming.map((u) => (
                  <li key={u.recordId} className="flex gap-3 text-sm">
                    <CalendarClock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand" />
                    <span>
                      <span className="block">{u.followUp}</span>
                      <span className="text-xs text-ink-muted">
                        From {u.doctorName}, {fmtDate(u.signedAt)} ·{' '}
                        <Link to={`/patient/records/${u.recordId}`} className="text-brand-strong underline underline-offset-2">
                          View record
                        </Link>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-muted">This is advice from your record, not an appointment. Contact the clinic to book.</p>
            </Card>
            <Card title="Latest visit">
              {d.lastVisit ? (
                <DescriptionList
                  items={[
                    ['Date', fmtDate(d.lastVisit.visitDate)],
                    ['Department', d.lastVisit.departmentName],
                    ['Status', VISIT_STATUS[d.lastVisit.status] ?? d.lastVisit.status],
                  ]}
                />
              ) : (
                <p className="text-sm text-ink-muted">No visits yet.</p>
              )}
            </Card>
          </div>
          <nav aria-label="Your records" className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Link to="/patient/records" className="rounded-lg border border-line bg-surface p-4 font-medium hover:bg-canvas">
              Consultation records and prescriptions ({d.counts.records})
            </Link>
            <Link to="/patient/visits" className="rounded-lg border border-line bg-surface p-4 font-medium hover:bg-canvas">
              Visits ({d.counts.visits})
            </Link>
            <Link to="/patient/vitals" className="rounded-lg border border-line bg-surface p-4 font-medium hover:bg-canvas">
              Vital signs
            </Link>
            <Link to="/patient/profile" className="rounded-lg border border-line bg-surface p-4 font-medium hover:bg-canvas">
              My details and allergies
            </Link>
          </nav>
        </>
      )}
    </Loading>
  )
}

export function PortalRecordsPage() {
  useDocumentTitle('My records')
  const q = usePortal<{ records: PortalRecordSummary[] }>('/records', { live: true })
  const thermal = usePortal<{ reports: PortalThermalReport[] }>('/thermal')
  return (
    <>
      <PageHeader title="Records and prescriptions" description="Consultations your doctor has signed and completed, newest first." />
      <Loading q={q}>
        {(d) =>
          d.records.length ? (
            <ul className="space-y-2">
              {d.records.map((r) => (
                <li key={r.id}>
                  <RecordLink r={r} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No records yet">A consultation appears here after your doctor completes it.</EmptyState>
          )
        }
      </Loading>
      {thermal.data && thermal.data.reports.length > 0 && (
        <Card title="Thermal measurements" className="mt-6">
          <p className="mb-2 text-sm text-ink-muted">Temperature measurements from thermal images, approved by your doctor. They are measurements, not a diagnosis, and the method is not clinically validated.</p>
          <ul className="space-y-2 text-sm">
            {thermal.data.reports.map((t) => (
              <li key={t.id}>
                <strong>{t.bodyRegion}</strong> · {fmtDate(t.createdAt)}
                {t.pairs.map((p) => (
                  <span key={`${p.a}-${p.b}`} className="block text-ink-muted">
                    {p.a} compared with {p.b}: {p.meanDiff === null ? '—' : `${p.meanDiff > 0 ? '+' : ''}${p.meanDiff.toFixed(1)} °C`}
                  </span>
                ))}
                {t.dataOrigin !== 'clinical' && <Badge tone="notice">Demonstration data</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

export function PortalRecordPage() {
  const { recordId } = useParams()
  useDocumentTitle('Consultation record')
  const q = usePortal<PortalRecord>(`/records/${recordId}`)
  return (
    <Loading q={q}>
      {(r) => (
        <article aria-label="Consultation record">
          <nav aria-label="Breadcrumb" className="mb-3 text-sm print:hidden">
            <Link to="/patient/records" className="text-brand-strong underline underline-offset-2">
              Records
            </Link>{' '}
            / <span className="text-ink-muted">{fmtDate(r.signedAt)}</span>
          </nav>
          <PageHeader
            title={r.chiefComplaint || 'Consultation'}
            description={`Signed ${fmtDateTime(r.signedAt)} by ${r.doctorName}${r.doctorRegistrationNumber ? ` (reg. ${r.doctorRegistrationNumber})` : ''} · ${r.departmentName}`}
            actions={
              <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium print:hidden">
                <Printer aria-hidden="true" className="size-4" /> Print
              </button>
            }
          />
          <div className="space-y-4">
            <Card title="Prescription">
              {!r.prescription.length && <p className="text-sm text-ink-muted">No medicines prescribed.</p>}
              <ul className="space-y-3">
                {r.prescription.map((p, i) => {
                  const duration = durationLines(p)
                  return (
                    <li key={i} className="text-sm">
                      <strong>
                        {p.drugName} {p.strength} {p.form}
                      </strong>
                      <span className="block">
                        {p.dose}, {p.route}, {p.frequency}, for {duration.main}
                        {duration.written ? ` (${duration.written})` : ''}
                      </span>
                      {p.instructions && <span className="block text-ink-muted">{p.instructions}</span>}
                      {p.course && r.today && (
                        <span className={`block ${courseTone(p.course) === 'active' ? 'font-medium text-brand-strong' : 'text-ink-muted'}`} data-testid="portal-course" data-state={p.course.state}>
                          {courseLine(p.course, r.today)}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="mt-3 text-xs text-ink-muted">Take medicines only as your doctor advised. This development build is not a valid prescription for a pharmacy.</p>
            </Card>
            <Card title="Consultation notes">
              <DescriptionList
                items={[
                  ['Diagnosis', r.diagnoses.map((d) => `${d.description}${d.code ? ` (${d.code})` : ''}`).join('; ') || '—'],
                  ['History', r.history || '—'],
                  ['Examination', r.examination || '—'],
                  ['Assessment', r.assessment || '—'],
                  ['Plan', r.plan || '—'],
                  ['Follow-up', r.followUp || '—'],
                ]}
              />
            </Card>
            {r.amendments.length > 0 && (
              <Card title="Later corrections">
                <ul className="space-y-2 text-sm">
                  {r.amendments.map((a, i) => (
                    <li key={i}>
                      <span className="text-xs text-ink-muted">
                        {fmtDateTime(a.createdAt)} · {a.authorName} · {a.reason}
                      </span>
                      <span className="block whitespace-pre-wrap">{a.content}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            <p className="text-xs break-all text-ink-muted">Record fingerprint (SHA-256): {r.contentHash}</p>
          </div>
        </article>
      )}
    </Loading>
  )
}

export function PortalVisitsPage() {
  useDocumentTitle('My visits')
  const q = usePortal<{ visits: PortalVisit[] }>('/visits')
  return (
    <>
      <PageHeader title="Visits" />
      <Loading q={q}>
        {(d) =>
          d.visits.length ? (
            <ul className="space-y-2">
              {d.visits.map((v) => (
                <li key={v.id} className="rounded-lg border border-line bg-surface p-3 text-sm">
                  <span className="font-medium">{fmtDate(v.visitDate)}</span> · {v.departmentName} · token {v.tokenNumber}
                  <span className="block text-ink-muted">
                    {VISIT_STATUS[v.status] ?? v.status}
                    {v.doctorName ? ` · ${v.doctorName}` : ''}
                  </span>
                  {v.recordId && (
                    <Link to={`/patient/records/${v.recordId}`} className="text-brand-strong underline underline-offset-2">
                      View record
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No visits yet" />
          )
        }
      </Loading>
    </>
  )
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ')
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-28 shrink-0" role="img" aria-label={label}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" className="text-brand" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function PortalVitalsPage() {
  useDocumentTitle('My vital signs')
  const q = usePortal<{ vitals: PortalVital[] }>('/vitals')
  return (
    <>
      <PageHeader title="Vital signs" description="Measurements taken at the clinic. Ask your doctor what they mean for you." />
      <Loading q={q}>
        {(d) => {
          const kinds = VITAL_ORDER.filter((k) => d.vitals.some((v) => v.kind === k))
          if (!kinds.length) return <EmptyState title="No measurements yet" />
          return (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {kinds.map((k) => {
                const series = d.vitals.filter((v) => v.kind === k)
                const def = VITALS[k]
                const latest = series[0]!
                return (
                  <li key={k}>
                    <Card>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="flex items-center gap-2 text-sm text-ink-muted">
                            <HeartPulse aria-hidden="true" className="size-4" />
                            {def.label}
                          </p>
                          <p className="text-2xl font-semibold tabular-nums">
                            {latest.value} <span className="text-sm font-normal">{def.unit}</span>
                          </p>
                          <p className="text-xs text-ink-muted">
                            {fmtDateTime(latest.measuredAt)}
                            {latest.source === 'device' ? ' · by device' : ''}
                          </p>
                        </div>
                        <Sparkline values={[...series].reverse().map((v) => v.value)} label={`${def.label} over ${series.length} measurements, from ${series.at(-1)!.value} to ${latest.value} ${def.unit}`} />
                      </div>
                      {series.length > 1 && (
                        <details className="mt-2 text-sm">
                          <summary className="cursor-pointer text-ink-muted">Earlier measurements ({series.length - 1})</summary>
                          <ul className="mt-1 space-y-0.5 tabular-nums">
                            {series.slice(1).map((v, i) => (
                              <li key={i}>
                                {fmtDateTime(v.measuredAt)}: {v.value} {def.unit}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </Card>
                  </li>
                )
              })}
            </ul>
          )
        }}
      </Loading>
    </>
  )
}

/** The patient withdraws one consent; what changes at once is shown first. */
function WithdrawConsentDialog({ c, onClose }: { c: PortalConsent; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const withdraw = useMutation({
    mutationFn: () => api<{ ok: true; signedOut: boolean }>(`/portal/consents/${c.id}/withdraw`, { method: 'POST', body: { reason: reason.trim() || null } }),
    onSuccess: (r) => {
      if (r.signedOut) {
        // Portal access ended: drop everything cached from this session and leave the portal.
        markPortalWithdrawn()
        replaceSession(qc, null)
        navigate('/login/patient?notice=portal_withdrawn', { replace: true })
        return
      }
      void qc.invalidateQueries({ queryKey: ['portal'] })
      toast('success', 'Consent withdrawn')
      onClose()
    },
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Withdraw: ${c.title}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep my consent
          </Button>
          <Button variant="danger" loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
            Withdraw consent
          </Button>
        </>
      }
    >
      {withdraw.isError && <Alert tone="error" className="mb-3">{errorMessage(withdraw.error)}</Alert>}
      <p className="text-sm">This takes effect at once. Your care is not affected. To agree again later, ask the clinic staff.</p>
      {c.withdrawalEffect && (
        <Alert tone="warning" className="my-3">
          {c.withdrawalEffect}
        </Alert>
      )}
      <TextField label="Reason (optional)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  )
}

export function PortalConsentsPage() {
  useDocumentTitle('My consents')
  const q = usePortal<{ consents: PortalConsent[] }>('/consents')
  const [withdrawing, setWithdrawing] = useState<PortalConsent | null>(null)
  return (
    <>
      <PageHeader title="Consents" description="What you agreed to, and when. You can withdraw a consent here at any time; to agree to something new, ask the clinic staff. Your care is not affected." />
      <Loading q={q}>
        {(d) => (
          <ul className="space-y-2">
            {d.consents.map((c) => (
              <li key={c.id} className="rounded-lg border border-line bg-surface p-3 text-sm" data-testid="portal-consent">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.title}</span>
                  {c.status === 'granted' ? <Badge tone="ok">Agreed</Badge> : c.status === 'superseded' ? <Badge>Replaced by a newer agreement</Badge> : <Badge>Withdrawn</Badge>}
                  {c.scope === 'encounter' && <Badge>One consultation</Badge>}
                  {!c.currentWording && <Badge tone="warn">Earlier wording</Badge>}
                </div>
                <p className="mt-1">{c.description}</p>
                {!c.currentWording && c.status === 'granted' && <p className="mt-1 text-xs text-ink-muted">This is the wording you agreed to. The clinic uses a newer wording now and may ask you again for some features.</p>}
                <p className="mt-1 text-xs text-ink-muted">
                  Recorded {fmtDateTime(c.recordedAt)} ({c.method}, wording {c.version})
                  {c.withdrawnAt ? ` · withdrawn ${fmtDateTime(c.withdrawnAt)}${c.withdrawnVia === 'patient_portal' ? ' by you' : ''}` : ''}
                </p>
                {c.status === 'granted' && (
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => setWithdrawing(c)}>
                    Withdraw…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Loading>
      {withdrawing && <WithdrawConsentDialog c={withdrawing} onClose={() => setWithdrawing(null)} />}
    </>
  )
}

export function PortalProfilePage() {
  useDocumentTitle('My details')
  const q = usePortal<PortalProfile>('/profile')
  return (
    <>
      <PageHeader title="My details" description="If anything is wrong, tell the clinic staff at your next visit." />
      <Loading q={q}>
        {(p) => (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card title="Personal details">
              <DescriptionList
                items={[
                  ['Name', p.fullName],
                  ['Record number', p.mrn],
                  ['Date of birth', fmtDate(p.dateOfBirth)],
                  ['Sex', p.sex],
                  ['Phone', p.phone],
                  ['Email', p.email ?? '—'],
                  ['Address', p.address ?? '—'],
                  ['Blood group', p.bloodGroup ?? '—'],
                  ['Emergency contact', [p.emergencyContact.name, p.emergencyContact.phone].filter(Boolean).join(', ') || '—'],
                  ['Clinic', p.facilityName],
                ]}
              />
            </Card>
            <Card title="Allergies">
              {p.allergies.length ? (
                <ul className="space-y-1 text-sm">
                  {p.allergies.map((a, i) => (
                    <li key={i}>
                      <strong>{a.substance}</strong>
                      {a.reaction ? ` (${a.reaction})` : ''} · {a.severity}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">{p.noKnownAllergies ? 'No known allergies recorded.' : 'Allergy status not recorded yet. Tell the clinic about any allergies.'}</p>
              )}
            </Card>
          </div>
        )}
      </Loading>
    </>
  )
}
