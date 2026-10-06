import type { ConsultationAi, Encounter } from '@adaxai/contracts'
import { useId } from 'react'
import type { NoteInserter } from '../../lib/insert.ts'
import { type PartId, revealPart, showPart } from '../../lib/workspace.ts'
import { ConsultationIntelligence, showsStatements } from '../ai/ConsultationIntelligence.tsx'
import { ConsultationOverview } from '../clinical/ConsultationOverview.tsx'
import { ManaAssistant } from '../mana/ManaAssistant.tsx'
import { PanelBoundary } from '../ui/PanelBoundary.tsx'
import { AnalysisPanel } from './AnalysisPanel.tsx'
import { useConsultationAiObserver } from './AnalyzeButton.tsx'

/*
 * The Mana area of the consultation (Doctor HERO), `#mana-result`: what the local model and the fixed rules made of the inputs, in the order
 * the doctor reads it. The analysis' progress while a run is under way; the model's draft (the result card, model output, kept apart from
 * everything else and labelled as such); the consultation overview with the fixed safety rules (fixed rules, not AI); and Ask Mana last,
 * closed until the doctor opens it (it asks nothing before). The Analyze button is in the inputs rail, so the result card has no button of its
 * own to start a draft; its Cancel stays while a draft is being made. The medication considerations are shown with the prescription instead.
 */

const OVERVIEW_ID = 'mana-overview'

/**
 * Draft statements in the result card that wait for the doctor's decision: none while a draft is being made or has no statements to show.
 * The medication considerations are not counted: they wait in the prescription's lane.
 */
export function resultWaiting(ai: Pick<ConsultationAi, 'draft'>): number {
  const d = ai.draft
  if (!d || !showsStatements(d)) return 0
  return d.items.filter((i) => i.decision === 'pending' && i.section !== 'potential_medication_considerations').length
}

/** Every draft statement that waits (the medication considerations with the prescription included): what the workflow strip counts too. */
export function draftWaiting(ai: Pick<ConsultationAi, 'draft'>): number | null {
  const d = ai.draft
  if (!d || !showsStatements(d)) return null
  return d.items.filter((i) => i.decision === 'pending').length
}

/** What the area needs of the draft's state (observed): what waits in the result, in the whole draft, and the rules' record check before any draft. */
const areaFacts = (ai: ConsultationAi) => ({ waiting: resultWaiting(ai), all: draftWaiting(ai), check: ai.draft && showsStatements(ai.draft) ? null : (ai.draft?.recordCheck ?? ai.recordCheck ?? null) })

export interface ManaAreaProps {
  encounter: Encounter
  /** The one way into the note (reviewed statements are added by the doctor's own act). Ask Mana is given none: it is read-only. */
  inserter: NoteInserter
  /** How the overview leads to another part of the page: by default it opens a collapsed module and brings it into view. */
  onJump?: (part: PartId) => void
}

/**
 * `#mana-review`, the workflow strip's "Your review", is the first block that waits for the doctor: the result card while its statements wait,
 * else the overview's "Needs your review". Exactly one of the two carries the id at a time.
 */
export function ManaArea({ encounter, inserter, onJump = revealPart }: ManaAreaProps) {
  const headingId = useId()
  const facts = useConsultationAiObserver(encounter.id, areaFacts).data
  const waiting = facts?.waiting ?? 0
  return (
    <section id="mana-result" aria-labelledby={headingId} className="min-w-0 scroll-mt-20 space-y-4 lg:scroll-mt-0" data-testid="mana-result">
      <div>
        <h2 id={headingId} tabIndex={-1} data-part-focus="mana-result" className="rounded text-lg font-semibold focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
          Mana
        </h2>
        <p className="text-sm text-ink-muted">The local model’s draft for your review, the fixed rules’ checks, and Ask Mana.</p>
      </div>
      <PanelBoundary label="The analysis progress" neutral className="empty:hidden">
        <AnalysisPanel encounter={encounter} />
      </PanelBoundary>
      <div
        id={waiting > 0 ? 'mana-review' : undefined}
        tabIndex={waiting > 0 ? -1 : undefined}
        className="min-w-0 scroll-mt-20 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0"
      >
        <PanelBoundary label="The Mana result" className="min-w-0">
          <ConsultationIntelligence encounterId={encounter.id} inserter={inserter} analyzeSlot={null} excludeMedication headingLevel={3} title="Mana result" onShowOverview={() => showPart(OVERVIEW_ID)} />
        </PanelBoundary>
      </div>
      <div id={OVERVIEW_ID} tabIndex={-1} className="min-w-0 scroll-mt-20 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0">
        <PanelBoundary label="The consultation overview" neutral className="min-w-0">
          <ConsultationOverview
            encounter={encounter}
            onJump={onJump}
            compact
            safetyRules
            reviewPart={waiting === 0}
            draftStatements={facts?.all ?? null}
          />
        </PanelBoundary>
      </div>
      <div id="mana-chat" tabIndex={-1} className="min-w-0 scroll-mt-20 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0">
        <PanelBoundary label="Ask Mana" neutral className="min-w-0">
          <ManaAssistant patientId={encounter.patient.id} encounterId={encounter.id} title="Ask Mana" />
        </PanelBoundary>
      </div>
    </section>
  )
}
