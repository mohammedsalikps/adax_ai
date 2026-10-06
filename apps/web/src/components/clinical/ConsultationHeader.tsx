import type { Encounter } from '@adaxai/contracts'
import { ArrowLeft, IdCard } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { recordingLabel, useRecordingState } from '../../lib/recordingState.ts'
import { StatusPill } from '../hero/StatusPill.tsx'
import { Button } from '../ui/Button.tsx'
import { Badge } from '../ui/Feedback.tsx'
import { Menu, type MenuItem } from '../ui/Menu.tsx'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'
import { VitalsSnapshot } from '../workspace/VitalsSnapshot.tsx'
import { AllergyChips } from './ConsultationBanner.tsx'
import { ageSex } from './PatientBanner.tsx'

/**
 * Publishes the header's measured height as `--consult-header-h` while it sticks (styles.css keeps focused controls and jumps clear of it),
 * and 0 where it does not stick. The bottom bar is the page's only `--action-bar-h` publisher.
 */
function usePublishedHeight(ref: RefObject<HTMLElement | null>, name: string) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const apply = () => root.style.setProperty(name, getComputedStyle(el).position === 'sticky' ? `${el.offsetHeight}px` : '0px')
    apply()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    ro?.observe(el)
    window.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      root.style.removeProperty(name)
    }
  }, [ref, name])
}

/**
 * The consultation's status in the header (DESIGN §5.4), from the live transcription panel's store (lib/recordingState.ts): "● Recording
 * 03:12" (its own 1 s clock while recording), "Paused 01:01", "Not recording — <reason>", or Draft. Never a recording state without a running
 * microphone recorder. The clock is for the eye; the words change only when the state does, so nothing is announced every second.
 */
export function RecordingStatus({ encounterId }: { encounterId: string }) {
  const s = useRecordingState(encounterId)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (s.state !== 'recording') return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [s.state])
  const label = recordingLabel(s, Date.now())
  if (!label) return <StatusPill status="draft" className="shrink-0" />
  const tone = s.state === 'recording' ? 'border-down/20 bg-down-soft text-down' : s.state === 'paused' ? 'border-pending/20 bg-pending-soft text-pending' : 'border-line bg-canvas text-ink-muted'
  return (
    <span className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${tone}`} title={label} data-testid="consultation-status" data-state={s.state}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full bg-current ${s.state === 'recording' ? 'motion-safe:animate-pulse' : ''}`} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}

export interface ConsultationHeaderProps {
  /** The consultation as the server last answered (its vital signs follow a Record vitals). */
  encounter: Encounter
  /** My consultations. */
  backTo: string
  /** [Patient profile]: the profile drawer on its overview. */
  onOpenProfile: () => void
  /** The ⋯ menu: Consultation overview, Clinical photographs, Keyboard shortcuts, Discard draft… */
  menu: MenuItem[]
}

/**
 * The doctor's consultation header (DESIGN §5.4): sticky (from 768px) and compact, one row where it fits, wrapping on narrower screens. The way
 * back to My consultations, the patient (avatar, name, age · sex, MRN small), the allergy chips (always shown: "Allergy status not recorded"
 * when missing; they also keep the patient's history read, which the history panel observes), the consultation's status, the last vital
 * signs (VitalsSnapshot), then [Patient profile] and the ⋯ menu. The save state is in the bottom bar; saving is automatic (Ctrl/⌘+S still
 * saves now). The patient's name is the page's h1.
 */
export function ConsultationHeader({ encounter, backTo, onOpenProfile, menu }: ConsultationHeaderProps) {
  const header = useRef<HTMLElement>(null)
  usePublishedHeight(header, '--consult-header-h')
  const p = encounter.patient
  return (
    <header
      ref={header}
      className="-mx-4 -mt-6 mb-4 border-b border-line bg-surface/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 md:sticky md:top-topbar md:z-20 lg:-mx-8 lg:px-8 print:hidden"
      data-testid="consultation-header"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 max-md:items-start">
        <Link to={backTo} className="-ml-2 inline-flex size-control shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-canvas hover:text-ink">
          <ArrowLeft aria-hidden="true" className="size-5" />
          <span className="sr-only">Back to My consultations</span>
        </Link>
        <PatientAvatar name={p.fullName} size="sm" />
        <section aria-label="Patient" className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-3 gap-y-1" data-testid="patient-banner">
          <h1 className="min-w-0 text-base font-semibold break-words">
            <span className="sr-only">Consultation: </span>
            {p.fullName}
          </h1>
          <p className="text-sm whitespace-nowrap text-ink-muted" data-testid="patient-identity">
            {ageSex(p)} · <span className="text-xs">MRN</span> <span className="font-mono text-xs text-ink">{p.mrn}</span>
          </p>
          <ul className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Allergies">
            <AllergyChips encounter={encounter} />
          </ul>
          {encounter.visit.priority === 'urgent' && (
            <span data-testid="visit-urgent">
              <Badge tone="down" dot>
                Urgent<span className="sr-only"> visit</span>
              </Badge>
            </span>
          )}
          <RecordingStatus encounterId={encounter.id} />
          <VitalsSnapshot encounter={encounter} />
        </section>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" icon={<IdCard aria-hidden="true" className="size-4" />} onClick={onOpenProfile} data-testid="open-patient-profile">
            Patient profile
          </Button>
          <Menu label="More consultation actions" items={menu} triggerClassName="inline-flex size-control items-center justify-center rounded-md border border-transparent text-ink-muted hover:bg-canvas hover:text-ink" />
        </div>
      </div>
    </header>
  )
}
