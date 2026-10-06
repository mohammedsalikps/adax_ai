import type { DoctorDayTimelineRow } from '@adaxai/contracts'
import { useEffect, useRef } from 'react'
import { readyArrivals, readyMessage, type ReadySnapshot, readySnapshot } from '../../lib/doctorDay.ts'
import { useToast } from '../ui/Toast.tsx'

/**
 * The patient-ready cue (DESIGN §5.2): when a patient becomes ready for the doctor between two answers of the doctor's day, a polite toast
 * says so ("Anaya Demo-Synthetic is ready for you"; the toast region is an aria-live polite region, so a screen reader hears it once). A
 * client diff of the existing poll; no new backend. Nothing is announced for what the page shows when it opens.
 */
export function useReadyCue(rows: readonly DoctorDayTimelineRow[] | undefined) {
  const toast = useToast()
  const previous = useRef<ReadySnapshot>(null)
  useEffect(() => {
    if (!rows) return
    const arrived = readyArrivals(previous.current, rows)
    previous.current = readySnapshot(rows)
    if (arrived.length) toast('success', readyMessage(arrived.map((r) => r.patient.fullName)))
  }, [rows, toast])
}
