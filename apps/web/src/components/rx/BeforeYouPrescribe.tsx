import type { ConsultationAi, EncounterAi } from '@adaxai/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PenLine, RefreshCw, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type AiResponse, aiKey, newIdempotencyKey } from '../../lib/ai.ts'
import { api, errorMessage } from '../../lib/api.ts'
import { consultKey } from '../../lib/consult.ts'
import { fmtWhen } from '../../lib/devices.ts'
import type { SaveState } from '../../lib/draftSaver.ts'
import { SourceTag } from '../hero/SourceTag.tsx'
import { Button } from '../ui/Button.tsx'
import { allergyCheck, considerationsView } from '../workspace/PrescriptionAiLane.tsx'
import { ALLERGY_CHECK_DEBOUNCE_MS, type AllergyCheckView, allergyCheckView } from './rxModel.ts'

/** The medicines this page's last answered check of a consultation was asked for (kept while the app is open: going back and forth does not run it again). */
const checkedFor = new Map<string, string>()

export interface AllergyNameCheck {
  view: AllergyCheckView
  /** A check is under way. */
  checking: boolean
  /** [Check now]: saves what is pending, then checks the medicines as saved. */
  checkNow: () => Promise<void>
  /** Before Review and sign: checks these saved medicines unless they were checked already; resolves once the check has answered or failed. */
  ensure: (savedKey: string) => Promise<void>
}

/**
 * The fixed rules' allergy name check, run from the prescription page where the medicines are written (DESIGN §5.6): the rules only, never the
 * model (POST /encounters/:id/recommendations with includeLlm false; their answer replaces the cached AI state). It runs a moment after a
 * SAVED change to the medicines' names (`savedKey`, lib/draftSaver's savedPrescription), on [Check now], and before Review and sign opens
 * (`ensure`). What it says (rxModel allergyCheckView) speaks of the medicines as they are only when the last check was asked for exactly those.
 */
export function useAllergyNameCheck(
  encounterId: string,
  o: { draftKey: string; savedKey: string; locked: boolean; savedKeyNow: () => string; flushState: () => Promise<SaveState> },
): AllergyNameCheck {
  const qc = useQueryClient()
  const encounterAi = useQuery({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`) })
  const [checkedKey, setCheckedKey] = useState<string | null>(() => checkedFor.get(encounterId) ?? null)
  const checkedRef = useRef(checkedKey)
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null)

  /** Checks the medicines saved as `key` (after a check under way for others); never rejects: a failure is kept, with its words. */
  const run = useCallback(
    (key: string): Promise<void> => {
      if (inFlight.current?.key === key) return inFlight.current.promise
      const before = inFlight.current?.promise ?? Promise.resolve()
      const promise: Promise<void> = before
        .then(() => api<AiResponse>(`/encounters/${encounterId}/recommendations`, { method: 'POST', body: { includeLlm: false, idempotencyKey: newIdempotencyKey() } }))
        .then(
          (ai) => {
            if (ai.consent) qc.setQueryData(aiKey(encounterId), ai)
            checkedRef.current = key
            checkedFor.set(encounterId, key)
            setCheckedKey(key)
            setFailed(null)
          },
          (e: unknown) => setFailed({ key, message: errorMessage(e) }),
        )
        .finally(() => {
          if (inFlight.current?.promise !== promise) return
          inFlight.current = null
          setChecking(false)
        })
      inFlight.current = { key, promise }
      setChecking(true)
      return promise
    },
    [encounterId, qc],
  )

  // A moment after a saved change to the medicines' names (not again for medicines already checked, or whose check just failed: [Check now]).
  const { savedKey, locked } = o
  useEffect(() => {
    if (locked || !savedKey || checking || savedKey === checkedKey || failed?.key === savedKey) return
    const t = setTimeout(() => void run(savedKey), ALLERGY_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [locked, savedKey, checking, checkedKey, failed, run])

  const { flushState, savedKeyNow } = o
  const checkNow = useCallback(async () => {
    await flushState()
    const key = savedKeyNow()
    if (key) await run(key)
  }, [flushState, savedKeyNow, run])
  const ensure = useCallback((key: string) => (checkedRef.current === key && !inFlight.current ? Promise.resolve() : run(key)), [run])

  const server = encounterAi.data ? allergyCheck(encounterAi.data) : null
  const view = allergyCheckView({ draftKey: o.draftKey, checkedKey, checking, failed, server })
  return { view, checking, checkNow, ensure }
}

/**
 * "Before you prescribe" on the prescription page (DESIGN §5.6), the existing lane's content said as text: the fixed rules' allergy name check
 * of the medicines as written here (`allergy`, useAllergyNameCheck), and the draft's medication considerations (AI DRAFT, text only: they are
 * reviewed in the clinical summary, and never go into the prescription; the draft is the clinical summary's read).
 */
export function BeforeYouPrescribe({ encounterId, allergy, locked }: { encounterId: string; allergy: AllergyNameCheck; locked: boolean }) {
  // Observed only: the clinical summary reads it (and follows a draft being made).
  const consult = useQuery({ queryKey: consultKey(encounterId), queryFn: () => api<ConsultationAi>(`/encounters/${encounterId}/consultation-ai`, { query: { fresh: 1 } }), enabled: false })
  const v = allergy.view
  const view = considerationsView(consult.data)
  const muted = (text: string) => <p className="text-sm text-ink-muted">{text}</p>
  return (
    <div className="space-y-3 text-sm" data-testid="rx-before-you-prescribe">
      <div className="space-y-1" data-testid="rx-allergy-check" data-state={v.state}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            Allergy name check <SourceTag kind="rules" />
          </p>
          {v.state !== 'none' && (
            <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden="true" className="size-4" />} loading={allergy.checking} disabled={locked} onClick={() => void allergy.checkNow()} data-testid="rx-allergy-check-now">
              Check now
            </Button>
          )}
        </div>
        {v.state === 'none' && muted('No medicine in the prescription yet: nothing to check.')}
        {v.state === 'checking' && muted('Checking the medicines…')}
        {v.state === 'unchecked' && <p className="text-sm font-medium text-pending">{v.ever ? 'Not checked since the medicines changed.' : 'Not checked yet.'}</p>}
        {v.state === 'not_run_failed' && <p className="text-sm font-medium text-pending">Not checked: {v.message}</p>}
        {v.state === 'failed' && <p className="text-sm font-medium text-pending">The fixed rules could not run: {v.message}</p>}
        {v.state === 'unread' && muted('The fixed rules’ result could not be read just now.')}
        {v.state === 'done' &&
          (v.matches.length === 0 ? (
            <p>
              No medicine in the prescription matched a recorded allergy by name or group <span className="text-ink-muted">(checked {fmtWhen(v.at, Date.now())})</span>.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {v.matches.map((r) => (
                <li key={r.id} className="flex gap-1.5 font-medium text-down" data-testid="rx-allergy-match">
                  <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 break-words">{r.finalText ?? r.text}</span>
                </li>
              ))}
            </ul>
          ))}
        <p className="text-xs text-ink-muted">A name match against the recorded allergies, not a drug database: no interaction or dose is checked.</p>
      </div>
      <div className="space-y-1 border-t border-line pt-3" data-testid="rx-considerations" data-state={view.state}>
        <p className="flex flex-wrap items-center gap-2 font-medium">
          Medication considerations <SourceTag kind="ai" />
        </p>
        {view.state === 'unread' && muted('Mana’s draft has not been read yet.')}
        {view.state === 'not_run' && muted(view.available ? 'No draft from Mana for this consultation.' : 'Mana is unavailable: there are no medication considerations.')}
        {view.state === 'generating' && muted('Mana is writing its draft; any medication consideration appears here.')}
        {view.state === 'ended' && muted('No medication consideration: the last draft did not finish.')}
        {view.state === 'insufficient' && muted('No medication consideration: too little is recorded to draft from.')}
        {view.state === 'shown' &&
          (view.items.length === 0 ? (
            muted('Mana listed no medication consideration.')
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-ink" aria-label="Medication considerations (AI draft)">
              {view.items.map((i) => (
                <li key={i.id} className={i.decision === 'rejected' ? 'text-ink-muted line-through' : ''}>
                  {i.finalText ?? i.text}
                </li>
              ))}
            </ul>
          ))}
      </div>
      <p className="flex items-center gap-2 border-t border-line pt-3 text-ink-muted" data-testid="rx-no-ai">
        <PenLine aria-hidden="true" className="size-4 shrink-0" />
        Mana never suggests medicines or doses. You write the prescription.
      </p>
    </div>
  )
}
