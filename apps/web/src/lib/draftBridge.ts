import type { PrescriptionItemInput } from '@adaxai/contracts'

/**
 * The way an approved Mana action reaches a consultation's draft prescription (DESIGN §5.8): the page that holds the draft (the consultation
 * workspace, the prescription page) registers a bridge for its encounter while it is mounted; the global Mana (owner: the Mana unit) looks the
 * bridge up when the doctor presses Approve on a proposal, and calls addPrescriptionItem. The row is added to the unsigned draft as the
 * doctor's act and saved by the page's own autosave: nothing here writes to the server, and nothing is ever added without that Approve.
 *
 * A tiny registry with no DOM dependency (unit-tested in node). More than one page may register for the same encounter for a moment (one
 * mounting while the other unmounts): the most recent registration wins, and removing it falls back to the earlier one.
 */

export interface DraftBridge {
  encounterId: string
  /** Adds one row to the draft prescription (the page validates and autosaves it). May be async; a rejection is the page's to explain. */
  addPrescriptionItem: (item: PrescriptionItemInput) => void | Promise<void>
}

const bridges = new Map<string, DraftBridge[]>()

/** Registers `bridge` for its encounter. Returns the function that removes exactly this registration (call it on unmount). */
export function registerDraftBridge(bridge: DraftBridge): () => void {
  const list = bridges.get(bridge.encounterId) ?? []
  // A distinct object per registration, so the same functions registered twice are still removed one at a time.
  const entry: DraftBridge = { encounterId: bridge.encounterId, addPrescriptionItem: bridge.addPrescriptionItem }
  list.push(entry)
  bridges.set(bridge.encounterId, list)
  let done = false
  return () => {
    if (done) return
    done = true
    const now = bridges.get(entry.encounterId)
    if (!now) return
    const rest = now.filter((b) => b !== entry)
    if (rest.length) bridges.set(entry.encounterId, rest)
    else bridges.delete(entry.encounterId)
  }
}

/** The bridge of the page that holds this encounter's draft now, or undefined when none is open (Mana then says the consultation must be open). */
export function getDraftBridge(encounterId: string | null | undefined): DraftBridge | undefined {
  if (!encounterId) return undefined
  const list = bridges.get(encounterId)
  return list?.[list.length - 1]
}
