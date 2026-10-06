import type { ConsultationAi, ConsultItem, EncounterAi, NoteFields, Recommendation } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, PenLine, Pill, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { aiKey, STATUS_LABEL } from '../../lib/ai.ts'
import { api } from '../../lib/api.ts'
import { consultKey } from '../../lib/consult.ts'
import { fmtWhen } from '../../lib/devices.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { medicationConsiderations, StatementCard } from '../ai/ConsultationIntelligence.tsx'
import { Badge } from '../ui/Feedback.tsx'
import { Card } from '../ui/Layout.tsx'

/*
 * "Before you prescribe", beside the doctor's prescription. Three things, each labelled for what it is: the local model's medication
 * considerations (AI DRAFT text for the doctor to weigh; accepted text can go into the note's Plan, never into the prescription); a fixed
 * statement that there are no AI prescription suggestions (none exist: no contract, route or model output carries a medicine row or a dose); and
 * the fixed safety rules' allergy name check from their last run. It reads only what the page already holds (the draft panel's and the capture
 * panel's reads, never enabled here), so it makes no request and writes nothing but what the doctor does to a statement. It never touches the
 * prescription.
 */

/** Where a medication consideration may go in the note: the Plan only (CONSULT_NOTE_SECTION in the contracts says the same). */
const PLAN_ONLY: readonly (keyof NoteFields)[] = ['plan']

// --- what the lane shows, from the state the page holds (pure) ------------------------------------------------------------------------------

/**
 * The medication considerations as the lane can show them: unread (the draft's state is not on this screen), not run (no draft; whether the
 * model is there), being made, ended without statements (failed, cancelled, could not use the model), too little to draft from, or shown (an
 * empty list when the draft has none; `stale` when the note or the record moved after it).
 */
export type ConsiderationsView =
  | { state: 'unread' }
  | { state: 'not_run'; available: boolean }
  | { state: 'generating' }
  | { state: 'ended'; status: 'failed' | 'cancelled' | 'unavailable' }
  | { state: 'insufficient' }
  | { state: 'shown'; items: ConsultItem[]; stale: boolean }

export function considerationsView(ai: Pick<ConsultationAi, 'status' | 'draft'> | null | undefined): ConsiderationsView {
  if (!ai) return { state: 'unread' }
  const d = ai.draft
  if (!d) return { state: 'not_run', available: ai.status.available }
  if (d.status === 'generating') return { state: 'generating' }
  if (d.status === 'failed' || d.status === 'cancelled' || d.status === 'unavailable') return { state: 'ended', status: d.status }
  if (d.insufficient) return { state: 'insufficient' }
  return { state: 'shown', items: medicationConsiderations(d), stale: d.stale }
}

/** A rule result that is the allergy name check (safety.ts rule 1): a safety check that cites a prescribed medicine and a recorded allergy. */
export const isAllergyNameMatch = (r: Recommendation): boolean =>
  r.source === 'rules' && r.kind === 'safety_check' && r.evidence.some((e) => e.sourceType === 'allergy') && r.evidence.some((e) => e.sourceType === 'prescription_item')

/** The fixed safety rules' newest run as the allergy name check: not run in this consultation, running, failed, or done with its matches. */
export type AllergyCheck = { state: 'not_run' } | { state: 'running' } | { state: 'failed'; message: string } | { state: 'done'; at: string; rules: string | null; matches: Recommendation[] }

export function allergyCheck(ai: Pick<EncounterAi, 'jobs' | 'recommendations'>): AllergyCheck {
  const jobs = ai.jobs.filter((j) => j.kind === 'safety_check')
  if (!jobs.length) return { state: 'not_run' }
  const job = jobs.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
  if (job.status === 'running') return { state: 'running' }
  if (job.status === 'failed') return { state: 'failed', message: job.lastErrorMessage ?? 'The fixed safety rules could not be run.' }
  const results = ai.recommendations.filter((r) => r.jobId === job.id && r.source === 'rules')
  return { state: 'done', at: job.completedAt ?? job.createdAt, rules: results[0]?.producedBy.model ?? job.runs.find((r) => r.kind === 'safety_check')?.model ?? null, matches: results.filter(isAllergyNameMatch) }
}

// --- the lane --------------------------------------------------------------------------------------------------------------------------------

type Level = 3 | 4
function Heading({ level, className, children }: { level: Level; className?: string; children: ReactNode }) {
  const Tag = `h${level}` as const
  return <Tag className={className}>{children}</Tag>
}

/** A fixed statement of the lane in one short line, its full wording on demand (a native disclosure: keyboard and screen readers know it). */
function MoreAbout({ summary, children, testId }: { summary: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <details className="group/more text-xs" data-testid={testId}>
      <summary className="inline-flex min-h-control-sm cursor-pointer list-none items-center gap-1 rounded-md text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/more:rotate-180" />
        {summary}
      </summary>
      <div className="pb-1 text-ink-muted">{children}</div>
    </details>
  )
}

/** `level`: the lane's heading (3 beside or inside the prescription, which has the h2; 2 if it stands as an area of its own). Its parts are one below. */
export function PrescriptionAiLane({ encounterId, inserter, level = 3 }: { encounterId: string; inserter: NoteInserter; level?: 2 | 3 }) {
  // Observers of the reads the page already makes (the draft panel's and the capture panel's): never enabled, so no request and no audit entry here.
  const consult = useQuery({ queryKey: consultKey(encounterId), queryFn: () => api<ConsultationAi>(`/encounters/${encounterId}/consultation-ai`, { query: { fresh: 1 } }), enabled: false })
  const encounterAi = useQuery({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`), enabled: false })
  const sub = (level + 1) as Level
  return (
    <div data-testid="rx-ai-lane">
      <Card
        level={level}
        title={
          <span className="inline-flex items-center gap-2">
            <Pill aria-hidden="true" className="size-4 text-ink-muted" />
            Before you prescribe
          </span>
        }
      >
        <div className="space-y-4">
          <Considerations ai={consult.data} unreadable={consult.isError} encounterId={encounterId} inserter={inserter} level={sub} />
          <div className="border-t border-line pt-3 text-sm" data-testid="rx-no-ai">
            <p className="flex items-center gap-2 font-semibold">
              <PenLine aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
              No AI prescription suggestions.
            </p>
            <MoreAbout summary="What this means">
              <p>Mana does not suggest medicines, strengths, doses, frequencies or durations, and nothing is copied into the prescription. You write it.</p>
            </MoreAbout>
          </div>
          <AllergyNameCheck ai={encounterAi.data} unreadable={encounterAi.isError} level={sub} />
        </div>
      </Card>
    </div>
  )
}

function Considerations({ ai, unreadable, encounterId, inserter, level }: { ai: ConsultationAi | undefined; unreadable: boolean; encounterId: string; inserter: NoteInserter; level: Level }) {
  const view = considerationsView(ai)
  const line = (text: string) => <p className="text-sm text-ink-muted">{text}</p>
  return (
    <div className="space-y-2" data-testid="rx-considerations" data-state={view.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Heading level={level} className="text-sm font-semibold">
          Medication considerations
        </Heading>
        <span className="flex flex-wrap gap-1.5">
          <Badge tone="ai">AI DRAFT</Badge>
          <Badge tone="ai">AI-GENERATED</Badge>
          <Badge tone="warn">REQUIRES DOCTOR REVIEW</Badge>
        </span>
      </div>
      <p className="text-xs text-ink-muted">Text for you to weigh. Accepted text can go into the note’s Plan, never into the prescription.</p>
      <MoreAbout summary="How these are made">
        <p>
          Written by the local model from the record. The checks after the model remove a statement that gives a dose or a regimen, or names a medicine that is not in the record (a safety net, not a drug dictionary). Accepted text can go into the note’s Plan; nothing here goes into the prescription.
        </p>
      </MoreAbout>
      {view.state === 'unread' && line(unreadable ? 'Mana’s draft could not be read just now.' : 'Mana’s draft has not been read on this screen yet.')}
      {view.state === 'not_run' && line(view.available ? 'Analyze with Mana to see medication considerations.' : 'Local AI unavailable: no draft has been made, so there is no medication consideration.')}
      {view.state === 'generating' && line('Mana is making a draft. Any medication consideration in it is shown here when it is ready.')}
      {view.state === 'ended' &&
        line(view.status === 'cancelled' ? 'No medication consideration: the last draft was cancelled.' : view.status === 'unavailable' ? 'No medication consideration: the last draft could not use the local AI.' : 'No medication consideration: the last draft could not be made.')}
      {view.state === 'insufficient' && line('No medication consideration: too little is recorded for this consultation to draft from.')}
      {view.state === 'shown' && (
        <>
          {view.stale && (
            <p className="text-xs" data-testid="rx-considerations-stale">
              <Badge tone="warn" dot>
                STALE
              </Badge>{' '}
              Written before your note or the record last changed. Analyze again for a current draft.
            </p>
          )}
          {view.items.length === 0 ? (
            line('Mana made no medication consideration.')
          ) : (
            <ul className="space-y-2">
              {view.items.map((i) => (
                <StatementCard key={i.id} item={i} conflicts={ai?.draft?.recordCheck.conflicts ?? []} encounterId={encounterId} inserter={inserter} noteSections={PLAN_ONLY} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function AllergyNameCheck({ ai, unreadable, level }: { ai: EncounterAi | undefined; unreadable: boolean; level: Level }) {
  const check = ai ? allergyCheck(ai) : null
  const line = (text: string) => <p className="text-sm text-ink-muted">{text}</p>
  return (
    <div className="space-y-2 border-t border-line pt-3" data-testid="rx-allergy-check" data-state={check?.state ?? 'unread'}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Heading level={level} className="text-sm font-semibold">
          Allergy name check
        </Heading>
        <Badge tone="neutral" icon={<ShieldCheck aria-hidden="true" className="size-3" />}>
          Fixed rules, not AI
        </Badge>
      </div>
      {!check && line(unreadable ? 'The fixed rules’ results could not be read just now.' : 'The fixed rules’ results have not been read on this screen yet.')}
      {check?.state === 'not_run' && line('Not run yet in this consultation. Analyze with Mana runs it.')}
      {check?.state === 'running' && line('Checking…')}
      {check?.state === 'failed' && line(`Could not run when last asked: ${check.message}`)}
      {check?.state === 'done' && (
        <>
          {check.matches.length === 0 ? (
            <p className="text-sm">No medicine in the prescription matched a recorded allergy by name or group.</p>
          ) : (
            <ul className="space-y-2">
              {check.matches.map((r) => (
                <li key={r.id} className="rounded-lg border border-down/30 bg-down-soft px-3 py-2 text-sm" data-testid="rx-allergy-match" data-status={r.status}>
                  <p className={`flex gap-1.5 font-medium text-down ${r.status === 'rejected' ? 'line-through' : ''}`}>
                    <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 break-words">{r.finalText ?? r.text}</span>
                  </p>
                  <p className="mt-0.5 text-xs break-words text-ink">Why: {r.rationale}</p>
                  {r.status !== 'pending' && <p className="mt-0.5 text-xs text-ink-muted">{STATUS_LABEL[r.status] ?? r.status}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-muted" data-testid="rx-allergy-checked">
            As checked at {fmtWhen(check.at, Date.now())}
            {check.rules ? ` (${check.rules})` : ''}, when the fixed safety rules last ran. A medicine added or changed since then is not checked until they run again.
          </p>
        </>
      )}
      <MoreAbout summary="What it checks">
        <p>Matches the name of each medicine in the prescription against the recorded allergies and the configured allergy groups. Not a drug database: no interaction, dose or other cross-reaction is checked.</p>
      </MoreAbout>
    </div>
  )
}
