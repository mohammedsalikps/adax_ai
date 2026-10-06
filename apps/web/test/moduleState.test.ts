// Unit test (node --test) of how a consultation module remembers being open: per person and per module, only "open" or "closed", and
// never failing when the browser's storage is missing or refuses.
import assert from 'node:assert/strict'
import test from 'node:test'
import { type ModuleStorage, moduleStorage, moduleStorageKey, readModuleOpen, writeModuleOpen } from '../src/lib/moduleState.ts'

const memory = (): ModuleStorage & { items: Map<string, string> } => {
  const items = new Map<string, string>()
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) }
}

test('a choice is remembered for that person and that module only', () => {
  const s = memory()
  assert.equal(readModuleOpen(s, 'doc-1', 'vitals'), undefined, 'nothing chosen yet: the page decides')
  writeModuleOpen(s, 'doc-1', 'vitals', true)
  assert.equal(readModuleOpen(s, 'doc-1', 'vitals'), true)
  assert.equal(readModuleOpen(s, 'doc-1', 'thermal'), undefined, 'another module is not affected')
  assert.equal(readModuleOpen(s, 'doc-2', 'vitals'), undefined, 'another person on the same browser is not affected')
  writeModuleOpen(s, 'doc-1', 'vitals', false)
  assert.equal(readModuleOpen(s, 'doc-1', 'vitals'), false, 'closing is remembered too, not just forgotten')
  // What is stored: the person's id and the module in the key, open or closed as the value; nothing about a patient.
  assert.deepEqual([...s.items], [[moduleStorageKey('doc-1', 'vitals'), 'closed']])
  assert.equal(moduleStorageKey('doc-1', 'vitals'), 'adaxai.consultation-module.doc-1.vitals')
})

test('anything else stored under the key is no choice', () => {
  const s = memory()
  s.items.set(moduleStorageKey('doc-1', 'history'), 'true')
  assert.equal(readModuleOpen(s, 'doc-1', 'history'), undefined)
})

test('without a known person nothing is read or written', () => {
  const s = memory()
  writeModuleOpen(s, undefined, 'conversation', true)
  assert.equal(s.items.size, 0)
  s.items.set(moduleStorageKey('undefined', 'conversation'), 'open')
  assert.equal(readModuleOpen(s, undefined, 'conversation'), undefined)
})

test('storage that is missing or refuses changes nothing and throws nothing', () => {
  const refusing: ModuleStorage = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  assert.equal(readModuleOpen(refusing, 'doc-1', 'stethoscope'), undefined)
  assert.doesNotThrow(() => writeModuleOpen(refusing, 'doc-1', 'stethoscope', true))
  assert.equal(readModuleOpen(undefined, 'doc-1', 'stethoscope'), undefined)
  assert.doesNotThrow(() => writeModuleOpen(undefined, 'doc-1', 'stethoscope', true))
})

test('the browser storage accessor gives up quietly where there is no window, or reading localStorage throws', () => {
  const real = (globalThis as { window?: unknown }).window
  try {
    delete (globalThis as { window?: unknown }).window
    assert.equal(moduleStorage(), undefined)
    ;(globalThis as { window?: unknown }).window = Object.defineProperty({}, 'localStorage', {
      get() {
        throw new Error('SecurityError: site data is blocked')
      },
    })
    assert.equal(moduleStorage(), undefined)
    const s = memory()
    ;(globalThis as { window?: unknown }).window = { localStorage: s }
    assert.equal(moduleStorage(), s)
  } finally {
    if (real === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = real
  }
})
