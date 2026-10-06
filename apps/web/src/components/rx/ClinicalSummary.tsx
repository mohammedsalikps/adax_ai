import { CONSULT_SECTIONS, type ConsultItem, type Encounter, ITEM_FLAGS, type NoteFields, SUPPORT_STATES } from '@adaxai/contracts'
import { Check, ChevronDown, ClipboardList, Pencil, Plus, ShieldAlert, Sparkles, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { savedForAnalysis } from '../../lib/analysis.ts'
import { errorMessage } from '../../lib/api.ts'
import { useConsultationAi, useGenerateDraft, useReviewConsultItem } from '../../lib/consult.ts'
import type { SaveState } from '../../lib/draftSaver.ts'
import { fmtDate } from '../../lib/format.ts'
import { usePatientHistory } from '../../lib/history.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { localToday, vitalsText } from '../../lib/patientRecord.ts'
import { AllergyItems } from '../clinical/AllergyItems.tsx'
import { Panel, PanelGroup } from '../hero/Panel.tsx'
import { SourceTag } from '../hero/SourceTag.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { Menu } from '../ui/Menu.tsx'
import { useToast } from '../ui/Toast.tsx'
import { draftProgressText, groupStatements, noteSectionChoices, noteSectionLabel, PROGRESS_ANNOUNCEMENT, SUMMARY_GROUPS, type SummaryGroupKey, statementActions, summaryView } from './rxModel.ts'

/**
 * The prescription page's left column (DESIGN §5.6): the local model's draft of the consultation, grouped as the doctor reads it, each
 * statement marked AI DRAFT with its support state and its sources on demand, and the doctor's three acts: [Add to note] (accept, then the
 * recorded insertion into the note section it fits, or another chosen from the menu: one act), [Edit] (the same with the doctor's words),
 * [Remove] (reject). The allergies and the vital signs are the record's, never the model's. While the model writes: its real progress (tokens
 * as counted, time since its turn came) and grey placeholders; when it cannot be asked, the doctor writes the prescription without it.
 */
export function ClinicalSummary({ encounter, inserter, editable, flushState }: { encounter: Encounter; inserter: NoteInserter; editable: boolean; flushState?: () => Promise<SaveState> }) {
  const ai = useConsultationAi(encounter.id)
  const view = summaryView(ai.data)
  const generate = useGenerateDraft(encounter.id)
  const groups = view.kind === 'shown' ? groupStatements(view.items) : null
  const conflicts = ai.data?.draft?.recordCheck.conflicts ?? []
  const loading = view.kind === 'generating' || view.kind === 'unread'
  // The model's groups only while it writes or once it has written; the record's allergies and vital signs are always shown.
  const showAi = loading || !!groups
  // Mana reads what is saved: the pending edits are saved first, and Mana is not asked when they could not be (as Generate prescription does).
  const [saving, setSaving] = useState(false)
  const [notSaved, setNotSaved] = useState(false)
  const askMana = async () => {
    setNotSaved(false)
    if (flushState) {
      setSaving(true)
      const state = await flushState().finally(() => setSaving(false))
      if (!savedForAnalysis(state)) return setNotSaved(true)
    }
    generate.mutate()
  }
  const ask = (label: string) =>
    editable && (view.kind === 'none' || view.kind === 'ended') && view.canGenerate ? (
      <Button size="sm" variant="secondary" icon={<Sparkles aria-hidden="true" className="size-4" />} loading={saving || generate.isPending} onClick={() => void askMana()}>
        {label}
      </Button>
    ) : null
  return (
    <Panel label="Clinical summary" icon={ClipboardList} testId="clinical-summary" actions={<SourceTag kind="ai" />}>
      <div className="space-y-2" data-testid="clinical-summary-state" data-state={view.kind}>
        {view.kind === 'generating' && ai.data?.draft && <Progress draft={ai.data.draft} />}
        {view.kind === 'unread' && ai.isError && <p className="text-sm text-ink-muted">Mana’s summary could not be read just now.</p>}
        {view.kind === 'unavailable' && (
          <p className="text-sm font-medium" data-testid="mana-unavailable">
            Mana is unavailable — write the prescription yourself
          </p>
        )}
        {view.kind === 'none' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <p>No summary from Mana for this consultation yet.</p>
            {ask('Ask Mana for a summary')}
          </div>
        )}
        {view.kind === 'ended' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <p>{view.status === 'cancelled' ? 'The last summary was cancelled.' : 'The last summary could not be made.'} You can write the prescription yourself.</p>
            {ask('Try again')}
          </div>
        )}
        {view.kind === 'insufficient' && <p className="text-sm text-ink-muted">Too little is recorded for this consultation for Mana to summarise.</p>}
        {view.kind === 'shown' && view.stale && <p className="text-xs text-pending">Written before your note or the record last changed: check it against them.</p>}
        {view.kind === 'shown' && view.partial && <p className="text-xs text-ink-muted">Mana could make only part of this summary.</p>}
        {generate.isError && <Alert tone="error">{errorMessage(generate.error)}</Alert>}
        {notSaved && <Alert tone="error">Your latest changes could not be saved, so Mana was not asked. Mana reads what is saved.</Alert>}
      </div>
      {showAi &&
        SUMMARY_GROUPS.slice(0, 2).map((g) => (
          <StatementGroup key={g.key} title={g.title} keyName={g.key} items={groups?.[g.key]} loading={loading} encounterId={encounter.id} inserter={inserter} editable={editable} conflicts={conflicts} />
        ))}
      <PanelGroup label="Allergies" testId="summary-allergies" actions={<SourceTag kind="record" />}>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies on record">
          <AllergyItems encounter={encounter} />
        </ul>
      </PanelGroup>
      <StatementGroup title="Findings & observations" keyName="findings" items={groups?.findings} loading={loading} encounterId={encounter.id} inserter={inserter} editable={editable} conflicts={conflicts}>
        <VitalsLine encounter={encounter} />
      </StatementGroup>
      {showAi &&
        SUMMARY_GROUPS.slice(3).map((g) => (
          <StatementGroup key={g.key} title={g.title} keyName={g.key} items={groups?.[g.key]} loading={loading} encounterId={encounter.id} inserter={inserter} editable={editable} conflicts={conflicts} />
        ))}
    </Panel>
  )
}

/** The model's real progress: tokens as the model server counted them and the time since its turn came (no percentage, no time left). */
function Progress({ draft }: { draft: NonNullable<NonNullable<ReturnType<typeof useConsultationAi>['data']>['draft']> }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // Only the stable words are in the live region; the clock and the token count, which change every second, are outside it (never announced).
  return (
    <p className="flex items-center gap-2 text-sm text-ai" data-testid="summary-progress">
      <Sparkles aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-pulse" />
      <span>
        <span role="status">{PROGRESS_ANNOUNCEMENT}</span> <span className="tabular-nums">{draftProgressText(draft, now)}</span>
      </span>
    </p>
  )
}

/** The latest vital signs from the record (staff-measured; a device's unverified value marked; never a simulator's). */
function VitalsLine({ encounter }: { encounter: Encounter }) {
  const history = usePatientHistory(encounter.patient.id)
  const today = localToday()
  const text = vitalsText(encounter.vitals.length ? encounter.vitals : history.data?.latestVitals, today)
  return (
    <p className="mb-2 flex flex-wrap items-center gap-2 text-sm" data-testid="summary-vitals">
      <span className="font-medium">Last vitals</span>
      <span className={text ? '' : 'text-ink-muted'}>{text ?? (history.isPending && !encounter.vitals.length ? 'Reading the record…' : 'Not recorded')}</span>
      <SourceTag kind="record" />
    </p>
  )
}

function StatementGroup({
  title,
  keyName,
  items,
  loading,
  encounterId,
  inserter,
  editable,
  conflicts,
  children,
}: {
  title: string
  keyName: SummaryGroupKey
  items: ConsultItem[] | undefined
  loading: boolean
  encounterId: string
  inserter: NoteInserter
  editable: boolean
  conflicts: { text: string; keys: string[] }[]
  children?: ReactNode
}) {
  return (
    <PanelGroup label={title} testId={`summary-${keyName}`}>
      {children}
      {loading ? (
        <div aria-hidden="true" className="space-y-2 py-1">
          <div className="h-3 w-11/12 rounded bg-line motion-safe:animate-pulse" />
          <div className="h-3 w-3/4 rounded bg-line motion-safe:animate-pulse" />
        </div>
      ) : items === undefined ? null : items.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing from Mana here.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <StatementRow key={i.id} item={i} encounterId={encounterId} inserter={inserter} editable={editable} conflicts={conflicts} />
          ))}
        </ul>
      )}
    </PanelGroup>
  )
}

/** One AI statement with its three acts (see ClinicalSummary). */
function StatementRow({ item, encounterId, inserter, editable, conflicts }: { item: ConsultItem; encounterId: string; inserter: NoteInserter; editable: boolean; conflicts: { text: string; keys: string[] }[] }) {
  const toast = useToast()
  const review = useReviewConsultItem(encounterId)
  const actions = statementActions(item, { editable, inserted: inserter.inserted('consultation_item', item.id) })
  const choices = noteSectionChoices(item.section)
  const [tick, setTick] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.finalText ?? item.text)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const sourcesId = useId()
  const shown = item.finalText ?? item.text
  const keys = new Set(item.sources.map((s) => s.key))
  const conflictsHere = item.flags.includes('record_conflict') ? conflicts.filter((c) => c.keys.some((k) => keys.has(k))) : []
  const blocked = actions.tick && !tick

  /** One act: accept (or accept the edited words) when still pending, then the recorded insertion into the note section. */
  const add = async (section: keyof NoteFields, edited?: string) => {
    setBusy(true)
    setProblem(null)
    try {
      if (item.decision === 'pending') {
        await review.mutateAsync({ id: item.id, body: edited !== undefined ? { action: 'edited', text: edited.trim(), confirmFlags: tick } : { action: 'accepted', confirmFlags: tick } })
      }
      await inserter.insert(section, edited !== undefined ? edited.trim() : shown, { type: 'consultation_item', id: item.id })
      setEditing(false)
      toast('success', `Added to the note: ${noteSectionLabel(section)}. Review it there.`)
    } catch (e) {
      setProblem(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = () => {
    setProblem(null)
    review.mutate({ id: item.id, body: { action: 'rejected' } }, { onError: (e) => setProblem(errorMessage(e)) })
  }
  const target = choices[0]
  return (
    <li className={`border-l-2 py-1 pl-3 ${actions.state === 'removed' ? 'border-line-strong' : 'border-ai/70'}`} data-testid="rx-statement" data-section={item.section} data-decision={item.decision} data-state={actions.state}>
      <p className="text-sm break-words">
        {editing ? null : <span className={actions.state === 'removed' ? 'text-ink-muted line-through' : ''}>{shown}</span>}
      </p>
      {editing && <TextAreaField label="Edit before adding to the note" rows={3} value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
        <SourceTag kind="ai" />
        <span>{SUPPORT_STATES[item.support]}</span>
        <span aria-hidden="true">·</span>
        <span>{CONSULT_SECTIONS[item.section]}</span>
        {actions.state === 'in_note' && (
          <span className="inline-flex items-center gap-1 font-medium text-ok">
            <Check aria-hidden="true" className="size-3.5" /> In the note
          </span>
        )}
        {actions.state === 'removed' && <span className="font-medium">Removed</span>}
        <button type="button" className="inline-flex min-h-control-sm items-center gap-1 rounded-md hover:text-ink" aria-expanded={open} aria-controls={sourcesId} onClick={() => setOpen((o) => !o)}>
          <ChevronDown aria-hidden="true" className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          Sources ({item.sources.length}){item.sourceChanged && <span className="font-medium text-pending"> · changed since</span>}
        </button>
      </div>
      {item.flags.length > 0 && actions.state !== 'removed' && (
        <ul className="mt-1 space-y-0.5 text-xs text-pending" aria-label="Checks to make">
          {item.flags.map((f) => (
            <li key={f} className="flex gap-1">
              <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {ITEM_FLAGS[f]}
            </li>
          ))}
        </ul>
      )}
      {conflictsHere.length > 0 && <p className="mt-1 text-xs font-medium text-down">Found by the fixed rules, not by the AI: {conflictsHere.map((c) => c.text).join('; ')}</p>}
      <div id={sourcesId} hidden={!open} className="mt-1.5 space-y-1 border-t border-line pt-1.5 text-xs">
        {item.rationale && <p className="text-ink-muted">Why the AI listed this: {item.rationale}</p>}
        {item.uncertainty && <p className="text-ink-muted">Uncertain: {item.uncertainty} (the AI’s own words, not a measured probability)</p>}
        {item.sources.length ? (
          <ul className="divide-y divide-line">
            {item.sources.map((s) => (
              <li key={`${s.key}-${s.ref}`} className="py-1">
                <p>
                  <span className="font-medium">{s.field}</span>
                  <span className="text-ink-muted">
                    {s.date ? ` · ${fmtDate(s.date)}` : ''}
                    {s.status ? ` · ${s.status}` : ''}
                    {s.change === 'changed' ? ' · changed since this draft' : s.change === 'removed' ? ' · no longer in the record' : ''}
                  </span>
                </p>
                <p>“{s.excerpt}”</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">No record item is cited.</p>
        )}
      </div>
      {actions.tick && (
        <label className="mt-1 flex min-h-control-sm items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 shrink-0 accent-brand" checked={tick} onChange={(e) => setTick(e.target.checked)} />
          <span>I have checked this against the record</span>
        </label>
      )}
      {(actions.add || actions.edit || actions.remove) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {editing ? (
            <>
              <Button size="sm" loading={busy} disabled={!text.trim() || blocked || !target} icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => target && void add(target, text)}>
                Add edited text to note
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {actions.add && target && (
                <span className="inline-flex">
                  <Button size="sm" variant="subtle" className="rounded-r-none" loading={busy} disabled={blocked} icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => void add(target)}>
                    Add to note
                    <span className="sr-only"> ({noteSectionLabel(target)})</span>
                  </Button>
                  {choices.length > 1 && (
                    <Menu
                      label="Add to another note section"
                      align="start"
                      items={choices.map((k) => ({ label: `Add to ${noteSectionLabel(k)}`, onSelect: () => void add(k), disabled: busy || blocked }))}
                      trigger={<ChevronDown aria-hidden="true" className="size-4" />}
                      triggerClassName="-ml-px inline-flex min-h-control-sm items-center rounded-r-md border border-brand/30 bg-brand-soft px-2 text-brand-strong hover:bg-brand/15"
                    />
                  )}
                </span>
              )}
              {actions.edit && (
                <Button size="sm" variant="secondary" icon={<Pencil aria-hidden="true" className="size-4" />} disabled={busy} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {actions.remove && (
                <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} loading={review.isPending && review.variables?.body.action === 'rejected'} disabled={busy} onClick={remove}>
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-1 text-xs font-medium text-down">
          {problem}
        </p>
      )}
    </li>
  )
}
