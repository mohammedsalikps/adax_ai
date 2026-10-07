/**
 * How any part of the doctor's app opens or closes the global Mana (components/mana/GlobalMana.tsx, owner: the Mana unit), without holding a
 * reference to it: a tiny event channel in this module. GlobalMana subscribes with onOpenMana / onCloseMana while it is mounted (AppShell
 * mounts it for doctors only); a button elsewhere ("Summarize with Mana" in the consultation's history panel) calls openMana, optionally
 * with a question to ask as soon as the sheet is open. Mana is scoped by the route, not by the caller.
 *
 * Nothing here talks to the server: opening Mana is what makes GlobalMana fetch anything (the e2e journeys assert zero Mana requests until
 * then). No DOM dependency, so it is unit-tested in node.
 */

export interface OpenManaOptions {
  /** A question to send as soon as Mana is open (the doctor's own act: they pressed the button that asks it). Trimmed; empty is ignored. */
  ask?: string
}

type OpenHandler = (opts: OpenManaOptions) => void
type CloseHandler = () => void

const openHandlers = new Set<OpenHandler>()
const closeHandlers = new Set<CloseHandler>()

/**
 * Asks the global Mana to open (and, with `ask`, to ask that question). Returns whether anything is listening: false when no Mana is mounted
 * (a role or a page without it), so the caller can say so instead of doing nothing silently.
 */
export function openMana(opts: OpenManaOptions = {}): boolean {
  const ask = opts.ask?.trim()
  const clean: OpenManaOptions = ask ? { ask } : {}
  // A copy: a handler that unsubscribes while being called does not skip the next one.
  const listeners = Array.from(openHandlers)
  for (const h of listeners) h(clean)
  return listeners.length > 0
}

/** Asks the global Mana to close (after a page has used it for something that is now done). Nothing happens when it is not open. */
export function closeMana(): void {
  for (const h of Array.from(closeHandlers)) h()
}

/** Called by GlobalMana: `handler` runs on every openMana. Returns the function that stops it (call it on unmount). */
export function onOpenMana(handler: OpenHandler): () => void {
  openHandlers.add(handler)
  return () => {
    openHandlers.delete(handler)
  }
}

/** Called by GlobalMana: `handler` runs on every closeMana. Returns the function that stops it. */
export function onCloseMana(handler: CloseHandler): () => void {
  closeHandlers.add(handler)
  return () => {
    closeHandlers.delete(handler)
  }
}

// --- whether Mana is open (for a launcher outside GlobalMana: the sidebar's Mana card) ----------------------------------------------------

let openNow = false
const stateHandlers = new Set<() => void>()

/** Called by GlobalMana when its sheet opens or closes. */
export function publishManaOpen(open: boolean): void {
  if (openNow === open) return
  openNow = open
  for (const h of Array.from(stateHandlers)) h()
}

/** For useSyncExternalStore: told whenever Mana opens or closes. */
export function subscribeManaOpen(handler: () => void): () => void {
  stateHandlers.add(handler)
  return () => {
    stateHandlers.delete(handler)
  }
}

/** Whether the global Mana is open now. */
export const isManaOpen = (): boolean => openNow
