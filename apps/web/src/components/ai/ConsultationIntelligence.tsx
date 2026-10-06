import {
  CONSULT_NOTE_SECTION,
  CONSULT_SECTIONS,
  ConsultationContext,
  type ConsultDraft,
  type ConsultItem,
  type ConsultSection,
  type EncounterAi,
  factState,
  ITEM_FLAGS,
  NOTE_SECTIONS,
  type NoteFields,
  type RecordCheck,
  type RecordFinding,
  SUPPORT_STATES,
  type SupportState,
} from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { BrainCircuit, Check, ChevronDown, Info, Pencil, Plus, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { aiKey } from '../../lib/ai.ts'
import { DRAFT_VIEW_LABEL, type DraftView, draftTiming, draftView, fmtDuration } from '../../lib/analysis.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { useCancelDraft, useConsultationAi, useGenerateDraft, useReviewConsultItem } from '../../lib/consult.ts'
import { contextKey } from '../../lib/consultationContext.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, type BadgeTone, Spinner } from '../ui/Feedback.tsx'
import { SelectField, TextAreaField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'

/**
 * Local AI consultation intelligence: a DRAFT made by a language model that runs on this computer from the authorised record, the doctor's own notes
 * and the points the doctor confirmed during capture. Everything here is for the doctor to review: nothing is added to the note, the diagnoses or the
 * prescription except by a separate act after accepting a statement.
 */

/** The parts of a draft as the doctor reads them. Each is a region named by its title (the screen and its tests know them by these names). */
type GroupKey = 'summary' | 'problem' | 'history' | 'uncertainties' | 'missing' | 'considerations' | 'investigations' | 'medication'
const GROUPS: Record<GroupKey, { title: string; sections: readonly ConsultSection[] }> = {
  summary: { title: 'Clinical summary', sections: ['summary'] },
  problem: {
    title: 'Current problem',
    sections: ['presenting_problem', 'symptoms', 'observations'],
  },
  history: {
    title: 'Relevant history',
    sections: ['relevant_history', 'allergies', 'medications'],
  },
  uncertainties: {
    title: 'Conflicts and uncertainties',
    sections: ['uncertainties'],
  },
  missing: { title: 'Missing information', sections: ['missing_information'] },
  considerations: {
    title: 'Potential considerations',
    sections: ['potential_considerations'],
  },
  investigations: {
    title: 'Potential investigations',
    sections: ['potential_investigations'],
  },
  medication: {
    title: 'Medication considerations',
    sections: ['potential_medication_considerations'],
  },
}

/** The headings the doctor scans, in reading order, each holding one or more of the groups above. Headings only: the groups stay the regions. */
type BlockKey = 'summary' | 'findings' | 'conflicts' | 'missing' | 'recommendations'
const BLOCKS: { key: BlockKey; title: string; groups: readonly GroupKey[] }[] = [
  { key: 'summary', title: 'AI summary', groups: ['summary'] },
  {
    key: 'findings',
    title: 'Important findings',
    groups: ['problem', 'history'],
  },
  {
    key: 'conflicts',
    title: 'Conflicts & uncertainties',
    groups: ['uncertainties'],
  },
  { key: 'missing', title: 'Missing information', groups: ['missing'] },
  {
    key: 'recommendations',
    title: 'AI-assisted recommendations',
    groups: ['considerations', 'investigations', 'medication'],
  },
]

const MEDICATION: ConsultSection = 'potential_medication_considerations'

/** Statements of a group shown before "Show n more"; the rest of a long group folds away (still there, decided the same way when shown). */
const FOLD_AFTER = 3

/** When a draft arrives on the screen, its headings settle in one after another, this far apart (five headings: under half a second in all). */
const REVEAL_STEP_MS = 60

const SUPPORT_TONE: Record<SupportState, BadgeTone> = {
  supported: 'ok',
  inferred: 'ai',
  not_found: 'neutral',
  conflicting: 'down',
  outdated: 'warn',
}

const VIEW_TONE: Record<DraftView, BadgeTone> = {
  not_run: 'neutral',
  generating: 'notice',
  ready: 'ai',
  partial: 'warn',
  failed: 'down',
  cancelled: 'neutral',
  unavailable: 'down',
  stale: 'warn',
  insufficient: 'neutral',
}

/** The title of the one alert that says the model cannot be used now. The server's reasons often start with the same words. */
const UNAVAILABLE = 'Local AI unavailable.'

/** What the server says about the model beyond the alert's title (null when it says nothing more). */
function beyondTitle(reason: string | null): string | null {
  const rest = (reason ?? '').replace(/^Local AI unavailable[.:]\s*/, '').trim()
  return rest ? rest[0]!.toUpperCase() + rest.slice(1) : null
}

/** Whether a draft's statements are the ones to show: a finished draft with statements, not one that had too little to draft from. */
export const showsStatements = (d: Pick<ConsultDraft, 'status' | 'insufficient'>): boolean => (d.status === 'ready' || d.status === 'partial') && !d.insufficient

/**
 * The draft's medication considerations, in the model's order (at most four, by the draft's contract): what the prescription's "Before you
 * prescribe" lane shows. Empty for a draft whose statements are not shown (being made, failed, cancelled, too little to draft from).
 */
export function medicationConsiderations(draft: Pick<ConsultDraft, 'status' | 'insufficient' | 'items'> | null | undefined): ConsultItem[] {
  if (!draft || !showsStatements(draft)) return []
  return draft.items.filter((i) => i.section === MEDICATION).sort((a, b) => a.position - b.position)
}

/**
 * The statements of a long group that fold away. A group shows three: the first statement of each of its parts (so no part is ever all
 * folded), then the next ones in order until there are three. One the rules found CONFLICTING is never folded.
 */
export function foldedIds(items: readonly Pick<ConsultItem, 'id' | 'section' | 'support'>[]): Set<string> {
  const first = new Set<string>()
  const parts = new Set<ConsultSection>()
  for (const i of items) {
    if (parts.has(i.section)) continue
    parts.add(i.section)
    first.add(i.id)
  }
  let room = Math.max(0, FOLD_AFTER - first.size)
  const out = new Set<string>()
  for (const i of items) {
    if (first.has(i.id) || i.support === 'conflicting') continue
    if (room > 0) room -= 1
    else out.add(i.id)
  }
  return out
}

const statements = (n: number) => `${n} statement${n === 1 ? '' : 's'}`

type Level = 2 | 3 | 4 | 5
function Heading({ level, className, children }: { level: Level; className?: string; children: ReactNode }) {
  const Tag = `h${level}` as const
  return <Tag className={className}>{children}</Tag>
}

/** Time since a draft was asked for, by this computer's clock against the server's (the panel's own clock, used when the page gives no analysis of its own). */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="tabular-nums">{fmtDuration(Math.max(0, now - Date.parse(since)))}</span>
}

// --- rules-based record check ------------------------------------------------------------------------------------------------------------

function Findings({ title, tone, items }: { title: string; tone: 'down' | 'warn' | 'neutral'; items: RecordFinding[] }) {
  if (!items.length) return null
  const cls = tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-pending' : 'text-ink-muted'
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wide ${cls}`}>{title}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {items.map((f, i) => (
          <li key={i}>
            {f.text}
            {f.refs.length > 0 && <span className="ml-1 font-mono text-xs text-ink-muted">[{f.refs.join(', ')}]</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * What the fixed rules found in the record before any draft (conflicts, items possibly out of date, what is missing): not the AI's. Since
 * Doctor HERO polish it stands in the consultation overview (the fixed rules' card), drawn flat; once a draft has statements, the same findings
 * are shown with the draft's own conflicts and missing information instead.
 */
export function RecordCheckCard({ check, level }: { check: RecordCheck; level: Level }) {
  const none = !check.conflicts.length && !check.outdated.length && !check.missing.length
  return (
    <div className="text-sm" data-testid="record-check">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Heading level={level} className="text-sm font-semibold">
          Record check
        </Heading>
        <Badge tone="neutral">Fixed rules, not AI</Badge>
        <span className="text-xs text-ink-muted">{check.rulesVersion}</span>
      </div>
      {none ? (
        <p className="text-sm text-ink-muted">The rules found no conflict, old item or missing item in the record.</p>
      ) : (
        <div className="space-y-3">
          <Findings title="Conflicts" tone="down" items={check.conflicts} />
          <Findings title="Possibly out of date" tone="warn" items={check.outdated} />
          <Findings title="Missing" tone="neutral" items={check.missing} />
        </div>
      )}
    </div>
  )
}

// --- statements ----------------------------------------------------------------------------------------------------------------------------

/**
 * The record items a statement cites, each with its field, date and status and the words quoted, and whether it changed since the draft. A
 * quote is the text the model was shown, in which the patient's name is replaced (by "[PATIENT]"): said once above the list when a quote holds it.
 */
function SourceList({ item }: { item: ConsultItem }) {
  const masked = item.sources.some((s) => /\[[A-Z_]+\]/.test(s.excerpt))
  return (
    <>
      {masked && <p className="text-ink-muted">Quoted as the model was shown it: names are replaced by [PATIENT].</p>}
      <ul className="divide-y divide-line">
        {item.sources.map((s) => (
          <li key={`${s.key}-${s.ref}`} className="py-1.5">
            <p>
              <span className="font-mono text-ink-muted">{s.ref}</span> <span className="font-medium">{s.field}</span>
              <span className="text-ink-muted">
                {s.date ? ` · ${fmtDate(s.date)}` : ''}
                {s.status ? ` · ${s.status}` : ''}
              </span>
              {s.change === 'changed' && <span className="ml-1 font-medium text-pending">· changed since this draft</span>}
              {s.change === 'removed' && <span className="ml-1 font-medium text-down">· no longer in the record</span>}
            </p>
            <p className="mt-0.5">“{s.excerpt}”</p>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * One statement of the draft for the doctor to decide, as a flat row under a hairline, marked as the AI's by a violet rule on its left: its
 * support state and its text (with the checks to make and what the fixed rules found about its record items), "Sources (n)" (small: it opens
 * the record items it cites and why the AI listed it) and Accept / Edit / Reject (36px; the icons drop where the row is narrow), on a row that
 * never wraps. Where the row is 45rem wide or more the decision stands beside the text, so a one-line statement is one line; narrower, under
 * it, beside "Sources". Once accepted, "Add to note" (a separate act; nothing else writes to the note). `noteSections` limits where it may be added (the prescription lane allows the Plan only); with one
 * section left there is nothing to choose. `hidden` keeps it mounted while its group is folded.
 */
export function StatementCard({
  item,
  conflicts,
  encounterId,
  inserter,
  noteSections,
  hidden = false,
}: {
  item: ConsultItem
  conflicts: RecordFinding[]
  encounterId: string
  inserter: NoteInserter
  noteSections?: readonly (keyof NoteFields)[]
  hidden?: boolean
}) {
  const toast = useToast()
  // What the fixed rules found about the record items this statement rests on: shown with the statement, so the doctor sees what disagrees.
  const keys = new Set(item.sources.map((s) => s.key))
  const conflictsHere = item.flags.includes('record_conflict') ? conflicts.filter((c) => c.keys.some((k) => keys.has(k))) : []
  const review = useReviewConsultItem(encounterId)
  const sections = NOTE_SECTIONS.filter((s) => !noteSections || noteSections.includes(s.key))
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.finalText ?? item.text)
  const [confirmed, setConfirmed] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const sourcesId = useId()
  const [target, setTarget] = useState<keyof NoteFields>(() => {
    const fit = CONSULT_NOTE_SECTION[item.section] ?? 'history'
    return sections.some((s) => s.key === fit) ? fit : (sections[0]?.key ?? fit)
  })
  const [adding, setAdding] = useState(false)
  const decided = item.decision !== 'pending'
  const shown = item.finalText ?? item.text
  const blocked = item.needsConfirmation && !confirmed
  const act = (action: 'accepted' | 'edited' | 'rejected') =>
    review.mutate(
      {
        id: item.id,
        body: action === 'edited' ? { action, text: text.trim(), confirmFlags: confirmed } : { action, confirmFlags: confirmed },
      },
      { onSuccess: () => setEditing(false) },
    )
  const inNote = item.inNote || inserter.inserted('consultation_item', item.id)
  // A comment on the record (an uncertainty) is not text for the note.
  const insertable = CONSULT_NOTE_SECTION[item.section] !== null && sections.length > 0
  const only = sections.length === 1 ? sections[0]! : null
  const canAdd = (item.decision === 'accepted' || item.decision === 'edited') && !inNote && insertable
  const add = async () => {
    setAdding(true)
    try {
      await inserter.insert(target, shown, {
        type: 'consultation_item',
        id: item.id,
      })
      toast('success', 'Added to the note. Review it there.')
    } catch (e) {
      toast('error', errorMessage(e))
    } finally {
      setAdding(false)
    }
  }
  // The icons of the row's buttons are drawn where the statement is at least 26rem wide; narrower, the words alone keep the row on one line.
  const icon = (node: ReactNode) => <span className="hidden @[26rem]/stmt:contents">{node}</span>
  const hasDetails = item.sources.length > 0 || !!item.rationale || !!item.uncertainty
  return (
    <li
      hidden={hidden || undefined}
      className={`@container/stmt border-l-2 py-2.5 pr-1 pl-3 ${item.decision === 'rejected' ? 'border-line-strong' : 'border-ai/70'}`}
      data-testid="consult-statement"
      data-section={item.section}
      data-support={item.support}
      data-decision={item.decision}
    >
      {/* Narrow: the text across the row, then Sources and the decision on one row. From 45rem: the text and Sources on the left, the decision
          on the right of the text. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-1 @[45rem]/stmt:items-start @[45rem]/stmt:gap-x-4">
        <div className="col-span-2 min-w-0 @[45rem]/stmt:col-span-1">
          {/* Its support state, what the doctor decided, and the statement. */}
          <div className="text-sm break-words">
            <span className="mr-1.5 inline-flex flex-wrap items-center gap-1 align-[1px]">
              <Badge tone={SUPPORT_TONE[item.support]} dot>
                {SUPPORT_STATES[item.support].toUpperCase()}
              </Badge>
              {item.decision === 'accepted' && <Badge tone="ok">Accepted</Badge>}
              {item.decision === 'edited' && <Badge tone="ok">Edited and accepted</Badge>}
              {item.decision === 'rejected' && <Badge>Rejected</Badge>}
              {inNote && (
                <Badge tone="ai" icon={<Check aria-hidden="true" className="size-3" />}>
                  In the note
                </Badge>
              )}
            </span>
            {editing ? null : <span className={item.decision === 'rejected' ? 'text-ink-muted line-through' : ''}>{shown}</span>}
          </div>
          {editing && (
            <div className="mt-2">
              <TextAreaField label="Edit before accepting" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          )}
          {item.flags.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs text-pending" aria-label="Checks to make">
              {item.flags.map((f) => (
                <li key={f} className="flex gap-1">
                  <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  {ITEM_FLAGS[f]}
                </li>
              ))}
            </ul>
          )}
          {conflictsHere.length > 0 && (
            <p className="mt-1 text-xs font-medium text-down" data-testid="statement-conflict">
              Found by the fixed rules, not by the AI: {conflictsHere.map((c) => c.text).join('; ')}
            </p>
          )}
          {review.isError && (
            <Alert tone="error" className="mt-2">
              {errorMessage(review.error)}
            </Alert>
          )}
          {!decided && item.needsConfirmation && (
            <label className="mt-1 flex min-h-control-sm items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-4 shrink-0 accent-brand" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I have checked this against the record</span>
            </label>
          )}
        </div>
        {/* The sources: small, and the first to give way. */}
        <div className="col-start-1 row-start-2 flex min-w-0">
          {hasDetails ? (
            <button
              type="button"
              className="-my-1.5 inline-flex min-h-control-sm min-w-0 items-center gap-1 rounded-md text-left text-xs text-ink-muted hover:text-ink"
              aria-expanded={sourcesOpen}
              aria-controls={sourcesId}
              onClick={() => setSourcesOpen((o) => !o)}
            >
              <ChevronDown aria-hidden="true" className={`size-3.5 shrink-0 transition-transform ${sourcesOpen ? 'rotate-180' : ''}`} />
              <span className="min-w-0 truncate">
                Sources ({item.sources.length}){item.sources.length ? `: ${item.sources.map((s) => s.ref).join(', ')}` : ''}
                {item.sourceChanged && <span className="font-medium text-pending"> · changed since</span>}
              </span>
            </button>
          ) : (
            <p className="min-w-0 truncate text-xs text-ink-muted">No record item is cited.</p>
          )}
        </div>
        {/* The decision: one row that never wraps. */}
        <div className="col-start-2 row-start-2 flex flex-nowrap items-center justify-end gap-1.5 empty:hidden @[45rem]/stmt:row-span-2 @[45rem]/stmt:row-start-1">
          {!decided &&
            (editing ? (
              <>
                <Button size="sm" className="shrink-0 px-2.5!" icon={icon(<Check aria-hidden="true" className="size-4" />)} loading={review.isPending} disabled={!text.trim() || blocked} onClick={() => act('edited')}>
                  Save edited text
                </Button>
                <Button size="sm" variant="ghost" className="shrink-0 px-2.5!" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="subtle"
                  className="shrink-0 px-2.5!"
                  icon={icon(<Check aria-hidden="true" className="size-4" />)}
                  loading={review.isPending && review.variables?.body.action === 'accepted'}
                  disabled={blocked}
                  onClick={() => act('accepted')}
                >
                  Accept
                </Button>
                <Button size="sm" variant="secondary" className="shrink-0 px-2.5!" icon={icon(<Pencil aria-hidden="true" className="size-4" />)} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 px-2.5!"
                  icon={icon(<X aria-hidden="true" className="size-4" />)}
                  loading={review.isPending && review.variables?.body.action === 'rejected'}
                  onClick={() => act('rejected')}
                >
                  Reject
                </Button>
              </>
            ))}
          {canAdd && only && (
            <Button size="sm" variant="secondary" className="shrink-0 px-2.5!" loading={adding} icon={icon(<Plus aria-hidden="true" className="size-4" />)} onClick={() => void add()}>
              Add to note
            </Button>
          )}
        </div>
      </div>
      {hasDetails && (
        <div id={sourcesId} hidden={!sourcesOpen} className="mt-1.5 space-y-1.5 border-t border-line pt-1.5 text-xs">
          {item.rationale && <p className="text-ink-muted">Why the AI listed this: {item.rationale}</p>}
          {item.uncertainty && <p className="text-ink-muted">Uncertain: {item.uncertainty} (the AI’s own words, not a measured probability)</p>}
          {item.sources.length > 0 ? <SourceList item={item} /> : <p className="text-ink-muted">No record item is cited.</p>}
        </div>
      )}
      {canAdd && only && <p className="mt-1 text-xs text-ink-muted">Goes into the note’s {only.label} section, where you can change it.</p>}
      {canAdd && !only && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <SelectField label="Add to note section" value={target} onChange={(e) => setTarget(e.target.value as keyof NoteFields)} className="min-w-0 flex-1">
            {sections.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <Button size="sm" variant="secondary" loading={adding} icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => void add()}>
            Add to note
          </Button>
        </div>
      )}
    </li>
  )
}

/**
 * One group of the draft, a region named by its title. A long group shows the first statements of each part and folds the rest behind
 * "Show n more" (folded statements stay mounted, so a half-made edit is never lost; a CONFLICTING one is never folded).
 */
function GroupSection({
  title,
  sections,
  items,
  heading,
  conflicts,
  encounterId,
  inserter,
  children,
}: {
  title: string
  sections: readonly ConsultSection[]
  items: ConsultItem[]
  heading: Level | null
  conflicts: RecordFinding[]
  encounterId: string
  inserter: NoteInserter
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const folded = foldedIds(items)
  // The parts of the group other than the one its title already names ("Current problem" holds "Symptoms" and "Observations").
  const parts = sections
    .filter((s) => items.some((i) => i.section === s))
    .map((s) => CONSULT_SECTIONS[s])
    .filter((label) => label.toLowerCase() !== title.toLowerCase())
  return (
    <section aria-label={title} className="space-y-2" data-testid={`group-${title.toLowerCase().replace(/\W+/g, '-')}`}>
      {heading && (
        <Heading level={heading} className="text-sm font-semibold">
          {title}
        </Heading>
      )}
      {sections.length > 1 && items.length > 0 && parts.length > 0 && <p className="text-xs text-ink-muted">{parts.join(' · ')}</p>}
      {children}
      {items.length > 0 && (
        <ul id={listId} className="divide-y divide-line border-y border-line">
          {items.map((i) => (
            <StatementCard key={i.id} item={i} conflicts={conflicts} encounterId={encounterId} inserter={inserter} hidden={!open && folded.has(i.id)} />
          ))}
        </ul>
      )}
      {folded.size > 0 && (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={listId}
          icon={<ChevronDown aria-hidden="true" className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />}
          onClick={() => setOpen((o) => !o)}
          data-testid="group-show-more"
        >
          {open ? 'Show fewer' : `Show ${folded.size} more`}
          <span className="sr-only"> in {title}</span>
        </Button>
      )}
    </section>
  )
}

/**
 * How many disagreements between sources the fixed rules of the consultation overview found. It only OBSERVES the overview's own read (same key,
 * same answer, never enabled): no request and no audit entry of its own. Null while the overview has not read.
 */
function useContextConflicts(encounterId: string): number | null {
  const q = useQuery({
    queryKey: contextKey(encounterId),
    queryFn: async () => ConsultationContext.parse(await api<unknown>(`/encounters/${encounterId}/context`)),
    enabled: false,
  })
  return q.data && q.data.encounterId === encounterId ? q.data.conflicts.length : null
}

/**
 * The draft under the brief's headings: AI summary; Important findings; Conflicts & uncertainties; Missing information; AI-assisted
 * recommendations. Each heading says how many statements it holds and how many wait for a decision; a heading with nothing under it says so.
 * Statements the fixed rules found are kept apart and labelled as theirs.
 */
function DraftBody({
  draft,
  encounterId,
  inserter,
  excludeMedication,
  level,
  onShowOverview,
  reveal = false,
}: {
  draft: ConsultDraft
  encounterId: string
  inserter: NoteInserter
  excludeMedication: boolean
  level: 2 | 3
  onShowOverview?: () => void
  /** The draft has just arrived on this screen: its headings fade in one after another (presentation of what arrived; none with reduced motion). */
  reveal?: boolean
}) {
  const itemsOf = (g: GroupKey) => {
    const { sections } = GROUPS[g]
    return draft.items.filter((i) => sections.includes(i.section)).sort((a, b) => sections.indexOf(a.section) - sections.indexOf(b.section) || a.position - b.position)
  }
  const shown = excludeMedication ? draft.items.filter((i) => i.section !== MEDICATION) : draft.items
  const pending = shown.filter((i) => i.decision === 'pending').length
  const conflicting = shown.filter((i) => i.support === 'conflicting').length
  const elsewhere = excludeMedication ? medicationConsiderations(draft).length : 0
  const pendingElsewhere = excludeMedication ? medicationConsiderations(draft).filter((i) => i.decision === 'pending').length : 0
  const contextConflicts = useContextConflicts(encounterId)
  const conflictsFromRules = draft.recordCheck.conflicts.length + draft.recordCheck.outdated.length
  const blockLevel = (level + 1) as Level
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-muted tabular-nums" data-testid="consult-counts">
        {statements(shown.length + elsewhere)} from the AI
        {shown.length + elsewhere > 0 ? ` · ${pending + pendingElsewhere > 0 ? `${pending + pendingElsewhere} to review` : 'all decided'}` : ''}
        {elsewhere > 0 ? ` · ${elsewhere} of them with the prescription` : ''}
      </p>
      <div className="space-y-5">
        {BLOCKS.map((b, blockIndex) => {
          const groups = b.groups.filter((k) => !(excludeMedication && k === 'medication')).map((k) => ({ key: k, ...GROUPS[k], items: itemsOf(k) }))
          const items = groups.flatMap((g) => g.items)
          const waiting = items.filter((i) => i.decision === 'pending').length
          const notes: ReactNode[] = []
          if (b.key === 'conflicts' && conflicting > 0)
            notes.push(
              <p key="conflicting" className="text-sm" data-testid="consult-conflicting">
                <Badge tone="down" dot>
                  {SUPPORT_STATES.conflicting.toUpperCase()}
                </Badge>{' '}
                {conflicting === 1 ? '1 statement rests' : `${conflicting} statements rest`} on record items that disagree; each is marked where it is listed.
              </p>,
            )
          if (b.key === 'conflicts' && contextConflicts)
            notes.push(
              <div key="context" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm" data-testid="consult-context-conflicts">
                <p className="min-w-0">
                  {contextConflicts === 1 ? '1 disagreement between sources, found by fixed rules, is' : `${contextConflicts} disagreements between sources, found by fixed rules, are`} listed in the Consultation overview.
                </p>
                {onShowOverview && (
                  <Button size="sm" variant="secondary" onClick={onShowOverview}>
                    Go to the overview
                  </Button>
                )}
              </div>,
            )
          if (b.key === 'recommendations' && elsewhere > 0)
            notes.push(
              <p key="medication" className="text-xs text-ink-muted" data-testid="consult-medication-elsewhere">
                {elsewhere === 1 ? '1 medication consideration is' : `${elsewhere} medication considerations are`} shown with the prescription, under “Before you prescribe”.
              </p>,
            )
          const sections = groups.map((g) => {
            // What the fixed rules found is shown with the AI's own conflicts and its list of what is missing: the model names little of it.
            const rules = g.key === 'uncertainties' && conflictsFromRules > 0
            const missingFromRules = g.key === 'missing' && draft.recordCheck.missing.length > 0
            if (!g.items.length && !rules && !missingFromRules) return null
            return (
              <GroupSection
                key={g.key}
                title={g.title}
                sections={g.sections}
                items={g.items}
                heading={b.groups.length > 1 ? ((blockLevel + 1) as Level) : null}
                conflicts={draft.recordCheck.conflicts}
                encounterId={encounterId}
                inserter={inserter}
              >
                {rules && (
                  <div className="space-y-3 border-l-2 border-line-strong py-1 pl-3">
                    <p className="text-xs text-ink-muted">Found by fixed rules, not by the AI.</p>
                    <Findings title="Conflicts" tone="down" items={draft.recordCheck.conflicts} />
                    <Findings title="Possibly out of date" tone="warn" items={draft.recordCheck.outdated} />
                  </div>
                )}
                {missingFromRules && (
                  <div className="space-y-3 border-l-2 border-line-strong py-1 pl-3" data-testid="rules-missing">
                    <p className="text-xs text-ink-muted">Found by fixed rules, not by the AI.</p>
                    <Findings title="Not recorded" tone="neutral" items={draft.recordCheck.missing} />
                  </div>
                )}
              </GroupSection>
            )
          })
          const empty = sections.every((s) => s === null) && !notes.length
          return (
            <div
              key={b.key}
              className={`space-y-3 border-t border-line pt-4 first:border-t-0 first:pt-0 ${reveal ? 'motion-safe:animate-rise-in' : ''}`}
              // In order, 60 ms apart; each settles in 180 ms. The words are all there from the first frame for assistive technology.
              style={reveal ? { animationDelay: `${blockIndex * REVEAL_STEP_MS}ms` } : undefined}
              data-testid="consult-block"
              data-block={b.key}
              data-reveal={reveal || undefined}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Heading level={blockLevel} className="text-base font-semibold">
                  {b.title}
                </Heading>
                {items.length > 0 && (
                  <span className="text-xs text-ink-muted tabular-nums">
                    {statements(items.length)}
                    {waiting > 0 ? ` · ${waiting} to review` : ''}
                  </span>
                )}
              </div>
              {sections}
              {notes}
              {empty && <p className="text-sm text-ink-muted">{emptyText(b.key, excludeMedication)}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** What a heading with nothing under it says: what the AI did not write and, where the fixed rules look too, what they did not find. */
function emptyText(key: BlockKey, excludeMedication: boolean): string {
  if (key === 'summary') return 'The AI wrote no summary in this draft.'
  if (key === 'findings') return 'The AI wrote nothing about the current problem or the history.'
  if (key === 'conflicts') return 'The AI listed no uncertainty, and the fixed rules found no conflict or old item.'
  if (key === 'missing') return 'The AI listed nothing as missing, and the fixed rules found nothing that is not recorded.'
  return excludeMedication ? 'The AI suggested no consideration or investigation.' : 'The AI suggested no consideration, investigation or medication consideration.'
}

function DraftFacts({ draft }: { draft: ConsultDraft }) {
  const v = draft.validation
  const time = draftTiming(draft)
  // The wait and the writing only for a draft that finished with statements, and only when the server's three times read in order.
  const split = (draft.status === 'ready' || draft.status === 'partial') && time.waited && time.writing ? { waited: time.waited, writing: time.writing } : null
  return (
    <details className="group/facts text-xs text-ink-muted" data-testid="draft-facts">
      <summary className="inline-flex min-h-control-sm cursor-pointer list-none items-center gap-1 rounded-md hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/facts:rotate-180" />
        How this draft was made
      </summary>
      <ul className="mt-1.5 space-y-0.5">
        <li>
          Draft {draft.version} · made {fmtDateTime(draft.createdAt)}
          {draft.requestedByName ? ` for ${draft.requestedByName}` : ''}
          {time.took ? ` · took ${time.took}` : ''}
        </li>
        {split && (
          <li className="tabular-nums" data-testid="draft-timing">
            Waited {split.waited} for the local model, then {split.writing} writing and checks (the server’s own times).
          </li>
        )}
        {draft.model && (
          <li>
            Model {draft.model.model} ({draft.model.provider}, {draft.model.local ? 'runs on this computer' : 'NOT on this computer'}
            {draft.model.weightsSha256 ? `, weights SHA-256 ${draft.model.weightsSha256.slice(0, 12)}…` : ''})
          </li>
        )}
        <li>
          Prompt {draft.promptVersion} · output form {draft.schemaVersion} · record rules {draft.rulesVersion}
        </li>
        <li>
          {draft.sourceCount} record item(s) were shown to the AI
          {draft.omittedCount > 0 ? `; ${draft.omittedCount} item(s) did not fit and were not shown (older and less central ones go first)` : ''}. Only points you confirmed were used; rejected and unreviewed points, the transcript and the
          audio were not.
        </li>
        {v && (
          <li>
            {v.produced} statement(s) came back; {v.kept} kept
            {v.removed > 0 ? `, ${v.removed} removed because they could not be verified against the record` : ''}
            {v.flagged > 0 ? `, ${v.flagged} marked for a check` : ''}.
          </li>
        )}
      </ul>
    </details>
  )
}

/**
 * What a draft is made from, in one line under the status. The number of points the doctor confirmed is read from the copy of the
 * consultation's AI state that the capture panel keeps; this never asks the server for it (`enabled: false`), and without that copy the number is left out.
 */
function DraftInputs({ encounterId }: { encounterId: string }) {
  const capture = useQuery({
    queryKey: aiKey(encounterId),
    queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`),
    enabled: false,
  })
  const n = capture.data ? capture.data.facts.filter((f) => factState(f.status) === 'confirmed').length : null
  return (
    <p className="text-xs text-ink-muted" data-testid="consult-inputs">
      {n === 0
        ? 'A draft is made from this patient’s record and your note for this visit, never from the raw transcript or the audio. No important point is confirmed yet: confirming them first gives the draft more to work with.'
        : `A draft is made from this patient’s record, your note for this visit and ${n === null ? 'the important points' : `the ${n} important point${n === 1 ? '' : 's'}`} you confirmed, never from the raw transcript or the audio.`}
    </p>
  )
}

// --- the panel -------------------------------------------------------------------------------------------------------------------------------

export interface ConsultationIntelligenceProps {
  encounterId: string
  inserter: NoteInserter
  /**
   * What stands where this panel's own "Generate draft" / "Try again" / "Generate a new draft" button is (the page's analysis, or nothing).
   * Given (null included), it replaces that button in every state and the panel's own elapsed clock (the analysis keeps time from the click);
   * Cancel stays while a draft is being made. Left out, the panel keeps its own button.
   */
  analyzeSlot?: ReactNode
  /** Leaves the medication considerations out of this card: the prescription's "Before you prescribe" lane shows them. */
  excludeMedication?: boolean
  /** The level of the card's heading: 2, or 3 inside an area with its own h2. The brief's headings are one level below it, the groups two. */
  headingLevel?: 2 | 3
  title?: string
  /** Leads to the consultation overview, where the disagreements its fixed rules found are listed; without it the overview is named in words. */
  onShowOverview?: () => void
  /** The fixed rules' record check before any draft is shown by the page's consultation overview, not in this card. */
  recordCheckElsewhere?: boolean
  /** Drawn where the draft's statements will be while it is being made (the page's placeholders for the sections: layout only, no text). */
  whileGenerating?: ReactNode
}

export function ConsultationIntelligence({
  encounterId,
  inserter,
  analyzeSlot,
  excludeMedication = false,
  headingLevel = 2,
  title: titleText = 'Consultation intelligence',
  onShowOverview,
  recordCheckElsewhere = false,
  whileGenerating,
}: ConsultationIntelligenceProps) {
  const toast = useToast()
  const q = useConsultationAi(encounterId)
  const generate = useGenerateDraft(encounterId)
  const cancel = useCancelDraft(encounterId)
  const slotted = analyzeSlot !== undefined
  const [aboutOpen, setAboutOpen] = useState(false)
  const aboutId = useId()
  // A draft seen being made on this screen and now finished is revealed once, section by section (decided while drawing, so it is never
  // drawn first without the reveal). One found finished (on opening the page, after another draft) is simply shown.
  const shownId = q.data?.draft?.id ?? null
  const shownGenerating = q.data?.draft?.status === 'generating'
  const [seen, setSeen] = useState<{ id: string | null; generating: boolean }>({ id: shownId, generating: shownGenerating })
  const [revealId, setRevealId] = useState<string | null>(null)
  if (seen.id !== shownId || seen.generating !== shownGenerating) {
    if (seen.generating && seen.id === shownId && !shownGenerating) setRevealId(shownId)
    setSeen({ id: shownId, generating: shownGenerating })
  }
  const title = (
    <span className="inline-flex items-center gap-2">
      <BrainCircuit aria-hidden="true" className="size-4 text-ai" />
      {titleText}
    </span>
  )
  if (q.isPending)
    return (
      <Card title={title} level={headingLevel}>
        <Spinner />
      </Card>
    )
  if (q.isError)
    return (
      <Card title={title} level={headingLevel}>
        <Alert tone="error">{errorMessage(q.error)}</Alert>
      </Card>
    )
  const ai = q.data
  const draft = ai.draft
  const view = draftView(draft, ai.status.available)
  const check = draft?.recordCheck ?? ai.recordCheck
  const regenerate = () =>
    generate.mutate(undefined, {
      onError: (e) => toast('error', errorMessage(e)),
    })
  // With nothing else in the way, the server gives the model's own reason as what stops a new draft: that is said once, in the alert about the model.
  // Anything else (the visit is closed, the consent is missing or old) is said as well, whether or not the model is there.
  const modelReason = ai.status.available ? null : (ai.status.reason ?? UNAVAILABLE)
  const blocked = ai.blockedReason && ai.blockedReason !== modelReason && ai.blockedReason !== UNAVAILABLE ? ai.blockedReason : null
  const why = beyondTitle(modelReason)
  // A draft that ended because the model was not there is told in that same alert, and only if it adds something to it.
  const draftWhy = draft?.status === 'unavailable' ? beyondTitle(draft.errorMessage) : null
  const body = !!draft && showsStatements(draft)
  // Before the first draft there is nothing of the model's to label: the card says so in one line, with the model a draft would come from.
  // The AI panel always says what it is, before a draft as after: the labels describe what the panel holds and will hold.
  const labelled = true
  const status = (
    <span data-testid="consult-status">
      <Badge tone={VIEW_TONE[view]} dot>
        {DRAFT_VIEW_LABEL[view]}
      </Badge>
    </span>
  )
  return (
    <Card title={title} level={headingLevel}>
      {/* The status stays inside the region (consult-panel), where everything that reads the draft's state looks for it. */}
      <div className="space-y-4" role="region" aria-label="AI consultation intelligence" data-testid="consult-panel" data-view={view}>
        {labelled ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="flex flex-wrap items-center gap-1.5" aria-label="What this is">
              <Badge tone="ai">AI DRAFT</Badge>
              <Badge tone="ai">AI-GENERATED</Badge>
              <Badge tone="warn">REQUIRES DOCTOR REVIEW</Badge>
            </span>
            <span className="ml-auto">{status}</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {view === 'not_run' && (
              <p className="text-sm text-ink-muted" data-testid="consult-not-run">
                No Mana result yet. When the inputs are ready, use Analyze with Mana.
              </p>
            )}
            <span className="ml-auto">{status}</span>
          </div>
        )}
        {/* Where the draft comes from, in one line; the full wording on demand (once there is a draft to say it of). */}
        <div className={labelled ? '' : '-mt-3'}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <p className="min-w-0 text-xs text-ink-muted" data-testid="consult-provenance">
              {ai.status.available && (
                <>
                  <span data-testid="consult-model">
                    {ai.status.local ? `Local model ${ai.status.model} · on this computer, nothing leaves it` : `Hosted model ${ai.status.model} · NOT on this computer${ai.egress.destination ? ` (${ai.egress.destination})` : ''}`}
                  </span>
                  {' · '}
                </>
              )}
              Not clinically validated
            </p>
            {labelled && (
              <button
                type="button"
                className="inline-flex min-h-control-sm items-center gap-1 rounded-md text-xs font-medium text-brand-strong hover:underline"
                aria-expanded={aboutOpen}
                aria-controls={aboutId}
                onClick={() => setAboutOpen((o) => !o)}
                data-testid="consult-about-toggle"
              >
                <Info aria-hidden="true" className="size-3.5" />
                About this draft
              </button>
            )}
          </div>
          <div id={aboutId} hidden={!aboutOpen} className="mt-1 space-y-1.5 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-muted" data-testid="consult-about">
            <p>
              Made by a language model from what is said below. Nothing is added to the note, the diagnoses or the prescription until you accept a statement and add it yourself. Not clinically validated. “Supported by record” means the
              cited record items contain the statement’s words and figures; it does not mean the statement is right, so read the items.
              {ai.status.available && ai.status.local ? ' The model runs on this computer and nothing leaves it.' : ''}
            </p>
            <DraftInputs encounterId={encounterId} />
          </div>
        </div>

        {((view === 'generating' && !!draft) || !slotted || !!analyzeSlot) && (
          <div className="flex flex-wrap items-center gap-2">
            {view === 'generating' && draft && (
              <span className="text-xs text-ink-muted" role="status" data-testid="consult-progress">
                {draft.phase === 'queued' ? 'Waiting for the local model' : 'The local model is writing the draft'}
                {slotted ? (
                  ' '
                ) : (
                  <>
                    {' '}
                    · <Elapsed since={draft.createdAt} />{' '}
                  </>
                )}
                (it can take a few minutes on this computer)
              </span>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {view === 'generating' && draft && (
                <Button size="sm" variant="secondary" icon={<X aria-hidden="true" className="size-4" />} loading={cancel.isPending} onClick={() => cancel.mutate(draft.id)}>
                  Cancel
                </Button>
              )}
              {slotted
                ? analyzeSlot
                : view !== 'generating' && (
                    <Button size="sm" icon={<RefreshCw aria-hidden="true" className="size-4" />} loading={generate.isPending} disabled={!ai.canGenerate} onClick={regenerate}>
                      {draft ? (view === 'failed' || view === 'cancelled' || view === 'unavailable' ? 'Try again' : 'Generate a new draft') : 'Generate draft'}
                    </Button>
                  )}
            </span>
          </div>
        )}

        {!ai.status.available && (
          <Alert tone="warning" title={UNAVAILABLE}>
            <span data-testid="consult-unavailable">{why ? `${why} ` : ''}No draft is made without it, and nothing is made up.</span> The record check below does not need AI.
            {draftWhy && draftWhy !== why && (
              <span className="mt-1 block">
                The last attempt: <span data-testid="consult-error">{draftWhy}</span>
              </span>
            )}
            <div className="mt-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden="true" className="size-4" />} loading={q.isFetching} onClick={() => void q.refetch()}>
                Check again
              </Button>
            </div>
          </Alert>
        )}
        {blocked && (
          <Alert tone="info">
            <span data-testid="consult-blocked">{blocked}</span>
          </Alert>
        )}
        {generate.isError && (
          <Alert tone="error" title="The draft could not be started">
            {errorMessage(generate.error)}
          </Alert>
        )}
        {draft && (draft.status === 'failed' || draft.status === 'cancelled') && (
          <Alert tone={draft.status === 'cancelled' ? 'info' : 'error'} title={draft.status === 'cancelled' ? 'Cancelled' : view === 'unavailable' ? 'The last attempt failed' : 'The draft could not be made'}>
            <span data-testid="consult-error">{draft.errorMessage ?? 'The draft could not be made.'}</span> {draft.retryable && !/try again|retry/i.test(draft.errorMessage ?? '') ? 'You can try again.' : ''}
          </Alert>
        )}
        {/* With the model there again, what ended this draft is history: the title says so instead of saying the model is unavailable. */}
        {draft?.status === 'unavailable' && ai.status.available && (
          <Alert tone="warning" title="The last attempt could not use the local AI">
            <span data-testid="consult-error">{draft.errorMessage}</span>
          </Alert>
        )}
        {view === 'insufficient' && (
          <Alert tone="info" title="Insufficient information">
            {draft?.model ? 'The AI said there is too little recorded for this consultation to draft from.' : 'There is too little recorded for this consultation for the AI to draft from, so it was not asked.'} Add the reason for the visit,
            your notes or the points from the conversation, then {slotted ? 'use Analyze again' : 'generate a new draft'}. The record check below says what is missing.
          </Alert>
        )}
        {ai.lastAttempt && draft && (view === 'ready' || view === 'partial' || view === 'stale' || view === 'insufficient') && (
          <Alert tone={ai.lastAttempt.status === 'cancelled' ? 'info' : 'warning'} title="The newest attempt did not finish">
            <span data-testid="consult-last-attempt">{ai.lastAttempt.errorMessage ?? 'The draft could not be made.'}</span> The draft below is the earlier one.
          </Alert>
        )}
        {view === 'partial' && draft && (
          <Alert tone="warning" title="Partially available">
            Some statements the AI wrote were removed because they could not be verified against the record
            {draft.validation ? ` (${draft.validation.removed})` : ''}. What is shown rests on record items you can open.
          </Alert>
        )}
        {draft?.stale && draft.staleSummary && (
          <Alert tone="warning" title="Stale">
            <span data-testid="consult-stale">{draft.staleSummary}</span>
          </Alert>
        )}

        {view === 'generating' && whileGenerating}
        {draft && body && (
          <DraftBody draft={draft} encounterId={encounterId} inserter={inserter} excludeMedication={excludeMedication} level={headingLevel} onShowOverview={onShowOverview} reveal={revealId === draft.id} />
        )}
        {/* The fixed rules' record check is the consultation overview's where the page has one (`recordCheckElsewhere`). */}
        {check && !body && !recordCheckElsewhere && <RecordCheckCard check={check} level={(headingLevel + 1) as Level} />}
        {draft && draft.status !== 'generating' && <DraftFacts draft={draft} />}
        {ai.earlier.length > 0 && <p className="text-xs text-ink-muted">{ai.earlier.length} earlier draft(s) of this consultation are kept in the record; only the newest is shown.</p>}
      </div>
    </Card>
  )
}
