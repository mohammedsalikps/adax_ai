import { type ConsultationContext, type ContextConflict, type Encounter, EVIDENCE_KINDS, type EvidenceItem, type EvidenceKind, type EvidenceTrust } from '@adaxai/contracts'
import { ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { useMe } from '../../lib/auth.tsx'
import {
  clockTime,
  CONTEXT_POLL_MS,
  conflictTargets,
  EVIDENCE_LIMIT,
  type EvidenceTarget,
  exactTime,
  groupPending,
  isLiveDeviceItem,
  type PendingKind,
  pendingNotShown,
  relativeTime,
  reviewNotes,
  serverNow,
  shownStatus,
  type StatusTone,
  statusTone,
  TARGET_LABEL,
  targetElementId,
  targetLabel,
  trustLabel,
  trustTone,
  useConsultationContext,
  useDeviceLiveSeconds,
  visibleEvidence,
} from '../../lib/consultationContext.ts'
import type { PartId } from '../../lib/workspace.ts'
import { Button } from '../ui/Button.tsx'
import { Badge, LoadingState } from '../ui/Feedback.tsx'
import { Card } from '../ui/Layout.tsx'
import { SafetyRules } from '../workspace/SafetyRules.tsx'
import { SimulatedBadge, UnverifiedBadge } from './DeviceReadingsCard.tsx'

/**
 * D2: the consultation's overview, composed by fixed rules, never by AI. What waits for the doctor's review, where two sources disagree, the
 * newest evidence (each item with its kind, its time, its state, how far it can be trusted and where it came from), what is missing, and the
 * summary composed by fixed rules: all from one read of the consultation's context (GET /api/encounters/:id/context), which the server builds
 * from the records that already exist. It shows; it does not decide: no diagnosis or recommendation of its own, no disagreement resolved,
 * nothing made more current or more trusted than the server said, and a SIMULATED mark is never left out. Each item leads to the part of the
 * page that says more (`onJump` is the page's own way there; `revealPart` from lib/workspace.ts also opens a collapsed module). If it cannot be
 * read it says so here, and nothing else on the page (the note included) is affected.
 *
 * Doctor HERO shows it in the Mana area, after the model's result:
 * - `compact` keeps open what needs the doctor (what waits for review, and where sources disagree) and folds the evidence, what is missing
 *   and the summary behind "Show evidence": mounted, only hidden, with a line beside the button that says how much is there and how much of
 *   it is SIMULATED. Without it, everything is shown as before.
 * - `reviewPart` makes the review block the page's `#mana-review` part (the workflow strip's "Your review"); its heading takes the focus.
 *   Only one block on the page may be that part, so the page asks for it.
 * - `safetyRules` shows the fixed safety rules' results (SafetyRules) in this card, after the review block. They come from another read,
 *   so they stay when the overview itself cannot be read. `recordCheck` (the fixed rules' record check before any draft) follows them.
 * - `draftStatements`: the draft's statements that wait, as the page counts them (the same count as the workflow strip and the Mana result),
 *   in place of the count in the overview's own read, which can be a moment older: one number for the same thing on the whole page.
 * - Its heading is an h3 where it stands in an area with its own h2 (`compact`: the Mana area).
 */
export function ConsultationOverview({
  encounter,
  onJump,
  compact = false,
  reviewPart = false,
  safetyRules = false,
  recordCheck,
  draftStatements,
}: {
  encounter: Encounter
  onJump: (part: PartId) => void
  compact?: boolean
  reviewPart?: boolean
  safetyRules?: boolean
  recordCheck?: ReactNode
  draftStatements?: number | null
}) {
  const q = useConsultationContext(encounter.id)
  const liveSeconds = useDeviceLiveSeconds(encounter.patient.id)
  const { data: me } = useMe()
  const [showAll, setShowAll] = useState(false)
  // An answer about another encounter or another patient is never drawn: it would be someone else's record.
  const c = q.data && q.data.encounterId === encounter.id && q.data.patientId === encounter.patient.id ? q.data : null
  // Ages the times on the screen; every second while a device value is LIVE, so that it turns STALE when the device card's does.
  useTick(c?.evidence.some(isLiveDeviceItem) ? 1000 : CONTEXT_POLL_MS)
  // A stethoscope recording leads to the Stethoscope module whatever target the server gave it; the pending groups and conflicts have no kind.
  const jump = (t: EvidenceTarget, kind?: EvidenceKind) => onJump(targetElementId(t, kind))
  const readAt = c ? clockTime(c.generatedAt) : null
  const rules =
    safetyRules || recordCheck ? (
      <>
        {safetyRules && <SafetyRules encounterId={encounter.id} />}
        {recordCheck && <div className={safetyRules ? 'mt-5' : undefined}>{recordCheck}</div>}
      </>
    ) : null
  // The evidence, what is missing and the summary: shown as they are, or behind "Show evidence" in the compact overview.
  const details = c && (
    <>
      <EvidenceBlock c={c} now={serverNow(c.generatedAt, q.dataUpdatedAt, Date.now())} liveSeconds={liveSeconds} showAll={showAll} onToggle={() => setShowAll((s) => !s)} jump={jump} />
      {c.missing.length > 0 && (
        <div data-testid="overview-missing">
          <h3 className="text-sm font-semibold">Missing</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {c.missing.map((m, i) => (
              <li key={i} className="break-words">
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
      <SummaryBlock c={c} />
    </>
  )
  return (
    <div data-testid="consultation-overview">
      <Card
        level={compact ? 3 : 2}
        title="Consultation overview"
        actions={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone="neutral">Fixed rules, not AI</Badge>
            {readAt && <p className="text-xs text-ink-muted">Read at {readAt}</p>}
          </div>
        }
      >
        {q.isPending ? (
          <>
            <LoadingState label="Reading this consultation…" rows={3} />
            {rules && <div className="mt-5 text-sm">{rules}</div>}
          </>
        ) : !c ? (
          <>
            <div role="alert" className="rounded-lg border border-down/20 bg-down-soft px-3 py-3 text-sm text-ink" data-testid="overview-error">
              <p>The overview could not be loaded. The consultation and the note are not affected.</p>
              <Button size="sm" variant="secondary" className="mt-2" loading={q.isFetching} onClick={() => void q.refetch()}>
                Try again
              </Button>
            </div>
            {rules && <div className="mt-5 text-sm">{rules}</div>}
          </>
        ) : (
          <div className="space-y-5 text-sm">
            <p className="text-xs text-ink-muted">From this consultation’s records. Nothing here is a diagnosis or a recommendation.</p>
            {q.isError && (
              <div role="status" className="rounded-lg border border-pending/30 bg-pending-soft px-3 py-2 text-ink" data-testid="overview-not-updated">
                <p>Not updated: the overview could not be read again. What is shown was read at {readAt}. The consultation and the note are not affected.</p>
                <Button size="sm" variant="secondary" className="mt-2" loading={q.isFetching} onClick={() => void q.refetch()}>
                  Try again
                </Button>
              </div>
            )}
            <ReviewBlock c={draftStatements === null || draftStatements === undefined ? c : { ...c, pending: { ...c.pending, draftStatements } }} hidden={pendingNotShown(me, encounter.doctor.id)} jump={jump} part={reviewPart} />
            {rules}
            {compact ? <EvidenceFold note={foldNote(c)}>{details}</EvidenceFold> : details}
          </div>
        )}
      </Card>
    </div>
  )
}

/** What the fold holds, in counts: the evidence items, how many of them are SIMULATED (never out of sight unsaid), and the missing items. */
function foldNote(c: Pick<ConsultationContext, 'evidence' | 'missing'>): string {
  const n = c.evidence.length
  const simulated = c.evidence.filter((i) => trustTone(i.trust) === 'simulated').length
  const evidence = !n ? 'No evidence recorded yet' : `${n} ${n === 1 ? 'item' : 'items'} of evidence${simulated ? ` (${simulated} SIMULATED, not ${simulated === 1 ? 'a measurement' : 'measurements'})` : ''}`
  const m = c.missing.length
  return m ? `${evidence} · ${m} missing ${m === 1 ? 'item' : 'items'}` : evidence
}

/** The compact overview's fold: closed until opened, always mounted (only hidden), and not remembered. */
function EvidenceFold({ note, children }: { note: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const noteId = useId()
  return (
    <div data-testid="overview-fold" data-open={open}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          variant="secondary"
          icon={<ChevronRight aria-hidden="true" className={`size-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-describedby={noteId}
          onClick={() => setOpen((o) => !o)}
          data-testid="overview-show-evidence"
        >
          {open ? 'Hide evidence' : 'Show evidence'}
        </Button>
        <p id={noteId} className="min-w-0 text-xs break-words text-ink-muted">
          {note}
        </p>
      </div>
      <div id={bodyId} hidden={!open} className="mt-4 space-y-5">
        {children}
      </div>
    </div>
  )
}

/** Renders again every `ms`, so that what is aged on the screen moves on between two reads. */
function useTick(ms: number) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [ms])
}

/**
 * What waits for the doctor (each count leads to where it is reviewed) and where two sources disagree (each leads to both sides). That nothing
 * waits is said only when every kind was counted: a kind that could not be read, or is not shown to this viewer, is said instead. As the
 * page's `#mana-review` part (`part`), its heading is where a jump there puts the focus.
 */
function ReviewBlock({ c, hidden, jump, part }: { c: ConsultationContext; hidden: readonly PendingKind[]; jump: (t: EvidenceTarget) => void; part: boolean }) {
  const groups = groupPending(c.pending)
  const notes = reviewNotes(c.pending, c.conflicts.length, hidden)
  return (
    <div data-testid="overview-review" id={part ? 'mana-review' : undefined}>
      <h3 className="text-sm font-semibold" tabIndex={part ? -1 : undefined} data-part-focus={part ? 'mana-review' : undefined}>
        Needs your review
      </h3>
      {notes.nothingWaiting && <p className="mt-1 text-ink-muted">Nothing is waiting for your review.</p>}
      {notes.incomplete && (
        <p className="mt-1 break-words text-ink" data-testid="pending-incomplete">
          {notes.incomplete}
        </p>
      )}
      {notes.notShown && (
        <p className="mt-1 break-words text-ink-muted" data-testid="pending-not-shown">
          {notes.notShown}
        </p>
      )}
      {groups.length > 0 && (
        <ul className="mt-1 divide-y divide-line border-y border-line">
          {groups.map((g) => (
            <li key={g.target}>
              <button
                type="button"
                onClick={() => jump(g.target)}
                className="flex min-h-control w-full items-center justify-between gap-2 rounded-md px-1 py-1.5 text-left font-medium hover:bg-canvas"
                data-testid="pending-review"
                data-target={g.target}
              >
                <span className="min-w-0 break-words">
                  {g.text}
                  <span className="sr-only">, in {TARGET_LABEL[g.target]}</span>
                </span>
                <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5 text-xs font-normal text-ink-muted">
                  {TARGET_LABEL[g.target]}
                  <ChevronRight className="size-4" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {c.conflicts.length > 0 && (
        <ul className="mt-2 space-y-2">
          {c.conflicts.map((k) => (
            <ConflictRow key={k.id} conflict={k} targets={conflictTargets(k, c.evidence)} jump={jump} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** A disagreement in words first (amber repeats it), with the rule that found it; never resolved here: both sides are where the doctor looks. */
function ConflictRow({ conflict, targets, jump }: { conflict: ContextConflict; targets: EvidenceTarget[]; jump: (t: EvidenceTarget) => void }) {
  return (
    <li className="rounded-lg border border-pending/30 bg-pending-soft px-3 py-2 text-ink" data-testid="context-conflict" data-kind={conflict.kind}>
      <p className="break-words">
        <span className="font-semibold">Sources disagree.</span> {conflict.text}
      </p>
      <p className="mt-0.5 text-xs break-words text-ink-muted">Found by a fixed rule ({conflict.rule}). Not resolved: each side is shown as it was recorded.</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {targets.map((t) => (
          <Button key={t} size="sm" variant="secondary" onClick={() => jump(t)}>
            {targets.length > 1 ? `View ${TARGET_LABEL[t]}` : 'View'}
            <span className="sr-only">{targets.length > 1 ? ' for this disagreement' : ` in ${TARGET_LABEL[t]}`}</span>
          </Button>
        ))}
      </div>
    </li>
  )
}

/** The newest items, one compact row each; "Show all" lists the rest, and says when a SIMULATED item is among those not listed. */
function EvidenceBlock({ c, now, liveSeconds, showAll, onToggle, jump }: { c: ConsultationContext; now: number; liveSeconds: number | null; showAll: boolean; onToggle: () => void; jump: (t: EvidenceTarget, kind?: EvidenceKind) => void }) {
  const listId = useId()
  const { shown, hiddenSimulated } = visibleEvidence(c.evidence, showAll)
  return (
    <div data-testid="overview-evidence">
      <h3 className="text-sm font-semibold">Evidence</h3>
      {!c.evidence.length ? (
        <p className="mt-1 text-ink-muted">Nothing is recorded in this consultation yet.</p>
      ) : (
        <>
          <ul id={listId} className="mt-2 space-y-2">
            {shown.map((i) => (
              <EvidenceRow key={i.id} item={i} now={now} generatedAt={c.generatedAt} liveSeconds={liveSeconds} onView={() => jump(i.target, i.kind)} />
            ))}
          </ul>
          {c.evidence.length > EVIDENCE_LIMIT && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <Button size="sm" variant="ghost" aria-expanded={showAll} aria-controls={listId} onClick={onToggle} data-testid="evidence-show-all">
                {showAll ? 'Show fewer' : `Show all (${c.evidence.length})`}
              </Button>
              {hiddenSimulated > 0 && (
                <p className="text-xs" data-testid="evidence-hidden-simulated">
                  {hiddenSimulated === 1 ? '1 item not listed is SIMULATED, not a measurement.' : `${hiddenSimulated} items not listed are SIMULATED, not measurements.`}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EvidenceRow({ item, now, generatedAt, liveSeconds, onView }: { item: EvidenceItem; now: number; generatedAt: string; liveSeconds: number | null; onView: () => void }) {
  const { status, asOfRead } = shownStatus(item, now, liveSeconds)
  const ago = relativeTime(item.at, now)
  const exact = exactTime(item.at, now)
  const simulated = trustTone(item.trust) === 'simulated'
  return (
    <li className={`rounded-lg border px-3 py-2 ${simulated ? 'border-dashed border-ink/50' : 'border-line'}`} data-testid="evidence-item" data-kind={item.kind} data-trust={item.trust} data-status={status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-ink-muted">
            <span className="font-medium text-ink">{EVIDENCE_KINDS[item.kind]}</span>
            {' · '}
            {ago && exact ? (
              <>
                <time dateTime={item.at} title={exact}>
                  {ago}
                </time>
                <span className="sr-only">, at {exact}</span>
              </>
            ) : (
              'time not recorded'
            )}
          </p>
          <p className="mt-0.5 font-medium break-words">{item.title}</p>
          {item.detail && <p className="text-xs break-words text-ink-muted">{item.detail}</p>}
          <p className="text-xs break-words text-ink-muted">
            {item.source}
            {item.provenance && ` · ${item.provenance}`}
          </p>
        </div>
        <Button size="sm" variant="ghost" className="shrink-0" onClick={onView}>
          View
          <span className="sr-only">
            {' '}
            {item.title} in {targetLabel(item.target, item.kind)}
          </span>
        </Button>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <StatusChip tone={statusTone(item.kind, status)} status={status} />
        {asOfRead && <span className="text-xs text-ink-muted">when read at {clockTime(generatedAt)}</span>}
        <TrustMark trust={item.trust} />
      </p>
    </li>
  )
}

/** A device value's states in their device-card colours (the word is always there); every other state, and every other kind's, neutral. */
const STATUS_STYLE: Record<StatusTone, string> = {
  live: 'bg-ok-soft text-ok border-ok/20',
  stale: 'bg-pending-soft text-pending border-pending/20',
  disconnected: 'bg-down-soft text-down border-down/20',
  plain: 'border-line bg-canvas text-ink-muted',
}

function StatusChip({ tone, status }: { tone: StatusTone; status: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.6875rem] leading-4 font-semibold whitespace-nowrap ${STATUS_STYLE[tone]}`} data-testid="evidence-status" data-tone={tone}>
      {tone === 'live' && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      {status}
    </span>
  )
}

/** The words of each trust that is not a badge: AI output in the AI colour, a rule-extracted point to review in the to-review colour, the others muted. */
const TRUST_WORDS_STYLE: Record<'ai' | 'review' | 'plain', string> = {
  ai: 'font-medium text-ai',
  review: 'font-medium text-pending',
  plain: 'text-ink-muted',
}

/** How far an item can be trusted: SIMULATED with the device card's dashed edge, UNVERIFIED with its solid one, the others in words. */
function TrustMark({ trust }: { trust: EvidenceTrust }) {
  const tone = trustTone(trust)
  return (
    <span className="inline-flex max-w-full" data-testid="trust-mark" data-trust={trust}>
      {tone === 'simulated' ? (
        <SimulatedBadge compact what={trustLabel(trust)} />
      ) : tone === 'unverified' ? (
        <UnverifiedBadge compact />
      ) : (
        <span className={`text-xs ${TRUST_WORDS_STYLE[tone]}`}>{trustLabel(trust)}</span>
      )}
    </span>
  )
}

/** The summary composed by fixed rules, closed until opened: each statement with how far it can be trusted. */
function SummaryBlock({ c }: { c: ConsultationContext }) {
  return (
    <details className="group rounded-lg border border-line" data-testid="overview-summary">
      <summary className="flex min-h-control cursor-pointer list-none items-center gap-2 px-3 font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
        Summary of this consultation
      </summary>
      <div className="space-y-3 border-t border-line px-3 py-3">
        <p className="text-xs text-ink-muted">Composed by fixed rules from this consultation&apos;s records, not by AI. Advisory: the doctor decides.</p>
        {c.summary.sections.map((s) => (
          <div key={s.key} data-testid="summary-section" data-key={s.key}>
            <h4 className="text-sm font-semibold">{s.title}</h4>
            {s.statements.length ? (
              <ul className="mt-1 space-y-1.5">
                {s.statements.map((st, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words">{st.text}</span>
                    <TrustMark trust={st.trust} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-ink-muted">Nothing recorded.</p>
            )}
          </div>
        ))}
        <p className="text-xs break-words text-ink-muted">
          Rules: {c.summary.composer}; disagreements: {c.rules.conflicts}.
        </p>
      </div>
    </details>
  )
}
