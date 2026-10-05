import type { Observation, VitalKind } from '@adaxai/contracts'

const measuredByStaff = (o: Observation) => o.source !== 'device'

/**
 * The reading that stands for each kind: a visit can hold several (a re-check), and only the latest says how the patient stands now. What staff
 * measured stands over what a device sent: a device sends a value every few seconds and none is verified, so its newest value takes the place of
 * a measurement only where staff took none of that kind. (A simulator's values are never in a visit's vital signs at all: the server leaves
 * them out.)
 */
export function latestPerKind(vitals: Observation[]): Observation[] {
  const standing = new Map<VitalKind, Observation>()
  for (const o of vitals) {
    const current = standing.get(o.kind)
    const better = !current || (measuredByStaff(o) !== measuredByStaff(current) ? measuredByStaff(o) : o.measuredAt > current.measuredAt)
    if (better) standing.set(o.kind, o)
  }
  return [...standing.values()]
}

/**
 * How the latest reading of each kind stands against the adult reference range (a display aid, not a diagnosis; children and kinds
 * without a range are not flagged). `fromDevice` counts readings that came from a device that is not validated in this deployment.
 */
export function vitalsStatus(vitals: Observation[]): { total: number; outside: Observation[]; flagged: boolean; fromDevice: number } {
  const latest = latestPerKind(vitals)
  return {
    total: latest.length,
    outside: latest.filter((o) => o.flag && o.flag !== 'normal'),
    flagged: latest.some((o) => o.flag !== null),
    fromDevice: latest.filter((o) => o.source === 'device').length,
  }
}
