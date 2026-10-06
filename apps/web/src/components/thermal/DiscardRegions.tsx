import { type ReactNode, useCallback, useState } from 'react'
import { discardGuard } from '../../lib/thermalStudy.ts'
import { ConfirmationDialog } from '../ui/ConfirmationDialog.tsx'

/** The question before regions drawn on a thermal study but not saved are discarded (the same words wherever a study is shown). */
export function DiscardRegionsDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <ConfirmationDialog title="Discard the unsaved regions?" keepLabel="Keep editing" confirmLabel="Discard the regions" onClose={onKeep} onConfirm={onDiscard}>
      <p>The regions drawn on this image have not been saved, and continuing discards them. To keep them, choose “Keep editing” and press “Save regions”.</p>
    </ConfirmationDialog>
  )
}

export interface DiscardRegions {
  /** Runs `go` now, or after the doctor agrees to discard regions drawn but not saved. Stable. */
  guard: (go: () => void) => void
  /** For the study's `onDirtyChange`. Stable. */
  onDirtyChange: (dirty: boolean) => void
  /** Whether regions are unsaved now (read in event handlers, which cannot wait for a render). Stable. */
  isDirty: () => boolean
  /** The question, while it is asked: render it once, outside any sheet the study is in. */
  dialog: ReactNode
}

/** The discard guard (lib/thermalStudy.ts `discardGuard`) for a screen that shows a thermal study. */
export function useDiscardRegions(): DiscardRegions {
  const [asking, setAsking] = useState(false)
  const [g] = useState(() => discardGuard(setAsking))
  const guard = useCallback((go: () => void) => g.guard(go), [g])
  const onDirtyChange = useCallback(
    (dirty: boolean) => {
      g.dirty = dirty
    },
    [g],
  )
  const isDirty = useCallback(() => g.dirty, [g])
  return { guard, onDirtyChange, isDirty, dialog: asking ? <DiscardRegionsDialog onKeep={() => g.keep()} onDiscard={() => g.discard()} /> : null }
}
