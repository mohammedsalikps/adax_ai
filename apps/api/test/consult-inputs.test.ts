import { describe, expect, it } from 'vitest'
import { type DeviceReading, deviceStream, diffManifests, manifestOf, type SourceItem, staleSummary, withinBudget, withoutDeviceStream } from '../src/consult/inputs.ts'
import { renderUserMessage, sourceLine } from '../src/consult/prompt.ts'

// What fits in the model's context, and what a change to the record does to a draft made earlier: both decided from lists of items, with no database.

const item = (ref: string, priority: SourceItem['priority'], o: Partial<SourceItem> = {}): SourceItem => ({
  key: `k:${ref}`,
  ref,
  priority,
  sourceType: 'encounter_note',
  sourceId: null,
  encounterId: null,
  date: '2026-10-01',
  field: 'Field',
  status: 'recorded',
  provenance: 'record',
  text: 'x'.repeat(40),
  hash: `h-${ref}`,
  ...o,
})
const len = (i: SourceItem) => sourceLine(i).length + 1
const message = (items: SourceItem[]) => renderUserMessage({ patientLine: '90+ years, female', today: '2026-10-04', items })

describe('what fits the model’s context', () => {
  it('keeps everything, in order, when it all fits: this visit, the safety record, the latest consultation, the rest, and the newest first within each', () => {
    const all = [item('N9', 3, { date: '2025-01-01' }), item('A1', 1), item('R1', 0), item('N2', 2), item('N8', 3, { date: '2026-01-01' })]
    const r = withinBudget(all, 10_000)
    expect(r.omitted).toBe(0)
    expect(r.items.map((i) => i.ref)).toEqual(['R1', 'A1', 'N2', 'N8', 'N9'])
  })

  it('never goes over the budget, this visit’s items included, and says how many were left out', () => {
    // Forty confirmed points and a long note: more than any model context holds. The budget is a hard line.
    const points = Array.from({ length: 40 }, (_, n) => item(`F${n + 1}`, 0, { sourceType: 'clinical_fact', date: `2026-10-04T10:${String(n).padStart(2, '0')}:00Z` }))
    const own = [item('R1', 0, { sourceType: 'visit' }), item('C1', 0), item('V1', 0, { sourceType: 'observation' })]
    const rest = [item('A1', 1), item('H1', 1), item('N2', 2)]
    const budget = 1200
    const r = withinBudget([...rest, ...points, ...own], budget)
    expect(r.items.reduce((n, i) => n + len(i), 0)).toBeLessThanOrEqual(budget)
    // What is counted is what is sent: the whole message, the words around the sources included, is within the budget.
    expect(message(r.items).length).toBeLessThanOrEqual(budget)
    expect(r.items.length + r.omitted).toBe(46)
    // The reason, the note and the measurement come before any confirmed point, and the newest points before the older ones.
    expect(r.items.slice(0, 3).map((i) => i.ref).sort()).toEqual(['C1', 'R1', 'V1'])
    const keptPoints = r.items.filter((i) => i.sourceType === 'clinical_fact').map((i) => Number(i.ref.slice(1)))
    expect(keptPoints).toEqual([...keptPoints].sort((a, b) => b - a))
    expect(keptPoints.length).toBeGreaterThan(0)
    // And nothing from a lower class took a place that a point of this visit could have had.
    expect(r.items.some((i) => i.priority > 0)).toBe(false)
  })

  it('a budget too small for anything leaves nothing in and counts everything', () => {
    const r = withinBudget([item('R1', 0), item('A1', 1)], 10)
    expect(r).toEqual({ items: [], omitted: 2 })
  })
})

describe('what changed since a draft was made', () => {
  const a = item('A1', 1, { hash: 'h1' })
  const b = item('N1', 2, { hash: 'h2', field: 'Plan (today’s draft)' })
  const c = item('P1', 0, { hash: 'h3', field: 'Prescription (today’s draft)' })

  it('is told apart: an item that changed, one that went and one that is new', () => {
    const then = manifestOf([a, b])
    const now = manifestOf([{ ...a, hash: 'h1-changed' }, c])
    const d = diffManifests(then, now)
    expect(d.changed.map((m) => m.key)).toEqual([a.key])
    expect(d.removed.map((m) => m.key)).toEqual([b.key])
    expect(d.added.map((m) => m.key)).toEqual([c.key])
    expect(staleSummary(d)).toMatch(/1 changed, 1 added, 1 removed/)
    expect(staleSummary(d)).toMatch(/Generate a new draft/)
  })

  it('says nothing when nothing differs, whatever the order of the items', () => {
    const d = diffManifests(manifestOf([a, b, c]), manifestOf([c, a, b]))
    expect(d).toEqual({ changed: [], removed: [], added: [] })
    expect(staleSummary(d)).toBeNull()
  })

  it('names at most a few fields, without the words that only say it is today’s draft', () => {
    const many = Array.from({ length: 7 }, (_, n) => item(`X${n}`, 0, { hash: `n${n}`, field: `Field ${n} (today’s draft)` }))
    const s = staleSummary(diffManifests([], manifestOf(many)))!
    expect(s).toContain('Field 0;')
    expect(s).not.toContain('today’s draft')
    expect(s).toContain('…')
  })
})

describe('a device that keeps sending readings', () => {
  // The record keeps the newest five readings of each kind, visit and source. `readings` says which items are a device's readings (unverified, not
  // simulated, not entered in error, still this patient's), of which kind and visit, and when each was measured.
  const obs = (ref: string, field: string) => item(ref, 0, { sourceType: 'observation', field, hash: `h-${ref}` })
  const at = (minute: number) => Date.UTC(2026, 9, 4, 10, minute)
  const band = (kind: string, refs: string[], visit = 'v1', start = 0): [string, DeviceReading][] => refs.map((ref, n) => [`k:${ref}`, { stream: deviceStream(kind, visit), measuredAt: at(start + n) }])
  const heart = ['H1', 'H2', 'H3', 'H4', 'H5'].map((r) => obs(r, 'Heart rate'))

  it('newer readings of a kind the draft had, taking the place of its older ones, are no change: the draft is not stale', () => {
    // The draft had the band's five newest heart rates (minutes 0 to 4); two more came (5 and 6), and the two oldest left the newest five.
    const then = manifestOf(heart)
    const now = manifestOf([...heart.slice(2), obs('H6', 'Heart rate'), obs('H7', 'Heart rate')])
    const readings = new Map(band('heart_rate', ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']))
    const raw = diffManifests(then, now)
    expect(raw.added).toHaveLength(2)
    expect(raw.removed).toHaveLength(2)
    const d = withoutDeviceStream(raw, then, readings)
    expect(d).toEqual({ changed: [], removed: [], added: [] })
    expect(staleSummary(d)).toBeNull()
    // However many came: five newer ones push out all five the draft had.
    const later = ['H6', 'H7', 'H8', 'H9', 'H10']
    const all = new Map(band('heart_rate', ['H1', 'H2', 'H3', 'H4', 'H5', ...later]))
    expect(withoutDeviceStream(diffManifests(then, manifestOf(later.map((r) => obs(r, 'Heart rate')))), then, all)).toEqual({ changed: [], removed: [], added: [] })
  })

  it('everything else still counts: a first reading of a kind or at a visit the draft had none of, a reading that is no device reading of the patient any more, an older one coming back, a changed one, what staff measured', () => {
    const then = manifestOf(heart)
    const readings = new Map([
      ...band('heart_rate', ['H1', 'H2', 'H3', 'H4', 'H5'], 'v1', 10),
      // A kind the draft had no device reading of, and the same kind at another visit: new information, not a newer value of what it had.
      ...band('spo2', ['S1'], 'v1', 20),
      ...band('heart_rate', ['H8'], 'v2', 20),
      // Measured before the newest reading the draft had: it is not newer, it came back (another reading was taken off the record).
      ...band('heart_rate', ['H0'], 'v1', 0),
    ])
    const now = manifestOf([...heart.slice(0, 4).map((h) => (h.ref === 'H4' ? { ...h, hash: 'h-H4-changed' } : h)), obs('S1', 'SpO₂'), obs('H8', 'Heart rate'), obs('H0', 'Heart rate'), obs('M1', 'Temperature')])
    // H5 is gone and is not a device reading of the patient any more (it is not in `readings`: entered in error, say); M1 is what staff measured.
    readings.delete('k:H5')
    const d = withoutDeviceStream(diffManifests(then, now), then, readings)
    expect(d.changed.map((m) => m.ref)).toEqual(['H4'])
    expect(d.removed.map((m) => m.ref)).toEqual(['H5'])
    expect(d.added.map((m) => m.ref)).toEqual(['S1', 'H8', 'H0', 'M1'])
  })
})
