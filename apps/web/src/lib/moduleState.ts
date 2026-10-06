import type { ModuleKey } from './workspace.ts'

/*
 * Whether a consultation module (one of the five inputs beside the note) is open, remembered for the person signed in on this browser, so
 * that a doctor who keeps the conversation open finds it open at the next consultation. Only that is kept: which module, open or closed,
 * under the person's id; never anything about a patient or a consultation. Storage can be missing or refuse (a private window, blocked site
 * data, a full quota, a test without a browser): then nothing is remembered, nothing fails, and the module starts as the page says.
 */

/** The part of Storage used here (a fake in tests). */
export type ModuleStorage = Pick<Storage, 'getItem' | 'setItem'>

export const moduleStorageKey = (viewerId: string, module: ModuleKey) => `adaxai.consultation-module.${viewerId}.${module}`

/** The browser's localStorage, or undefined where there is none or merely reading it throws (site data blocked). */
export function moduleStorage(): ModuleStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : (window.localStorage ?? undefined)
  } catch {
    return undefined
  }
}

/** true or false when this person chose; undefined when they did not, nobody is known, or the storage cannot be read. */
export function readModuleOpen(storage: ModuleStorage | undefined, viewerId: string | undefined, module: ModuleKey): boolean | undefined {
  if (!storage || !viewerId) return undefined
  try {
    const v = storage.getItem(moduleStorageKey(viewerId, module))
    return v === 'open' ? true : v === 'closed' ? false : undefined
  } catch {
    return undefined
  }
}

/** Remembers the person's choice; does nothing (and throws nothing) when there is no storage, nobody is known, or it refuses. */
export function writeModuleOpen(storage: ModuleStorage | undefined, viewerId: string | undefined, module: ModuleKey, open: boolean): void {
  if (!storage || !viewerId) return
  try {
    storage.setItem(moduleStorageKey(viewerId, module), open ? 'open' : 'closed')
  } catch {
    // Not remembered: the module still opens and closes.
  }
}
