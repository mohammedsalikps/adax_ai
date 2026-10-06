import { CircleAlert, CircleCheck, CloudUpload, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SaveState } from '../../lib/draftSaver.ts'
import { fmtTime } from '../../lib/format.ts'

/** The draft's save state, small, announced politely (data-testid "save-state"; shared by the consultation and the prescription page). */
export function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: Date | null }) {
  const map: Record<SaveState, { icon: ReactNode; text: string; cls: string }> = {
    saved: { icon: <CircleCheck aria-hidden="true" className="size-4" />, text: savedAt ? `Saved ${fmtTime(savedAt.toISOString())}` : 'No changes', cls: 'text-ok' },
    dirty: { icon: <CloudUpload aria-hidden="true" className="size-4" />, text: 'Unsaved changes', cls: 'text-ink-muted' },
    saving: { icon: <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />, text: 'Saving…', cls: 'text-ink-muted' },
    error: { icon: <CircleAlert aria-hidden="true" className="size-4" />, text: 'Not saved — retrying', cls: 'text-down' },
    conflict: { icon: <CircleAlert aria-hidden="true" className="size-4" />, text: 'Changed elsewhere', cls: 'text-down' },
    blocked: { icon: <CircleAlert aria-hidden="true" className="size-4" />, text: 'Not saved', cls: 'text-down' },
  }
  const m = map[state]
  return (
    <p role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 text-sm font-medium ${m.cls}`} data-testid="save-state">
      {m.icon}
      {m.text}
    </p>
  )
}
