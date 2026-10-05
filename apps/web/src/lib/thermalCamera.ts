import { simulateThermalMatrix, THERMAL_SIM_SIZE, thermalStats, type ThermalDeviceReported, type ThermalSimCase, type ThermalSimMatrixCase } from '@adaxai/contracts'

/*
 * The thermal camera, as the consultation's thermal imaging workspace sees it (V6). One interface (`ThermalCameraAdapter`), so the screen
 * never talks to a vendor: the FLIR ONE is reached through the native Android bridge (`NativeBridgeAdapter`, contract v1 in
 * docs/THERMAL_CAMERA.md), and the simulator (`SimulatorAdapter`) stands in for a camera in tests, development and demonstrations, labelled
 * SIMULATED wherever it appears. A browser cannot reach a FLIR ONE's radiometric data (it is not a webcam): without the bridge there is no
 * camera, and the screen says so. Nothing here ever invents a frame or a temperature for a real camera.
 */

/** The states the workspace shows. `processing` is ADAXAI's own step after a capture (storing and measuring), not the camera's. */
export const CAMERA_STATES = {
  disconnected: 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  previewing: 'Live',
  capturing: 'Capturing',
  processing: 'Processing',
  capture_failed: 'Capture failed',
  device_error: 'Camera error',
} as const
export type CameraState = keyof typeof CAMERA_STATES

export interface CameraDeviceInfo {
  model: string | null
  serialNumber: string | null
  /** Firmware ("program version" in the FLIR SDK). */
  programVersion: string | null
  articleNumber: string | null
  deviceId: string | null
  interface: string | null
}
export interface CameraCapabilities {
  radiometric: boolean
  livePreview: boolean
  capture: boolean
}
export interface CameraStatus {
  state: CameraState
  device: CameraDeviceInfo | null
  error: { code: string; message: string } | null
}

/** One preview frame: an image the camera's own software rendered (the bridge), or numbers to colour here (the simulator). */
export type PreviewFrame =
  | { kind: 'image'; src: string; width: number; height: number; minC: number | null; maxC: number | null; at: number }
  | { kind: 'matrix'; matrix: Float32Array; width: number; height: number; minC: number | null; maxC: number | null; at: number }

/**
 * What a capture hands over: the camera's own radiometric file (bridge), or the simulator's case and seed (the server makes the numbers).
 * `capturedAtSource` says where the bridge got `capturedAt`: `camera` when the image carried its own date, `tablet` when it did not and the
 * tablet's clock was used (also when the bridge did not say). Only a camera date is the camera's capture time.
 */
export type CameraCapture =
  | { kind: 'file'; file: Blob; fileName: string; capturedAt: string | null; capturedAtSource: 'camera' | 'tablet'; deviceReported: ThermalDeviceReported }
  | { kind: 'simulated'; case: Exclude<ThermalSimCase, 'disconnected'>; seed: number }

export interface CameraListener {
  status?: (s: CameraStatus) => void
  frame?: (f: PreviewFrame) => void
}

export interface ThermalCameraAdapter {
  readonly kind: 'native_bridge' | 'simulator'
  /** What to call it on the screen. */
  readonly label: string
  readonly simulated: boolean
  getStatus(): CameraStatus
  getDeviceInfo(): CameraDeviceInfo | null
  getCapabilities(): CameraCapabilities
  connect(): Promise<void>
  disconnect(): Promise<void>
  startPreview(): Promise<void>
  stopPreview(): Promise<void>
  capture(): Promise<CameraCapture>
  /** Status changes and preview frames; returns the way to stop listening. */
  subscribe(listener: CameraListener): () => void
  /**
   * Lets the camera go for good: stops the preview, stops listening, and ends a connect or a capture still waiting (with
   * `CameraReleasedError`). Everything after it does nothing, so an adapter the screen has replaced can never drive the camera again.
   */
  dispose(): void
}

/** A connect or capture that ended because the adapter was disposed or disconnected meanwhile: nothing failed, nobody is waiting for it. */
export class CameraReleasedError extends Error {
  constructor(message = 'The camera was released before this finished.') {
    super(message)
    this.name = 'CameraReleasedError'
  }
}

/** A preview is called LIVE only while frames keep arriving: the last one at most this long ago. */
export const LIVE_FRAME_MS = 2000
export const frameIsLive = (lastFrameAt: number | null, now: number) => lastFrameAt !== null && now - lastFrameAt <= LIVE_FRAME_MS

class Listeners {
  private all = new Set<CameraListener>()
  add(l: CameraListener) {
    this.all.add(l)
    return () => void this.all.delete(l)
  }
  status(s: CameraStatus) {
    for (const l of this.all) l.status?.(s)
  }
  frame(f: PreviewFrame) {
    for (const l of this.all) l.frame?.(f)
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The native bridge (contract v1): the Android host attaches `AdaxaiThermalNative` to the page and reports through 'adaxai-thermal' events.
// ---------------------------------------------------------------------------------------------------------------------------------------

/** What the Android host exposes (WebView JavascriptInterface): synchronous calls that return JSON text; slow work is answered by events. */
export interface NativeThermalBridge {
  bridgeInfo(): string
  getStatus(): string
  getCapabilities(): string
  getDeviceInfo(): string
  connect(): void
  disconnect(): void
  startPreview(): void
  stopPreview(): void
  capture(requestId: string): void
}
export const BRIDGE_VERSION = '1'
export const BRIDGE_EVENT = 'adaxai-thermal'

const parse = (text: unknown): Record<string, unknown> | null => {
  if (text && typeof text === 'object') return text as Record<string, unknown>
  if (typeof text !== 'string') return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const STATES = new Set<string>(Object.keys(CAMERA_STATES))

function deviceOf(v: unknown): CameraDeviceInfo | null {
  const d = parse(v)
  if (!d) return null
  return { model: str(d.model), serialNumber: str(d.serialNumber), programVersion: str(d.programVersion), articleNumber: str(d.articleNumber), deviceId: str(d.deviceId), interface: str(d.interface) }
}

/** A status the bridge reported, read defensively: anything it did not say clearly is not invented (an unknown state is a camera error). */
export function statusOf(v: unknown): CameraStatus {
  const s = parse(v)
  if (!s) return { state: 'device_error', device: null, error: { code: 'bridge_unreadable', message: 'The camera bridge sent a status this page could not read.' } }
  const known = typeof s.state === 'string' && STATES.has(s.state)
  const state = known ? (s.state as CameraState) : 'device_error'
  const e = parse(s.error)
  const error = e
    ? { code: str(e.code) ?? 'error', message: str(e.message) ?? 'The camera reported an error.' }
    : known
      ? null
      : { code: 'unknown_state', message: `The camera bridge reported a state this page does not know (${String(s.state).slice(0, 40)}).` }
  return { state, device: deviceOf(s.device), error }
}

/** The bridge on this page, if the Android host attached one of the version this page speaks; null in an ordinary browser. */
export function findNativeBridge(scope: unknown = globalThis): NativeThermalBridge | null {
  const b = (scope as { AdaxaiThermalNative?: NativeThermalBridge }).AdaxaiThermalNative
  if (!b || typeof b.bridgeInfo !== 'function') return null
  const info = parse(b.bridgeInfo())
  return info && info.version === BRIDGE_VERSION ? b : null
}

/** The bridge's own description (its version and the vendor SDK's), for the screen and the capture's provenance. */
export function bridgeInfoOf(b: NativeThermalBridge): { bridge: string; version: string; sdk: { name: string; version: string | null; commitHash: string | null } | null } {
  const info = parse(b.bridgeInfo()) ?? {}
  const sdk = parse(info.sdk)
  return { bridge: str(info.bridge) ?? 'unknown', version: str(info.version) ?? '?', sdk: sdk ? { name: str(sdk.name) ?? 'unknown', version: str(sdk.version), commitHash: str(sdk.commitHash) } : null }
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

/**
 * How long the page waits for the camera to connect, and for a capture to come back, before it says it failed. The bridge looks for the
 * FLIR ONE on USB for up to 20 seconds (DISCOVERY_TIMEOUT_MS in FlirOneCamera.kt) and then waits, without a limit, for the person to answer
 * Android's USB permission prompt; the page waits longer than the search, so that the bridge's own "not found" is what the page says when
 * there is no camera, and a slow answer to the prompt still has time. A camera that connects after the page gave up is shown as connected
 * and offered "Start live view".
 */
export const CONNECT_TIMEOUT_MS = 45_000
const CAPTURE_TIMEOUT_MS = 20_000

export class NativeBridgeAdapter implements ThermalCameraAdapter {
  readonly kind = 'native_bridge'
  readonly simulated = false
  readonly label: string
  private listeners = new Listeners()
  private status: CameraStatus
  private pending = new Map<string, { resolve: (c: CameraCapture) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  private disposed = false
  /** Ends the connect() still waiting for the bridge, if any. */
  private abandonConnect: ((e: Error) => void) | null = null
  private readonly onEvent = (e: Event) => this.handle((e as CustomEvent).detail)

  constructor(
    private readonly bridge: NativeThermalBridge,
    private readonly target: EventTarget = globalThis as unknown as EventTarget,
  ) {
    this.label = 'FLIR ONE (USB-C)'
    this.status = statusOf(bridge.getStatus())
    target.addEventListener(BRIDGE_EVENT, this.onEvent)
  }

  /**
   * Stops the preview and stops listening to the bridge (the workspace calls it when it closes, or when it uses the simulator instead). The
   * camera stays connected, so that the next workspace can start its live view without connecting again.
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.bridge.stopPreview()
    this.target.removeEventListener(BRIDGE_EVENT, this.onEvent)
    this.abandonConnect?.(new CameraReleasedError())
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new CameraReleasedError('The thermal imaging workspace was closed before the capture came back.'))
    }
    this.pending.clear()
  }

  private setStatus(s: CameraStatus) {
    this.status = s
    this.listeners.status(s)
  }

  private handle(detail: unknown) {
    const d = parse(detail)
    if (!d) return
    if (d.type === 'status') this.setStatus(statusOf(d))
    else if (d.type === 'frame') {
      const b64 = str(d.jpegBase64)
      const width = num(d.width)
      const height = num(d.height)
      if (!b64 || !width || !height) return
      this.listeners.frame({ kind: 'image', src: `data:image/jpeg;base64,${b64}`, width, height, minC: num(d.scaleMinC), maxC: num(d.scaleMaxC), at: Date.now() })
    } else if (d.type === 'capture') {
      const id = str(d.requestId)
      const p = id ? this.pending.get(id) : undefined
      if (!p || !id) return
      clearTimeout(p.timer)
      this.pending.delete(id)
      const fileBase64 = str(d.fileBase64)
      if (d.ok !== true || !fileBase64) {
        const e = parse(d.error)
        p.reject(new Error(str(e?.message) ?? 'The camera could not capture the image.'))
        return
      }
      const dev = parse(d.device) ?? {}
      const sdk = parse(dev.sdk)
      const br = parse(dev.bridge)
      const info = deviceOf(dev)
      const deviceReported: ThermalDeviceReported = {
        model: info?.model ?? null,
        serialNumber: info?.serialNumber ?? null,
        programVersion: info?.programVersion ?? null,
        articleNumber: info?.articleNumber ?? null,
        deviceId: info?.deviceId ?? null,
        interface: info?.interface ?? null,
        sdk: sdk ? { name: str(sdk.name) ?? 'unknown', version: str(sdk.version), commitHash: str(sdk.commitHash) } : null,
        bridge: br ? { name: str(br.name) ?? 'unknown', version: str(br.version) ?? '?' } : null,
      }
      // Outside contract v1: where capturedAt came from. Anything but a plain 'camera' is the tablet's clock (BridgeJson.captureOk).
      const capturedAtSource = d.capturedAtSource === 'camera' ? 'camera' : 'tablet'
      p.resolve({ kind: 'file', file: base64ToBlob(fileBase64, 'image/jpeg'), fileName: str(d.fileName) ?? 'flir-one-capture.jpg', capturedAt: str(d.capturedAt), capturedAtSource, deviceReported })
    }
  }

  getStatus() {
    return this.status
  }
  getDeviceInfo() {
    return deviceOf(this.bridge.getDeviceInfo())
  }
  getCapabilities(): CameraCapabilities {
    const c = parse(this.bridge.getCapabilities()) ?? {}
    return { radiometric: c.radiometric === true, livePreview: c.livePreview === true, capture: c.capture === true }
  }
  subscribe(l: CameraListener) {
    return this.listeners.add(l)
  }

  /** Asks the bridge to connect, and resolves only when it says it is connected: never on a guess. */
  connect() {
    if (this.disposed) return Promise.reject(new CameraReleasedError())
    this.abandonConnect?.(new CameraReleasedError())
    return new Promise<void>((resolve, reject) => {
      const end = (e?: Error) => {
        clearTimeout(timer)
        stop()
        if (this.abandonConnect === abandon) this.abandonConnect = null
        if (e) reject(e)
        else resolve()
      }
      const abandon = (e: Error) => end(e)
      const timer = setTimeout(
        () =>
          end(
            new Error(
              `The camera did not connect within ${CONNECT_TIMEOUT_MS / 1000} seconds. Check that the FLIR ONE is plugged into the USB-C port and switched on. The tablet may be asking for permission to use the USB device: answer it, and connect again if the camera is not shown as connected.`,
            ),
          ),
        CONNECT_TIMEOUT_MS,
      )
      const stop = this.listeners.add({
        status: (s) => {
          if (s.state === 'connected' || s.state === 'previewing') end()
          else if (s.state === 'device_error' || (s.state === 'disconnected' && s.error)) end(new Error(s.error?.message ?? 'The camera could not be connected.'))
        },
      })
      this.abandonConnect = abandon
      this.bridge.connect()
    })
  }
  async disconnect() {
    if (this.disposed) return
    this.abandonConnect?.(new CameraReleasedError())
    this.bridge.disconnect()
  }
  async startPreview() {
    if (!this.disposed) this.bridge.startPreview()
  }
  async stopPreview() {
    if (!this.disposed) this.bridge.stopPreview()
  }
  capture() {
    if (this.disposed) return Promise.reject(new CameraReleasedError())
    const requestId = `cap-${Date.now()}-${this.nextId++}`
    return new Promise<CameraCapture>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The camera did not return the capture in time.'))
      }, CAPTURE_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      this.bridge.capture(requestId)
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The simulator: a camera that is not there. Deterministic for a case and seed; everything it shows and captures is SIMULATED.
// ---------------------------------------------------------------------------------------------------------------------------------------

/** About 8 preview frames a second, like a FLIR ONE's stream (nothing depends on the match). */
const SIM_FRAME_MS = 125

export class SimulatorAdapter implements ThermalCameraAdapter {
  readonly kind = 'simulator'
  readonly simulated = true
  readonly label = 'Thermal camera simulator'
  private listeners = new Listeners()
  private status: CameraStatus = { state: 'disconnected', device: null, error: null }
  private timer: ReturnType<typeof setInterval> | null = null
  private frameNo = 0
  private disposed = false
  /** The connect() still waiting out its pretend search, if any: a disconnect or dispose ends it, so nothing starts after it. */
  private connecting: { wait: ReturnType<typeof setTimeout>; end: (e: Error | null) => void } | null = null

  constructor(
    readonly simCase: ThermalSimCase,
    readonly seed: number,
  ) {}

  private set(s: CameraStatus) {
    this.status = s
    this.listeners.status(s)
  }
  private device(): CameraDeviceInfo {
    return { model: 'ADAXAI thermal simulator (SIMULATED)', serialNumber: null, programVersion: null, articleNumber: null, deviceId: `simulator:${this.simCase}:${this.seed}`, interface: 'SIMULATED' }
  }
  /** The numbers a preview frame shows: the case's own (the failure cases preview an even image; they fail at capture). */
  private matrixCase(): ThermalSimMatrixCase {
    return this.simCase === 'localized_difference' || this.simCase === 'high_variance' || this.simCase === 'missing_data' ? this.simCase : 'normal'
  }

  getStatus() {
    return this.status
  }
  getDeviceInfo() {
    return this.status.device
  }
  getCapabilities() {
    return { radiometric: true, livePreview: true, capture: true }
  }
  subscribe(l: CameraListener) {
    return this.listeners.add(l)
  }

  /** Ends a connect still waiting (it rejects with CameraReleasedError and changes nothing). */
  private abandonConnect() {
    const c = this.connecting
    if (!c) return
    this.connecting = null
    clearTimeout(c.wait)
    c.end(new CameraReleasedError())
  }

  async connect() {
    if (this.disposed) throw new CameraReleasedError()
    this.abandonConnect()
    this.set({ state: 'connecting', device: null, error: null })
    // A pretend USB search of 300 ms, which a disconnect or dispose ends at once.
    await new Promise<void>((resolve, reject) => {
      const attempt = {
        wait: setTimeout(() => {
          if (this.connecting === attempt) this.connecting = null
          resolve()
        }, 300),
        end: (e: Error | null) => (e ? reject(e) : resolve()),
      }
      this.connecting = attempt
    })
    if (this.simCase === 'disconnected') {
      const error = { code: 'not_found', message: 'FLIR ONE not connected (SIMULATED: the simulator is playing a camera that is not there).' }
      this.set({ state: 'disconnected', device: null, error })
      throw new Error(error.message)
    }
    this.set({ state: 'connected', device: this.device(), error: null })
  }
  async disconnect() {
    if (this.disposed) return
    this.abandonConnect()
    await this.stopPreview()
    this.set({ state: 'disconnected', device: null, error: null })
  }
  dispose() {
    if (this.disposed) return
    this.abandonConnect()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.disposed = true
  }
  async startPreview() {
    if (this.disposed) return
    if (this.status.state !== 'connected' && this.status.state !== 'previewing') throw new Error('Connect the camera first.')
    if (this.timer) return
    this.set({ ...this.status, state: 'previewing' })
    const { width, height } = THERMAL_SIM_SIZE
    const tick = () => {
      const matrix = simulateThermalMatrix(this.matrixCase(), this.seed, this.frameNo++)
      const s = thermalStats(matrix)
      this.listeners.frame({ kind: 'matrix', matrix, width, height, minC: s.minC, maxC: s.maxC, at: Date.now() })
    }
    tick()
    this.timer = setInterval(tick, SIM_FRAME_MS)
  }
  async stopPreview() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.status.state === 'previewing') this.set({ ...this.status, state: 'connected' })
  }
  async capture(): Promise<CameraCapture> {
    if (this.disposed) throw new CameraReleasedError()
    if (this.simCase === 'disconnected') throw new Error('FLIR ONE not connected (SIMULATED).')
    // As the bridge does: an image is captured only from a running live view.
    if (this.status.state !== 'previewing') throw new Error('Start the live view and wait for the image before capturing (SIMULATED).')
    return { kind: 'simulated', case: this.simCase, seed: this.seed }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Drawing a matrix frame.
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * RGBA pixels for a temperature matrix with a 256-entry RGB palette over [minC, maxC]. A pixel without a reading (NaN) is drawn in grey
 * (`noReading` gives its shade: the stored-image viewer's stripes, so one legend serves both), so missing data never looks like a temperature.
 */
export function colourize(matrix: ArrayLike<number>, width: number, height: number, lut: Uint8ClampedArray, minC: number, maxC: number, noReading?: (x: number, y: number) => readonly [number, number, number]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4)
  const span = maxC > minC ? maxC - minC : 1
  for (let i = 0; i < width * height; i++) {
    const v = matrix[i]!
    const o = i * 4
    if (!Number.isFinite(v)) {
      const x = i % width
      const y = Math.floor(i / width)
      const g = (x >> 2) % 2 === (y >> 2) % 2 ? 150 : 110
      const [r, gr, b] = noReading ? noReading(x, y) : [g, g, g]
      out[o] = r
      out[o + 1] = gr
      out[o + 2] = b
    } else {
      const k = Math.max(0, Math.min(255, Math.round(((v - minC) / span) * 255))) * 3
      out[o] = lut[k]!
      out[o + 1] = lut[k + 1]!
      out[o + 2] = lut[k + 2]!
    }
    out[o + 3] = 255
  }
  return out
}
