import { type EncounterAi, type Recommendation, RECOMMENDATION_KINDS, type RecommendationKind } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useId } from 'react'
import { aiKey, STATUS_LABEL, useReview } from '../../lib/ai.ts'
import { type RulesRun, rulesRunOf } from '../../lib/analysis.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { clockTime } from '../../lib/consultationContext.ts'
import { EvidenceList } from '../ai/Evidence.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, type BadgeTone } from '../ui/Feedback.tsx'

/** The kinds the fixed safety rules produce (apps/api/src/ai/safety.ts). A hosted model's suggestions (source 'llm') are never shown here. */
const RULE_KINDS: ReadonlySet<string> = new Set(['red_flag', 'safety_check', 'clarification', 'missing_information'])

/** Each result's review state in the status colours: waiting in the to-review tint, accepted in green, the others plain. Never violet: this is not AI. */
const STATUS_TONE: Record<string, BadgeTone> = { pending: 'warn', deferred: 'warn', accepted: 'ok', edited: 'ok', rejected: 'neutral', superseded: 'neutral' }

/** What the rules look at, so that "found nothing" is never read as "safe". */
const CHECKS =
  'They check, by name and fixed lists only: prescribed medicines against recorded allergies, whether the allergy status is recorded, this visit’s vital signs (recorded, and within adult reference ranges), points that conflict with the record, and configured red-flag phrases in the conversation. Not a drug database.'

export const SAFETY_RULES_NOT_RUN = 'The safety rules run when you analyze.'

/** One result of the rules, with the time of the run that made it, and whether that run is older than the newest one. */
export interface RuleResult {
  rec: Recommendation
  /** The run's time of day (hh:mm:ss), or null when that run is not among the jobs the server listed. */
  runAt: string | null
  earlier: boolean
}

export interface SafetyRulesView {
  /** none: the rules never ran in this consultation; otherwise the state of their newest run. */
  state: 'none' | 'running' | 'failed' | 'done'
  /** The newest run, as the Analyze steps show it (lib/analysis.ts rulesRunOf). */
  last: RulesRun | null
  /** The newest run's results first, then any still listed from earlier runs (decided ones, or all of them when the newest run failed); within each, those that need attention first, then in the server's order. */
  results: RuleResult[]
  /** Results that wait for the doctor's decision. */
  waiting: number
}

/**
 * The fixed safety rules' results, from the consultation's AI state (GET /encounters/:id/ai, or the answer of the run itself): only what the
 * rules made (source 'rules', the four rule kinds). The server no longer lists a result a newer run replaced; a decided one stays, from the run
 * that made it.
 */
export function safetyRulesView(ai: Pick<EncounterAi, 'jobs' | 'recommendations'>): SafetyRulesView {
  const jobs = ai.jobs.filter((j) => j.kind === 'safety_check')
  // The newest run, chosen as rulesRunOf chooses it, so that this card and the Analyze steps speak of the same run.
  const newest = jobs.length ? jobs.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a)) : null
  const last = rulesRunOf(ai)
  const at = new Map(jobs.map((j) => [j.id, clockTime(j.completedAt ?? j.createdAt)]))
  const results = ai.recommendations
    .filter((r) => r.source === 'rules' && RULE_KINDS.has(r.kind))
    .map((rec, index) => ({ rec, runAt: at.get(rec.jobId) ?? null, earlier: rec.jobId !== newest?.id, index }))
    .sort((a, b) => Number(a.earlier) - Number(b.earlier) || Number(b.rec.urgency === 'attention') - Number(a.rec.urgency === 'attention') || a.index - b.index)
    .map(({ rec, runAt, earlier }) => ({ rec, runAt, earlier }))
  const state = !last ? (results.length ? 'done' : 'none') : last.state === 'running' ? 'running' : last.state === 'failed' ? 'failed' : 'done'
  return { state, last, results, waiting: results.filter((r) => r.rec.status === 'pending' || r.rec.status === 'deferred').length }
}

const counted = (n: number) => (n === 1 ? '1 result' : `${n} results`)

/**
 * "Safety rules": what the fixed safety rules (safety-rules-v1) found the last time they ran (Analyze with Mana runs them; so does "Get
 * recommendations" in the older assistant), each result with its kind, why the rule fired, where it came from and the doctor's decision.
 * Accept and Reject record that decision (POST /ai-review/recommendation/:id); neither adds anything to the note or the prescription.
 *
 * It only OBSERVES the consultation's AI state, which the conversation panel reads and the Analyze action writes (same key, never enabled):
 * no request and no audit entry of its own. Neutral throughout: the rules are not AI, and nothing here is in the AI's violet.
 */
export function SafetyRules({ encounterId }: { encounterId: string }) {
  const headingId = useId()
  const q = useQuery({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`), enabled: false })
  const view = q.data ? safetyRulesView(q.data) : null
  const last = view?.last
  return (
    <section aria-labelledby={headingId} className="text-sm" data-testid="safety-rules" data-state={view?.state ?? 'unknown'}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id={headingId} className="text-sm font-semibold">
          Safety rules
        </h3>
        {last?.state === 'done' && (
          <p className="text-xs break-words text-ink-muted" data-testid="safety-rules-run">
            Last run {(last.at && clockTime(last.at)) ?? 'time not recorded'}
            {last.producedBy && ` · ${last.producedBy}`} · {counted(last.results)}
          </p>
        )}
        {last?.state === 'running' && (
          <p role="status" className="text-xs text-ink-muted" data-testid="safety-rules-run">
            Running now…
          </p>
        )}
      </div>
      {!view ? (
        <p className="mt-1 text-ink-muted">{q.isError ? 'The safety rules’ results could not be read just now.' : 'Not read yet.'}</p>
      ) : view.state === 'none' ? (
        <p className="mt-1 text-ink-muted">{SAFETY_RULES_NOT_RUN}</p>
      ) : (
        <>
          <p className="mt-0.5 text-xs break-words text-ink-muted">{CHECKS}</p>
          {q.isError && (
            <p role="status" className="mt-2 rounded-lg border border-pending/30 bg-pending-soft px-3 py-2 text-ink">
              Not updated: the results could not be read again. What is shown was read at {clockTime(new Date(q.dataUpdatedAt).toISOString()) ?? 'an earlier time'}.
            </p>
          )}
          {last?.state === 'failed' && (
            <p role="alert" className="mt-2 rounded-lg border border-down/20 bg-down-soft px-3 py-2 break-words text-ink" data-testid="safety-rules-failed">
              The last run of the safety rules failed: {last.message}
            </p>
          )}
          {last?.state === 'done' && last.results === 0 && <p className="mt-2 text-ink-muted">The rules found nothing at their last run.</p>}
          {view.results.length > 0 && (
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {view.results.map((r) => (
                <RuleItem key={r.rec.id} encounterId={encounterId} result={r} />
              ))}
            </ul>
          )}
          {view.waiting > 0 && <p className="mt-2 text-xs text-ink-muted">Accept or Reject records your decision. Neither adds anything to the note or the prescription.</p>}
        </>
      )}
    </section>
  )
}

/** One result: its kind, the rule's words, why it fired, its sources and its review state; Accept and Reject while it waits. */
function RuleItem({ encounterId, result }: { encounterId: string; result: RuleResult }) {
  const { rec: r, runAt, earlier } = result
  const textId = useId()
  const review = useReview(encounterId, 'recommendation', r.id)
  const waiting = r.status === 'pending' || r.status === 'deferred'
  const attention = r.urgency === 'attention'
  return (
    // A flat row under a hairline, marked on its left in the rules' neutral grey (red when it needs attention): never the AI's violet.
    <li
      className={`border-l-2 py-2 pr-1 pl-3 ${attention ? 'border-down/60' : 'border-line-strong'}`}
      data-testid="safety-rule"
      data-kind={r.kind}
      data-status={r.status}
      data-urgency={r.urgency}
      data-run={earlier ? 'earlier' : 'last'}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold">{RECOMMENDATION_KINDS[r.kind as RecommendationKind] ?? r.kind}</span>
        {attention && <Badge tone="down">Needs attention</Badge>}
        <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
      </div>
      <p id={textId} className={`mt-1 font-medium break-words ${r.status === 'rejected' ? 'line-through' : ''}`}>
        {r.finalText ?? r.text}
      </p>
      {r.instruction && (
        <Alert tone="error" title="Configured escalation instruction" className="mt-2" live={false}>
          {r.instruction} A clinician must review this.
        </Alert>
      )}
      <p className="mt-0.5 text-xs break-words text-ink-muted">Why: {r.rationale}</p>
      {r.missingInformation.length > 0 && (
        <p className="mt-0.5 text-xs break-words">
          <span className="font-medium">Not found in the data:</span> {r.missingInformation.map((m) => m.text).join('; ')}
        </p>
      )}
      {earlier && <p className="mt-1 text-xs text-ink-muted">From an earlier run{runAt ? ` at ${runAt}` : ''}.</p>}
      {review.isError && (
        <p role="alert" className="mt-1 text-sm break-words text-down">
          {errorMessage(review.error)}
        </p>
      )}
      {/* The sources (small, they give way) and the decision on one row, as a draft statement's. */}
      <div className="mt-1 flex min-w-0 flex-nowrap items-start gap-1.5">
        <div className="min-w-0 flex-1 pt-2">{r.evidence.length > 0 && <EvidenceList evidence={r.evidence} />}</div>
      {waiting && (
        <div className="flex shrink-0 flex-nowrap gap-1.5">
          <Button
            size="sm"
            variant="subtle"
            className="px-2.5!"
            icon={<Check aria-hidden="true" className="size-4" />}
            loading={review.isPending && review.variables?.action === 'accepted'}
            disabled={review.isPending}
            aria-describedby={textId}
            onClick={() => review.mutate({ action: 'accepted' })}
          >
            Accept
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="px-2.5!"
            icon={<X aria-hidden="true" className="size-4" />}
            loading={review.isPending && review.variables?.action === 'rejected'}
            disabled={review.isPending}
            aria-describedby={textId}
            onClick={() => review.mutate({ action: 'rejected' })}
          >
            Reject
          </Button>
        </div>
      )}
      </div>
    </li>
  )
}
