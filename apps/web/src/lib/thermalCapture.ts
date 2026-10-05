import type { CaptureProtocol, ThermalCapture } from '@adaxai/contracts'
import { api, ApiError } from './api.ts'
import type { CameraCapture } from './thermalCamera.ts'

/**
 * Hands a capture from the thermal imaging workspace to ADAXAI (V6), for the consultation's patient and encounter. A camera's capture is its
 * own radiometric file, uploaded as it is (the server keeps the original, its hash and what the device reported, and measures it); the
 * simulator's is its case and seed, and the server generates and stores the numbers as SIMULATED. The text fields go before the file: the
 * server reads only the fields that come first. The capture time is sent only when the bridge says it came from the camera: a time the
 * tablet filled in is not the camera's, and the server then records none.
 */
export function submitCapture(patientId: string, encounterId: string, c: CameraCapture, protocol: CaptureProtocol): Promise<ThermalCapture> {
  if (c.kind === 'simulated') return api<ThermalCapture>(`/patients/${patientId}/thermal/simulate`, { method: 'POST', body: { case: c.case, seed: c.seed, encounterId, protocol } })
  const fd = new FormData()
  fd.append('captureSource', 'live_capture')
  fd.append('encounterId', encounterId)
  fd.append('protocol', JSON.stringify(protocol))
  if (c.capturedAt && c.capturedAtSource === 'camera') fd.append('capturedAt', c.capturedAt)
  fd.append('deviceReported', JSON.stringify(c.deviceReported))
  fd.append('file', c.file, c.fileName)
  return api<ThermalCapture>(`/patients/${patientId}/thermal`, { method: 'POST', body: fd })
}

/**
 * Whether a failed capture certainly stored nothing: the camera failed before anything was sent, or the server answered with a refusal (4xx).
 * Otherwise (the connection dropped, a gateway or the server failed) the server may have stored the image before the answer was lost.
 */
export function nothingStored(e: unknown, stage: 'camera' | 'server'): boolean {
  if (stage === 'camera') return true
  return e instanceof ApiError && e.status >= 400 && e.status < 500
}
