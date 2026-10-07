// Unit tests (node --test) of the consultation's keyboard shortcuts (Doctor HERO): which key does what, that the doctor's typing is left alone
// except for the documented keys, that AltGr, a repeated or composed key and a key a control already took are never shortcuts, and the list
// the "Keyboard shortcuts" dialog shows. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { isMacPlatform, isTypingTarget, type KeyContext, type KeyPress, PANEL_NAMES, shortcutOf, shortcutRows } from '../src/lib/shortcuts.ts'

const press = (over: Partial<KeyPress>): KeyPress => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, altGraph: false, ...over })
const pc: KeyContext = { typing: false, mac: false, dialogOpen: false }
const mac: KeyContext = { typing: false, mac: true, dialogOpen: false }
const typing = (ctx: KeyContext): KeyContext => ({ ...ctx, typing: true })

test('Ctrl+S saves and Ctrl+Enter generates the prescription (⌘ on a Mac), also while typing', () => {
  for (const ctx of [pc, typing(pc)]) {
    assert.deepEqual(shortcutOf(press({ key: 's', code: 'KeyS', ctrlKey: true }), ctx), { kind: 'save' })
    assert.deepEqual(shortcutOf(press({ key: 'Enter', code: 'Enter', ctrlKey: true }), ctx), { kind: 'analyze' })
  }
  // Caps lock, or a layout where the key under S is still "s".
  assert.deepEqual(shortcutOf(press({ key: 'S', code: 'KeyS', ctrlKey: true }), pc), { kind: 'save' })
  for (const ctx of [mac, typing(mac)]) {
    assert.deepEqual(shortcutOf(press({ key: 's', code: 'KeyS', metaKey: true }), ctx), { kind: 'save' })
    assert.deepEqual(shortcutOf(press({ key: 'Enter', code: 'Enter', metaKey: true }), ctx), { kind: 'analyze' })
    // Ctrl on a Mac is not the command key.
    assert.equal(shortcutOf(press({ key: 's', code: 'KeyS', ctrlKey: true }), ctx), null)
  }
  // With Shift or Alt as well, it is another key.
  assert.equal(shortcutOf(press({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }), pc), null)
  assert.equal(shortcutOf(press({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }), pc), null)
  // Plain Enter is the field's (a new line, or Mana chat's send).
  assert.equal(shortcutOf(press({ key: 'Enter', code: 'Enter' }), typing(pc)), null)
  // Other Ctrl keys (copy, paste, undo) are the browser's.
  for (const key of ['c', 'v', 'z', 'y', 'a']) assert.equal(shortcutOf(press({ key, code: `Key${key.toUpperCase()}`, ctrlKey: true }), typing(pc)), null)
})

// Deliberate change (Doctor HERO final, DESIGN §5.4): Alt+1..5 go to the workspace's five panels (kind 'panel', no longer the rail's
// 'module'), and Alt+P is no longer taken because the prescription is its own page; every other assertion is unchanged.
test('Alt+1 to Alt+5 go to the five panels in order, Alt+N the typed note, Alt+P is not taken; by the physical key, never the number pad', () => {
  for (let n = 1; n <= 5; n++) assert.deepEqual(shortcutOf(press({ key: String(n), code: `Digit${n}`, altKey: true }), pc), { kind: 'panel', n })
  assert.deepEqual(shortcutOf(press({ key: 'n', code: 'KeyN', altKey: true }), pc), { kind: 'note' })
  assert.equal(shortcutOf(press({ key: 'p', code: 'KeyP', altKey: true }), pc), null)
  assert.equal(shortcutOf(press({ key: 'p', code: 'KeyP', altKey: true }), typing(pc)), null)
  // On a layout where Alt+digit gives another character, the physical key still counts.
  assert.deepEqual(shortcutOf(press({ key: '&', code: 'Digit1', altKey: true }), pc), { kind: 'panel', n: 1 })
  // Alt with number-pad digits types a character on Windows: never taken.
  assert.equal(shortcutOf(press({ key: '1', code: 'Numpad1', altKey: true }), typing(pc)), null)
  assert.equal(shortcutOf(press({ key: '6', code: 'Digit6', altKey: true }), pc), null)
  assert.equal(shortcutOf(press({ key: 'F', code: 'KeyF', altKey: true }), pc), null)
  // Documented as working while typing on Windows and Linux.
  assert.deepEqual(shortcutOf(press({ key: '3', code: 'Digit3', altKey: true }), typing(pc)), { kind: 'panel', n: 3 })
  assert.deepEqual(shortcutOf(press({ key: 'n', code: 'KeyN', altKey: true }), typing(pc)), { kind: 'note' })
  // On a Mac, Option with a letter or a digit types a character: taken only when not typing.
  assert.deepEqual(shortcutOf(press({ key: '¡', code: 'Digit1', altKey: true }), mac), { kind: 'panel', n: 1 })
  assert.equal(shortcutOf(press({ key: '˜', code: 'KeyN', altKey: true }), typing(mac)), null)
  assert.equal(shortcutOf(press({ key: '¡', code: 'Digit1', altKey: true }), typing(mac)), null)
})

test('AltGr, a key a control already took, and a key pressed while composing are never shortcuts', () => {
  // AltGr: reported as its own modifier, or (on Windows) as Ctrl and Alt together.
  assert.equal(shortcutOf(press({ key: '@', code: 'Digit2', altKey: true, altGraph: true }), typing(pc)), null)
  assert.equal(shortcutOf(press({ key: '@', code: 'Digit2', altKey: true, ctrlKey: true }), typing(pc)), null)
  assert.equal(shortcutOf(press({ key: 's', code: 'KeyS', altKey: true, ctrlKey: true }), pc), null)
  assert.equal(shortcutOf(press({ key: 'Enter', code: 'Enter', ctrlKey: true, defaultPrevented: true }), typing(pc)), null)
  assert.equal(shortcutOf(press({ key: 's', code: 'KeyS', ctrlKey: true, isComposing: true }), typing(pc)), null)
})

test('Shift+? shows the list, only when not typing; with a dialog open only Ctrl+S is taken', () => {
  assert.deepEqual(shortcutOf(press({ key: '?', code: 'Slash', shiftKey: true }), pc), { kind: 'help' })
  assert.equal(shortcutOf(press({ key: '?', code: 'Slash', shiftKey: true }), typing(pc)), null)
  assert.equal(shortcutOf(press({ key: '/', code: 'Slash' }), pc), null)
  const dialog = { ...pc, dialogOpen: true }
  assert.deepEqual(shortcutOf(press({ key: 's', code: 'KeyS', ctrlKey: true }), dialog), { kind: 'save' })
  assert.equal(shortcutOf(press({ key: 'Enter', code: 'Enter', ctrlKey: true }), dialog), null)
  assert.equal(shortcutOf(press({ key: '1', code: 'Digit1', altKey: true }), dialog), null)
  assert.equal(shortcutOf(press({ key: '?', code: 'Slash', shiftKey: true }), dialog), null)
  // Plain letters and digits are never taken.
  for (const key of ['a', 'n', 'p', '1', ' ']) assert.equal(shortcutOf(press({ key, code: '' }), pc), null)
})

test('typing is a text field, a text area, a list box or anything editable; a button, a checkbox or the page is not', () => {
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isTypingTarget({ tagName: 'input', type: '' }), true)
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'search' }), true)
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'button' }), false)
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false)
  assert.equal(isTypingTarget(null), false)
})

// Deliberate change (Doctor HERO final): the rows name the new panels and Generate prescription; Alt+P is gone (see above).
test('the list names the keys as this computer does and says when a key is not taken', () => {
  const rows = shortcutRows(false)
  assert.deepEqual(
    rows.map((r) => [r.keys.map((k) => k.join('+')).join(' or '), r.does]),
    [
      ['Ctrl+S', 'Save now'],
      // Jury polish: the button reads as in the reference screens.
      ['Ctrl+Enter', 'Analyze & Generate Prescription'],
      ['Alt+1', 'Go to Live transcription'],
      ['Alt+2', 'Go to Clinical inputs'],
      ['Alt+3', 'Go to Stethoscope'],
      ['Alt+4', 'Go to Doctor notes'],
      ['Alt+5', 'Go to Thermal'],
      ['Alt+N', 'Write in the typed note'],
      ['Shift+?', 'Show these shortcuts'],
    ],
  )
  assert.equal(rows.find((r) => r.does === 'Show these shortcuts')!.note, 'Not while typing in a field.')
  assert.equal(rows.find((r) => r.does === 'Write in the typed note')!.note, null)
  const onMac = shortcutRows(true)
  assert.deepEqual(onMac[0]!.keys, [['⌘', 'S']])
  assert.deepEqual(onMac[7]!.keys, [['Option', 'N']])
  assert.match(onMac[7]!.note!, /^Not while typing in a field/)
  assert.deepEqual([...PANEL_NAMES], ['Live transcription', 'Clinical inputs', 'Stethoscope', 'Doctor notes', 'Thermal'])
  assert.equal(isMacPlatform('MacIntel'), true)
  assert.equal(isMacPlatform('Win32'), false)
  assert.equal(isMacPlatform(undefined), false)
})
