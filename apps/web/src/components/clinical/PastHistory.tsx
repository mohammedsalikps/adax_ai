import { type Condition, type Investigation, type Medication, type PatientHistory, type PriorConsultation } from '@adaxai/contracts'
import { ChevronRight, FileText, FlaskConical, Pill, Plus, ShieldAlert, Stethoscope, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { useMe } from '../../lib/auth.tsx'
import { usePortalBase } from '../../lib/clinical.ts'
import { fmtDate } from '../../lib/format.ts'
import { rangeLabel, sinceLabel, useChangeCondition, useChangeInvestigation, useChangeMedication, usePatientHistory } from '../../lib/history.ts'
import { Button } from '../ui/Button.tsx'
import { Badge, EmptyState, ErrorState, LoadingState } from '../ui/Feedback.tsx'
import { Card } from '../ui/Layout.tsx'
import { Menu, type MenuItem } from '../ui/Menu.tsx'
import { TabPanel, Tabs } from '../ui/Tabs.tsx'
import { useToast } from '../ui/Toast.tsx'
import { AddAllergyDialog, AddConditionDialog, AddMedicationDialog, AddResultDialog, ReasonDialog } from './HistoryDialogs.tsx'
import { SurgeriesSection } from '../patients/SurgeriesSection.tsx'

type TabId = 'summary' | 'consultations' | 'medications' | 'allergies' | 'investigations'

type DialogState =
  | null
  | { kind: 'add-condition' | 'add-medication' | 'add-result' | 'add-allergy' }
  | { kind: 'condition-error' | 'medication-error' | 'medication-stop' | 'result-error'; id: string; name: string; entry: string }

const TONES = { brand: 'bg-brand-soft text-brand', down: 'bg-down-soft text-down', ok: 'bg-ok-soft text-ok', warn: 'bg-pending-soft text-pending', ai: 'bg-ai-soft text-ai' } as const

function IconTile({ icon: Icon, tone = 'brand' }: { icon: typeof Pill; tone?: keyof typeof TONES }) {
  return (
    <span aria-hidden="true" className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}>
      <Icon className="size-4" />
    </span>
  )
}

function FlagChip({ flag }: { flag: Investigation['flag'] }) {
  if (flag === 'high') return <Badge tone="warn">High</Badge>
  if (flag === 'low') return <Badge tone="warn">Low</Badge>
  if (flag === 'abnormal') return <Badge tone="down">Abnormal</Badge>
  // Not "normal": the system had no range or reading to compare it with, and a result like this must not look the same as a normal one.
  if (flag === 'unknown') return <Badge wrap>Not compared with a range</Badge>
  return null
}

function SeverityChip({ severity }: { severity: 'mild' | 'moderate' | 'severe' | 'unknown' }) {
  if (severity === 'severe') return <Badge tone="down">Severe</Badge>
  if (severity === 'moderate') return <Badge tone="warn">Moderate</Badge>
  if (severity === 'mild') return <Badge>Mild</Badge>
  return <Badge>Severity not recorded</Badge>
}

function Heading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {action}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted">{children}</p>
}

function medLine(m: { drugName: string; strength: string | null; form?: string | null }) {
  return [m.drugName, m.strength].filter(Boolean).join(' ')
}

/** A person's name without the marker the synthetic dataset adds to it. */
const person = (name: string | null) => name?.replace(/\s*\(synthetic\)$/i, '') ?? null

/** Who typed an entry in, and when: every entry names its author. */
function EnteredBy({ by, at }: { by: string | null; at: string }) {
  return (
    <span className="text-ink-muted">
      Entered by {person(by) ?? 'unknown'}, {fmtDate(at)}
    </span>
  )
}

/** An entry as it reads on the list, for the dialogs that change it: two entries can share a name. */
const conditionEntry = (c: Condition) => `${c.name}, ${sinceLabel(c.sinceYear, c.sinceMonth).toLowerCase()}, ${c.status}; entered by ${person(c.enteredByName) ?? 'unknown'} on ${fmtDate(c.enteredAt)}`
const medicationEntry = (m: Medication) =>
  `${medLine(m)}${m.dose ? `, ${m.dose}` : ''}${m.frequency ? `, ${m.frequency}` : ''}, ${m.status === 'stopped' ? `stopped${m.stoppedOn ? ` ${fmtDate(m.stoppedOn)}` : ''}` : 'current'}${m.startedOn ? `, started ${fmtDate(m.startedOn)}` : ''}; entered by ${person(m.enteredByName) ?? 'unknown'} on ${fmtDate(m.enteredAt)}`
const resultEntry = (r: Investigation) => `${r.testName} ${r.valueText}${r.unit ? ` ${r.unit}` : ''}, collected ${fmtDate(r.collectedOn)}; entered by ${person(r.enteredByName) ?? 'unknown'} on ${fmtDate(r.enteredAt)}`

function ConditionRow({ c, menu }: { c: Condition; menu?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2" data-testid="history-condition">
      <IconTile icon={FileText} tone={c.status === 'resolved' ? 'ok' : 'brand'} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words">
          {c.name}
          {c.code && <span className="ml-1.5 font-mono text-xs font-normal text-ink-muted">{c.code}</span>}
        </p>
        <p className="text-xs text-ink-muted">
          {sinceLabel(c.sinceYear, c.sinceMonth)}
          {c.note ? ` · ${c.note}` : ''}
        </p>
        <p className="text-xs">
          <EnteredBy by={c.enteredByName} at={c.enteredAt} />
        </p>
      </div>
      {c.status === 'controlled' && <Badge tone="ok">Controlled</Badge>}
      {c.status === 'resolved' && <Badge tone="ok">Resolved</Badge>}
      {menu}
    </li>
  )
}

function MedicationRow({ m, menu }: { m: Medication; menu?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-2" data-testid="history-medication">
      <IconTile icon={Pill} tone={m.status === 'current' ? 'ok' : 'warn'} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words">{medLine(m)}</p>
        <p className="text-xs text-ink-muted">
          {[m.dose, m.route && m.route !== 'Oral' ? m.route : null, m.frequency].filter(Boolean).join(' · ')}
          {m.reason ? ` · for ${m.reason}` : ''}
        </p>
        {m.status === 'stopped' && (
          <p className="text-xs text-pending">
            Stopped {m.stoppedOn ? fmtDate(m.stoppedOn) : ''} — {m.statusReason}
          </p>
        )}
        <p className="text-xs">
          <EnteredBy by={m.enteredByName} at={m.enteredAt} />
        </p>
      </div>
      {m.status === 'stopped' && <Badge tone="warn">Stopped</Badge>}
      {menu}
    </li>
  )
}

function ResultRow({ r, menu, compact }: { r: Investigation; menu?: ReactNode; compact?: boolean }) {
  return (
    <li className="flex items-center gap-3 py-2" data-testid="history-result">
      <IconTile icon={FlaskConical} tone={r.flag === 'high' || r.flag === 'low' || r.flag === 'abnormal' ? 'warn' : 'brand'} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words">{r.testName}</p>
        <p className="text-xs text-ink-muted">
          {fmtDate(r.collectedOn)}
          {!compact && ` · range ${rangeLabel(r)}`}
        </p>
        {!compact && (
          <p className="text-xs">
            <EnteredBy by={r.enteredByName} at={r.enteredAt} />
          </p>
        )}
      </div>
      <div className="flex max-w-[45%] shrink-0 flex-col items-end gap-0.5 text-right break-words">
        <p className="text-sm font-semibold tabular-nums">
          {r.valueText}
          {r.unit ? ` ${r.unit}` : ''}
        </p>
        <FlagChip flag={r.flag} />
      </div>
      {menu}
    </li>
  )
}

function ConsultationItem({ c, base }: { c: PriorConsultation; base: string }) {
  return (
    <li className="rounded-xl border border-line bg-surface" data-testid="history-consultation">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl p-3 focus-visible:outline-2 focus-visible:-outline-offset-2">
          <IconTile icon={Stethoscope} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              {fmtDate(c.date)}
              <span className="ml-2 font-normal text-ink-muted">
                {[person(c.doctorName), c.departmentName].filter(Boolean).join(' · ')}
              </span>
            </p>
            <p className="text-sm break-words">{c.chiefComplaint || 'No reason recorded'}</p>
            {c.diagnoses.length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1.5">
                {c.diagnoses.map((d) => (
                  <Badge key={d.description} tone="notice" wrap>
                    {d.description}
                  </Badge>
                ))}
              </p>
            )}
          </div>
          <ChevronRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90" />
        </summary>
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm">
          <div>
            <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Prescribed in this consultation</p>
            {c.prescription.length ? (
              <ul className="mt-1 space-y-1">
                {c.prescription.map((r, i) => (
                  <li key={`${r.drugName}-${i}`}>
                    <span className="font-medium">{medLine(r)}</span> · {[r.dose, r.frequency, r.duration].filter(Boolean).join(' · ')}
                    {r.instructions ? ` · ${r.instructions}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">Nothing was prescribed.</p>
            )}
            <p className="mt-1 text-xs text-ink-muted">What was prescribed, not a record of what the patient takes.</p>
          </div>
          <Link to={`${base}/encounters/${c.encounterId}`} className="inline-flex min-h-control-sm items-center font-medium text-brand-strong hover:underline">
            Open the signed record{c.amendmentCount ? ` (${c.amendmentCount} amendment${c.amendmentCount === 1 ? '' : 's'})` : ''}
          </Link>
        </div>
      </details>
    </li>
  )
}

/**
 * A patient's past history while consulting: a summary, earlier consultations,
 * the medicine list, allergies and investigation results, all from the patient's
 * record. Entries are typed in by staff (there is no laboratory or pharmacy
 * feed) and say who entered them; doctors add them, stop medicines and mark
 * mistakes as "entered in error" (nothing is ever deleted).
 */
export function PastHistoryPanel({ patientId, bare = false, onTabChange, idScope = 'page' }: { patientId: string; bare?: boolean; onTabChange?: (t: TabId) => void; idScope?: string }) {
  const { data: me } = useMe()
  const base = usePortalBase()
  const toast = useToast()
  const q = usePatientHistory(patientId)
  const [tab, setTabState] = useState<TabId>('summary')
  const [dialog, setDialog] = useState<DialogState>(null)
  const changeCondition = useChangeCondition(patientId)
  const changeMedication = useChangeMedication(patientId)
  const changeResult = useChangeInvestigation(patientId)
  const canWrite = me?.role === 'doctor'
  const idPrefix = `hx-${idScope}-${patientId}`
  // An error from an earlier attempt must not greet the next dialog.
  const closeDialog = () => {
    changeCondition.reset()
    changeMedication.reset()
    changeResult.reset()
    setDialog(null)
  }
  const openDialog = (d: NonNullable<DialogState>) => {
    changeCondition.reset()
    changeMedication.reset()
    changeResult.reset()
    setDialog(d)
  }
  const setTab = (t: TabId) => {
    setTabState(t)
    onTabChange?.(t)
  }
  const done = (message: string) => ({
    onSuccess: () => {
      toast('success', message)
      closeDialog()
    },
  })

  const h: PatientHistory | undefined = q.data
  const current = (h?.medications ?? []).filter((m) => m.status === 'current')
  const openConditions = (h?.conditions ?? []).filter((c) => c.status !== 'resolved')
  const resolved = (h?.conditions ?? []).filter((c) => c.status === 'resolved')
  const synthetic = !!h && [...h.conditions, ...h.medications, ...h.investigations].some((e) => e.dataOrigin === 'synthetic')

  const conditionMenu = (c: Condition): ReactNode => {
    if (!canWrite) return null
    const items: MenuItem[] = []
    for (const [status, label] of [['active', 'Mark active'], ['controlled', 'Mark controlled'], ['resolved', 'Mark resolved']] as const) {
      if (c.status !== status) items.push({ label, onSelect: () => changeCondition.mutate({ id: c.id, body: { status } }, { onSuccess: () => toast('success', `${c.name}: ${label.replace('Mark ', '').toLowerCase()}`), onError: () => toast('error', 'The change was not saved. Try again.') }) })
    }
    items.push({ label: 'Entered in error…', tone: 'danger', onSelect: () => openDialog({ kind: 'condition-error', id: c.id, name: c.name, entry: conditionEntry(c) }) })
    return <Menu label={`Actions for ${c.name}, ${sinceLabel(c.sinceYear, c.sinceMonth).toLowerCase()}`} items={items} />
  }
  const medicationMenu = (m: Medication): ReactNode => {
    if (!canWrite) return null
    const items: MenuItem[] = []
    if (m.status === 'current') items.push({ label: 'Stop…', onSelect: () => openDialog({ kind: 'medication-stop', id: m.id, name: medLine(m), entry: medicationEntry(m) }) })
    items.push({ label: 'Entered in error…', tone: 'danger', onSelect: () => openDialog({ kind: 'medication-error', id: m.id, name: medLine(m), entry: medicationEntry(m) }) })
    return <Menu label={`Actions for ${medLine(m)}, ${m.status}${m.startedOn ? `, started ${fmtDate(m.startedOn)}` : ''}`} items={items} />
  }
  const resultMenu = (r: Investigation): ReactNode => (canWrite ? <Menu label={`Actions for ${r.testName} of ${fmtDate(r.collectedOn)}`} items={[{ label: 'Entered in error…', tone: 'danger', onSelect: () => openDialog({ kind: 'result-error', id: r.id, name: r.testName, entry: resultEntry(r) }) }]} /> : null)

  const addButton = (label: string, kind: 'add-condition' | 'add-medication' | 'add-result' | 'add-allergy', show = canWrite) =>
    show ? (
      <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => openDialog({ kind })}>
        {label}
      </Button>
    ) : null

  const body = (
    <div data-testid="past-history">
      {q.isPending && <LoadingState rows={3} label="Loading the patient’s history…" />}
      {q.isError && !q.data && <ErrorState title="The patient’s history could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {h && (
        <>
          {q.isError && <p className="mb-2 text-sm text-pending">The latest update failed, so this may be out of date.</p>}
          <Tabs
            label="Past history"
            prefix={idPrefix}
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'consultations', label: 'Consultations', count: h.consultations.length + h.more.consultations },
              { id: 'medications', label: 'Medications', count: current.length },
              { id: 'allergies', label: 'Allergies', count: h.allergies.length },
              { id: 'investigations', label: 'Investigations', count: h.investigations.length + h.more.investigations },
            ]}
          />

          <TabPanel prefix={idPrefix} id="summary" active={tab === 'summary'} focusable={false} className="space-y-5 pt-4">
            <section aria-label="Known conditions">
              <Heading title="Known conditions" action={addButton('Add condition', 'add-condition')} />
              {openConditions.length ? (
                <ul className="divide-y divide-line">
                  {openConditions.map((c) => (
                    <ConditionRow key={c.id} c={c} menu={conditionMenu(c)} />
                  ))}
                </ul>
              ) : (
                <Empty>No known conditions are recorded.</Empty>
              )}
              {resolved.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer py-1 text-sm font-medium text-brand-strong">Resolved ({resolved.length})</summary>
                  <ul className="divide-y divide-line">
                    {resolved.map((c) => (
                      <ConditionRow key={c.id} c={c} menu={conditionMenu(c)} />
                    ))}
                  </ul>
                </details>
              )}
            </section>
            {/* HERO final: surgeries (doctors add and correct them; nurses read). */}
            <SurgeriesSection h={h} patientId={patientId} canWrite={canWrite} />
            <section aria-label="Allergies">
              <Heading title="Allergies" action={<button type="button" className="text-sm font-medium text-brand-strong hover:underline" onClick={() => setTab('allergies')}>View all</button>} />
              <AllergyList h={h} limit={3} />
            </section>
            <section aria-label="Current medications">
              <Heading title="Current medications" action={current.length > 4 ? <button type="button" className="text-sm font-medium text-brand-strong hover:underline" onClick={() => setTab('medications')}>View all ({current.length})</button> : null} />
              {current.length ? (
                <ul className="divide-y divide-line">
                  {current.slice(0, 4).map((m) => (
                    <MedicationRow key={m.id} m={m} />
                  ))}
                </ul>
              ) : (
                <Empty>No current medicines are recorded.</Empty>
              )}
            </section>
            <section aria-label="Recent investigations">
              <Heading title="Recent investigations" action={h.investigations.length > 4 ? <button type="button" className="text-sm font-medium text-brand-strong hover:underline" onClick={() => setTab('investigations')}>View all</button> : null} />
              {h.investigations.length ? (
                <ul className="divide-y divide-line">
                  {h.investigations.slice(0, 4).map((r) => (
                    <ResultRow key={r.id} r={r} compact />
                  ))}
                </ul>
              ) : (
                <Empty>No investigation results are recorded.</Empty>
              )}
            </section>
          </TabPanel>

          <TabPanel prefix={idPrefix} id="consultations" active={tab === 'consultations'} focusable={false} className="space-y-3 pt-4">
            {h.consultations.length ? (
              <ul className="space-y-2" aria-label="Earlier signed consultations">
                {h.consultations.map((c) => (
                  <ConsultationItem key={c.encounterId} c={c} base={base} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={Stethoscope} title="No earlier consultations">
                Signed consultations appear here. Drafts and discarded drafts are not part of the history.
              </EmptyState>
            )}
            {h.more.consultations > 0 && <p className="text-sm text-ink-muted">{h.more.consultations} older consultation{h.more.consultations === 1 ? ' is' : 's are'} not shown. Open the patient’s profile for the whole record.</p>}
          </TabPanel>

          <TabPanel prefix={idPrefix} id="medications" active={tab === 'medications'} focusable={false} className="space-y-5 pt-4">
            <section aria-label="Medicine list">
              <Heading title="Medicine list" action={addButton('Add medicine', 'add-medication')} />
              {h.medications.length ? (
                <ul className="divide-y divide-line">
                  {h.medications.map((m) => (
                    <MedicationRow key={m.id} m={m} menu={medicationMenu(m)} />
                  ))}
                </ul>
              ) : (
                <Empty>No medicines are on the list.</Empty>
              )}
            </section>
            <section aria-label="Prescribed in earlier consultations">
              <Heading title="Prescribed in earlier consultations" />
              {h.consultations.some((c) => c.prescription.length) ? (
                <ul className="divide-y divide-line text-sm">
                  {h.consultations.flatMap((c) => c.prescription.map((r, i) => ({ c, r, i }))).slice(0, 12).map(({ c, r, i }) => (
                    <li key={`${c.encounterId}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                      <span>
                        <span className="font-medium">{medLine(r)}</span> · {[r.dose, r.frequency, r.duration].filter(Boolean).join(' · ')}
                      </span>
                      <span className="text-xs text-ink-muted">{fmtDate(c.date)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Nothing was prescribed in the earlier consultations.</Empty>
              )}
              <p className="mt-1 text-xs text-ink-muted">What was prescribed, not a record of what the patient takes: confirm it with the patient before adding it to the list.</p>
            </section>
          </TabPanel>

          <TabPanel prefix={idPrefix} id="allergies" active={tab === 'allergies'} focusable={false} className="space-y-3 pt-4">
            <Heading title="Allergies" action={addButton('Add allergy', 'add-allergy', true)} />
            <AllergyList h={h} />
          </TabPanel>

          <TabPanel prefix={idPrefix} id="investigations" active={tab === 'investigations'} focusable={false} className="space-y-3 pt-4">
            <Heading title="Investigation results" action={addButton('Add result', 'add-result')} />
            {h.investigations.length ? (
              <ul className="divide-y divide-line" aria-label="Investigation results, newest first">
                {h.investigations.map((r) => (
                  <ResultRow key={r.id} r={r} menu={resultMenu(r)} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={FlaskConical} title="No investigation results">
                Results are typed in by staff; there is no laboratory feed.
              </EmptyState>
            )}
            {h.more.investigations > 0 && <p className="text-sm text-ink-muted">{h.more.investigations} older result{h.more.investigations === 1 ? ' is' : 's are'} not shown.</p>}
          </TabPanel>

          <p className="mt-4 border-t border-line pt-3 text-xs text-ink-muted">
            Typed in by staff; there is no laboratory or pharmacy feed. Each entry says who entered it and when, and mistakes are marked, never deleted.{synthetic ? ' Synthetic data, made up for development.' : ''}
          </p>
        </>
      )}

      {dialog?.kind === 'add-condition' && <AddConditionDialog patientId={patientId} onClose={closeDialog} />}
      {dialog?.kind === 'add-medication' && <AddMedicationDialog patientId={patientId} onClose={closeDialog} />}
      {dialog?.kind === 'add-result' && <AddResultDialog patientId={patientId} onClose={closeDialog} />}
      {dialog?.kind === 'add-allergy' && <AddAllergyDialog patientId={patientId} onClose={closeDialog} />}
      {dialog?.kind === 'condition-error' && (
        <ReasonDialog
          title={`Mark “${dialog.name}” as entered in error`}
          entry={dialog.entry}
          intro="The entry stays in the record, marked as an error with your reason, and leaves the history. This cannot be undone."
          confirmLabel="Mark as entered in error"
          pending={changeCondition.isPending}
          error={changeCondition.error}
          onClose={closeDialog}
          onConfirm={(reason) => changeCondition.mutate({ id: dialog.id, body: { status: 'entered_in_error', reason } }, done('Marked as entered in error'))}
        />
      )}
      {dialog?.kind === 'medication-error' && (
        <ReasonDialog
          title={`Mark “${dialog.name}” as entered in error`}
          entry={dialog.entry}
          intro="The entry stays in the record, marked as an error with your reason, and leaves the list. This cannot be undone."
          confirmLabel="Mark as entered in error"
          pending={changeMedication.isPending}
          error={changeMedication.error}
          onClose={closeDialog}
          onConfirm={(reason) => changeMedication.mutate({ id: dialog.id, body: { status: 'entered_in_error', reason } }, done('Marked as entered in error'))}
        />
      )}
      {dialog?.kind === 'medication-stop' && (
        <ReasonDialog
          title={`Stop “${dialog.name}”`}
          entry={dialog.entry}
          intro="The medicine stays in the list as stopped, with the date and your reason. To take it again, add it as a new entry."
          confirmLabel="Stop medicine"
          withDate
          pending={changeMedication.isPending}
          error={changeMedication.error}
          onClose={closeDialog}
          onConfirm={(reason, date) => changeMedication.mutate({ id: dialog.id, body: { status: 'stopped', stoppedOn: date, reason } }, done('Medicine stopped'))}
        />
      )}
      {dialog?.kind === 'result-error' && (
        <ReasonDialog
          title={`Mark the ${dialog.name} result as entered in error`}
          entry={dialog.entry}
          intro="The result stays in the record, marked as an error with your reason, and leaves the list. This cannot be undone."
          confirmLabel="Mark as entered in error"
          pending={changeResult.isPending}
          error={changeResult.error}
          onClose={closeDialog}
          onConfirm={(reason) => changeResult.mutate({ id: dialog.id, body: { status: 'entered_in_error', reason } }, done('Marked as entered in error'))}
        />
      )}
    </div>
  )

  if (bare) return body
  return (
    <Card title="Past history" className="min-w-0">
      {body}
    </Card>
  )
}

function AllergyList({ h, limit }: { h: PatientHistory; limit?: number }) {
  const list = limit ? h.allergies.slice(0, limit) : h.allergies
  if (!h.allergies.length) return <Empty>{h.noKnownAllergies ? 'No known allergies.' : 'Allergies are not recorded for this patient.'}</Empty>
  return (
    <>
      <ul className="divide-y divide-line" aria-label="Active allergies">
        {list.map((a) => (
          <li key={a.id} className="flex items-center gap-3 py-2" data-testid="history-allergy">
            <IconTile icon={a.severity === 'severe' || a.severity === 'moderate' ? TriangleAlert : ShieldAlert} tone={a.severity === 'severe' ? 'down' : a.severity === 'moderate' ? 'warn' : 'brand'} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{a.substance}</p>
              <p className="text-xs text-ink-muted">{[a.reaction, `recorded ${fmtDate(a.recordedAt)}`, person(a.recordedByName)].filter(Boolean).join(' · ')}</p>
            </div>
            <SeverityChip severity={a.severity} />
          </li>
        ))}
      </ul>
      {limit && h.allergies.length > limit && <p className="mt-1 text-xs text-ink-muted">{h.allergies.length - limit} more in the Allergies tab.</p>}
    </>
  )
}

