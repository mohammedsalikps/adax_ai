/*
 * The amplitude envelope of a recording, worked out from its decoded samples: how loud it is over time, nothing more. JSX-free, so that it is
 * tested without a browser (Waveform.tsx draws it). Nothing here listens for, measures, classifies or flags a sound.
 */

/** How many slices of the recording are kept (the picture is drawn from these at any width). */
export const ENVELOPE_BUCKETS = 480

export interface Envelope {
  /** Per slice, the largest absolute sample (0 to 1, full scale), over all channels. */
  peak: Float32Array
  /** Per slice, the root mean square over all channels (0 to 1). */
  rms: Float32Array
  /** The decoded length, in seconds. */
  duration: number
  /** The loudest sample of the whole recording (0 to 1, full scale): the picture is drawn relative to it. */
  max: number
}

/** Per slice of the samples (as many slices as `buckets`, or as samples when there are fewer), the peak and the RMS over all channels. */
export function envelopeOf(channels: ArrayLike<number>[], duration: number, buckets = ENVELOPE_BUCKETS): Envelope {
  const length = channels[0]?.length ?? 0
  const n = Math.max(1, Math.min(buckets, length))
  const peak = new Float32Array(n)
  const rms = new Float32Array(n)
  let max = 0
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * length) / n)
    const to = Math.max(from + 1, Math.floor(((b + 1) * length) / n))
    let p = 0
    let sum = 0
    let count = 0
    for (const ch of channels) {
      for (let i = from; i < to && i < length; i++) {
        const v = Math.abs(ch[i] ?? 0)
        if (v > p) p = v
        sum += v * v
        count++
      }
    }
    peak[b] = p
    rms[b] = count ? Math.sqrt(sum / count) : 0
    if (p > max) max = p
  }
  return { peak, rms, duration, max }
}

/** A length in seconds as m:ss. */
export const clockOf = (seconds: number) => {
  const t = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
