/*
 * The doctor's keyboard shortcuts in a consultation (Doctor HERO): which key does what, when a key is the doctor's typing and must be left
 * alone, and the list the "Keyboard shortcuts" dialog shows. JSX-free and DOM-free, so that it can be tested without a browser.
 *
 * Only these keys are taken, and only in the consultation being written:
 * - Ctrl+S (⌘S on a Mac): save now. Always, also while typing, so the browser never offers to save the page instead.
 * - Ctrl+Enter (⌘Enter): Generate prescription. Also while typing.
 * - Alt+1 to Alt+5: go to the workspace's panels in the five-input order (DESIGN §5.4, §15): 1 live transcription, 2 clinical inputs,
 *   3 stethoscope, 4 doctor notes, 5 thermal. Alt+N: write in the typed note. Also while typing, except on a Mac, where Option with a letter
 *   or a digit types a character. (The prescription is its own page now: Alt+P is no longer taken.)
 * - Shift+? (the "?" key): this list, only when not typing.
 * AltGr (which some keyboards need to type characters) is never a shortcut, nor is a key held down (repeated), a key that a control already
 * took (`defaultPrevented`), or a key pressed while a character is being composed. While a dialog is open only Ctrl+S is taken.
 */

export type Shortcut = { kind: 'save' } | { kind: 'analyze' } | { kind: 'panel'; n: 1 | 2 | 3 | 4 | 5 } | { kind: 'note' } | { kind: 'help' }

/** What a shortcut reads of a key press (a KeyboardEvent has all of it; `altGraph` is `getModifierState('AltGraph')`). */
export interface KeyPress {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  altGraph: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
}

export interface KeyContext {
  /** The key went to a field the doctor types in (see isTypingTarget). */
  typing: boolean
  /** A Mac: ⌘ instead of Ctrl, and Option-letters are characters. */
  mac: boolean
  /** A modal dialog is open over the page: nothing behind it is jumped to. */
  dialogOpen: boolean
}

const PANEL_CODES: Record<string, 1 | 2 | 3 | 4 | 5> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5 }

/**
 * The shortcut a key press asks for, or null when it is not one (and must be left to the page and the browser). Read by the physical key
 * (`code`) for Alt combinations, so the layout of the keyboard does not change them and the number pad (Alt with number-pad digits types
 * characters on Windows) is never taken.
 */
export function shortcutOf(e: KeyPress, ctx: KeyContext): Shortcut | null {
  if (e.defaultPrevented || e.isComposing) return null
  // AltGr: Windows reports it as Ctrl and Alt together.
  if (e.altGraph || (!ctx.mac && e.ctrlKey && e.altKey)) return null
  const primary = ctx.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (primary && !e.altKey && !e.shiftKey) {
    if (e.code === 'KeyS' || e.key.toLowerCase() === 's') return { kind: 'save' }
    if (e.key === 'Enter' && !ctx.dialogOpen) return { kind: 'analyze' }
    return null
  }
  if (ctx.dialogOpen) return null
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (ctx.mac && ctx.typing) return null
    const n = PANEL_CODES[e.code]
    if (n) return { kind: 'panel', n }
    if (e.code === 'KeyN') return { kind: 'note' }
    return null
  }
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !ctx.typing) return { kind: 'help' }
  return null
}

/** What isTypingTarget reads of an element (an HTMLElement has all of it). */
export interface TargetFacts {
  tagName: string
  isContentEditable?: boolean
  type?: string
  readOnly?: boolean
}

/** Input types that are typed in (a checkbox, a button or a range is not). */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])

/** Whether a key pressed in this element is the doctor's typing: a text field, a text area, a list box, or anything editable. */
export function isTypingTarget(el: TargetFacts | null | undefined): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return TEXT_INPUTS.has((el.type ?? '').toLowerCase())
  return false
}

export interface ShortcutRow {
  /** Each way to press it, as its keys in order (["Ctrl", "S"]). */
  keys: string[][]
  does: string
  /** When it is not taken (said under it), or null. */
  note: string | null
}

/** The workspace's panels, in the five-input order, as Alt+1 to Alt+5 go to them (lib/workspace.ts WORKSPACE_PANELS). */
export const PANEL_NAMES = ['Live transcription', 'Clinical inputs', 'Stethoscope', 'Doctor notes', 'Thermal'] as const

/** The list the "Keyboard shortcuts" dialog shows, with the keys as this computer names them. */
export function shortcutRows(mac: boolean): ShortcutRow[] {
  const primary = mac ? '⌘' : 'Ctrl'
  const alt = mac ? 'Option' : 'Alt'
  const whileTyping = mac ? 'Not while typing in a field (Option with a letter or a digit types a character there).' : null
  return [
    { keys: [[primary, 'S']], does: 'Save now', note: null },
    { keys: [[primary, 'Enter']], does: 'Generate prescription', note: null },
    ...PANEL_NAMES.map((name, i) => ({ keys: [[alt, String(i + 1)]], does: `Go to ${name}`, note: whileTyping })),
    { keys: [[alt, 'N']], does: 'Write in the typed note', note: whileTyping },
    { keys: [['Shift', '?']], does: 'Show these shortcuts', note: 'Not while typing in a field.' },
  ]
}

/** Whether this computer is a Mac (⌘ and Option), from what the browser says of its platform. */
export const isMacPlatform = (platform: string | undefined | null): boolean => /mac|iphone|ipad|ipod/i.test(platform ?? '')
