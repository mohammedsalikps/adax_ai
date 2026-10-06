import type { ManaActionProposal, ManaMessage } from '@adaxai/contracts'
import { Check, PillBottle, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../../lib/api.ts'
import { getDraftBridge } from '../../lib/draftBridge.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { type ManaScope, useManaDecision } from '../../lib/manaAssistant.ts'
import { NO_DRAFT_OPEN, proposalLines, toPrescriptionItem } from '../../lib/manaGlobal.ts'
import { Button } from '../ui/Button.tsx'

type Outcome = { tone: 'ok' | 'warn' | 'error'; text: string }
const TONE: Record<Outcome['tone'], string> = { ok: 'text-ok', warn: 'text-pending', error: 'text-down' }

/**
 * A medicine Mana proposes from the doctor's own words (DESIGN §5.8): what would be added, the fixed checks (an allergy on record in the same
 * group, the same medicine already on the draft), and [Approve] [Cancel]. Approve records the decision and adds the row to the consultation's
 * unsigned draft through the page that holds it (lib/draftBridge): the doctor's act, saved by that page's autosave. Nothing is signed. Without a
 * page holding the draft, nothing is recorded and the doctor is told to open the consultation or its prescription.
 */
export function ManaProposalCard({ m, proposal, scope, disabled }: { m: ManaMessage; proposal: ManaActionProposal; scope: ManaScope; disabled?: boolean }) {
  const decide = useManaDecision(scope)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const decided = m.actionDecision ?? null

  const approve = async () => {
    setOutcome(null)
    const bridge = getDraftBridge(proposal.encounterId)
    if (!bridge) {
      setOutcome({ tone: 'warn', text: `${NO_DRAFT_OPEN}.` })
      return
    }
    try {
      await decide.mutateAsync({ messageId: m.id, decision: 'approved' })
    } catch (e) {
      setOutcome({ tone: 'error', text: errorMessage(e) })
      return
    }
    try {
      await bridge.addPrescriptionItem(toPrescriptionItem(proposal))
      setOutcome({ tone: 'ok', text: 'Added to the draft prescription. It is not signed: review it before you sign.' })
    } catch (e) {
      setOutcome({ tone: 'error', text: `Approved, but the medicine could not be added to the draft (${e instanceof Error ? e.message : 'the page refused it'}). Add it on the prescription.` })
    }
  }
  const cancel = async () => {
    setOutcome(null)
    try {
      await decide.mutateAsync({ messageId: m.id, decision: 'declined' })
      setOutcome({ tone: 'ok', text: 'Cancelled. Nothing was added.' })
    } catch (e) {
      setOutcome({ tone: 'error', text: errorMessage(e) })
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-line-strong bg-surface p-3" data-testid="mana-proposal" data-decision={decided?.decision ?? 'none'}>
      <p className="flex items-start gap-2 text-sm font-semibold">
        <PillBottle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <span className="[overflow-wrap:anywhere]">{proposal.summary}</span>
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        {proposalLines(proposal).map((l) => (
          <div key={l.label} className="contents">
            <dt className="text-ink-muted">{l.label}</dt>
            <dd className="[overflow-wrap:anywhere]">{l.value}</dd>
          </div>
        ))}
      </dl>
      {proposal.warnings.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Checks before you approve" data-testid="mana-proposal-warnings">
          {proposal.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 text-sm text-pending" data-kind={w.kind}>
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{w.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-ink-muted">From your own words. Nothing is added until you approve, and nothing is signed.</p>
      {decided ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm" data-testid="mana-proposal-decided">
          {decided.decision === 'approved' ? <Check aria-hidden="true" className="size-4 text-ok" /> : <X aria-hidden="true" className="size-4 text-ink-muted" />}
          {decided.decision === 'approved' ? 'Approved' : 'Cancelled'} {fmtDateTime(decided.decidedAt)}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={decide.isPending && decide.variables?.decision === 'approved'} disabled={disabled || decide.isPending} onClick={() => void approve()} data-testid="mana-approve">
            Approve
          </Button>
          <Button size="sm" variant="secondary" loading={decide.isPending && decide.variables?.decision === 'declined'} disabled={disabled || decide.isPending} onClick={() => void cancel()} data-testid="mana-cancel">
            Cancel
          </Button>
        </div>
      )}
      {outcome && (
        <p role="status" className={`mt-2 text-sm ${TONE[outcome.tone]}`} data-testid="mana-proposal-outcome">
          {outcome.text}
        </p>
      )}
    </div>
  )
}
