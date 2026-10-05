// Unit tests (node --test) of the thermal camera adapters behind the thermal imaging workspace (V6): how a bridge's status is read, that the
// native adapter reports a connection only when the bridge says so and hands over the camera's own file and what the device reported, that the
// simulator is deterministic and plays a missing camera, that LIVE needs frames, that missing pixels never look like a temperature, that a
// disposed adapter (or one whose connect was abandoned) never drives the camera again, that only a camera date is sent as the capture time,
// and when a failed capture certainly stored nothing. No browser, no camera: the "bridge" here is a stand-in written in this file.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../src/lib/api.ts'
import { CameraReleasedError, colourize, CONNECT_TIMEOUT_MS, findNativeBridge, frameIsLive, LIVE_FRAME_MS, NativeBridgeAdapter, type NativeThermalBridge, type PreviewFrame, SimulatorAdapter, statusOf } from '../src/lib/thermalCamera.ts'
import { nothingStored, submitCapture } from '../src/lib/thermalCapture.ts'

const send = (target: EventTarget, detail: unknown) => target.dispatchEvent(new CustomEvent('adaxai-thermal', { detail }))

function standIn(over: Partial<NativeThermalBridge> = {}) {
  const calls: string[] = []
  const bridge: NativeThermalBridge = {
    bridgeInfo: () => JSON.stringify({ bridge: 'adaxai-thermal-android', version: '1', sdk: { name: 'FLIR Atlas Android SDK', version: '2.4.0', commitHash: 'abc' } }),
    getStatus: () => JSON.stringify({ state: 'disconnected', device: null, error: null }),
    getCapabilities: () => JSON.stringify({ radiometric: true, livePreview: true, capture: true }),
    getDeviceInfo: () => 'null',
    connect: () => void calls.push('connect'),
    disconnect: () => void calls.push('disconnect'),
    startPreview: () => void calls.push('startPreview'),
    stopPreview: () => void calls.push('stopPreview'),
    capture: (id) => void calls.push(`capture:${id}`),
    ...over,
  }
  return { bridge, calls }
}

test('a status the bridge sends is read as it is, and anything it does not say clearly becomes a camera error, never a guess', () => {
  assert.deepEqual(statusOf('{"state":"previewing","device":{"model":"FLIR ONE Pro","serialNumber":"123"},"error":null}'), {
    state: 'previewing',
    device: { model: 'FLIR ONE Pro', serialNumber: '123', programVersion: null, articleNumber: null, deviceId: null, interface: null },
    error: null,
  })
  const odd = statusOf('{"state":"streaming"}')
  assert.equal(odd.state, 'device_error')
  assert.equal(odd.error?.code, 'unknown_state')
  assert.equal(statusOf('not json').state, 'device_error')
  assert.equal(statusOf({ state: 'device_error', error: { code: 'USB', message: 'USB permission denied' } }).error?.message, 'USB permission denied')
})

test('the bridge is found only when the tablet app attached one of the version this page speaks', () => {
  assert.equal(findNativeBridge({}), null)
  assert.equal(findNativeBridge({ AdaxaiThermalNative: standIn({ bridgeInfo: () => '{"version":"2"}' }).bridge }), null)
  const { bridge } = standIn()
  assert.equal(findNativeBridge({ AdaxaiThermalNative: bridge }), bridge)
})

test('connect resolves only when the bridge reports a connection, and fails with the bridge’s own words', async () => {
  const target = new EventTarget()
  const { bridge, calls } = standIn()
  const a = new NativeBridgeAdapter(bridge, target)
  assert.equal(a.getStatus().state, 'disconnected')
  let done = false
  const p = a.connect().then(() => (done = true))
  assert.deepEqual(calls, ['connect'])
  send(target, { type: 'status', state: 'connecting' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(done, false, 'connecting is not connected')
  send(target, { type: 'status', state: 'connected', device: { model: 'FLIR ONE Pro', serialNumber: 'S1' } })
  await p
  assert.equal(a.getStatus().state, 'connected')
  const b = new NativeBridgeAdapter(standIn().bridge, target)
  const failing = b.connect()
  send(target, { type: 'status', state: 'device_error', error: { code: 'USB_PERMISSION', message: 'USB permission was not granted.' } })
  await assert.rejects(failing, /USB permission was not granted/)
  a.dispose()
  b.dispose()
})

test('the page waits for the camera longer than the bridge searches for it, and says that the tablet may be asking for USB permission', async (t) => {
  // The bridge looks for the FLIR ONE for 20 seconds (FlirOneCamera.kt) and then waits for the person to answer Android's USB prompt.
  assert.ok(CONNECT_TIMEOUT_MS > 20_000)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const target = new EventTarget()
  const a = new NativeBridgeAdapter(standIn().bridge, target)
  let settled = false
  const p = a.connect().finally(() => (settled = true))
  send(target, { type: 'status', state: 'connecting' })
  t.mock.timers.tick(CONNECT_TIMEOUT_MS - 1)
  await Promise.resolve()
  assert.equal(settled, false, 'still waiting just before the limit')
  t.mock.timers.tick(1)
  await assert.rejects(p, /within 45 seconds.*may be asking for permission to use the USB device/s)
  a.dispose()
})

test('a disposed bridge adapter stops the preview, ends a connect still waiting, and never drives the camera again', async () => {
  const target = new EventTarget()
  const { bridge, calls } = standIn()
  const a = new NativeBridgeAdapter(bridge, target)
  const statuses: string[] = []
  a.subscribe({ status: (s) => statuses.push(s.state) })
  const waiting = a.connect()
  a.dispose()
  await assert.rejects(waiting, CameraReleasedError)
  assert.deepEqual(calls, ['connect', 'stopPreview'])
  // It no longer hears the bridge, and asks nothing more of it.
  send(target, { type: 'status', state: 'connected' })
  assert.deepEqual(statuses, [])
  await a.startPreview()
  await a.stopPreview()
  await a.disconnect()
  await assert.rejects(a.connect(), CameraReleasedError)
  await assert.rejects(a.capture(), CameraReleasedError)
  assert.deepEqual(calls, ['connect', 'stopPreview'])
  // A capture still waiting when the adapter is disposed ends too.
  const b = new NativeBridgeAdapter(standIn().bridge, target)
  const shot = b.capture()
  b.dispose()
  await assert.rejects(shot, CameraReleasedError)
})

test('a frame from the bridge is the camera’s own rendered image; a capture is the camera’s own file with what the device reported', async () => {
  const target = new EventTarget()
  const { bridge, calls } = standIn()
  const a = new NativeBridgeAdapter(bridge, target)
  const frames: PreviewFrame[] = []
  a.subscribe({ frame: (f) => frames.push(f) })
  send(target, { type: 'frame', jpegBase64: 'AAEC', width: 480, height: 640, scaleMinC: 21.5, scaleMaxC: 34.2, at: '2026-10-05T10:00:00Z' })
  send(target, { type: 'frame', width: 480 })
  assert.equal(frames.length, 1, 'a frame without an image is dropped')
  assert.equal(frames[0]!.kind, 'image')
  assert.equal(frames[0]!.kind === 'image' && frames[0]!.src, 'data:image/jpeg;base64,AAEC')
  const shot = a.capture()
  const id = calls.at(-1)!.replace('capture:', '')
  send(target, { type: 'capture', requestId: 'someone-else', ok: true, fileBase64: 'AAAA' })
  send(target, {
    type: 'capture',
    requestId: id,
    ok: true,
    fileBase64: Buffer.from('radiometric bytes').toString('base64'),
    fileName: 'flir.jpg',
    capturedAt: '2026-10-05T10:00:01Z',
    capturedAtSource: 'camera',
    device: { model: 'FLIR ONE Pro', serialNumber: 'S1', programVersion: '1.2.3', interface: 'USB', sdk: { name: 'FLIR Atlas Android SDK', version: '2.4.0', commitHash: 'abc' }, bridge: { name: 'adaxai-thermal-android', version: '1' } },
  })
  const c = await shot
  assert.equal(c.kind, 'file')
  if (c.kind !== 'file') return
  assert.equal(await c.file.text(), 'radiometric bytes')
  assert.equal(c.fileName, 'flir.jpg')
  assert.equal(c.capturedAt, '2026-10-05T10:00:01Z')
  assert.equal(c.capturedAtSource, 'camera')
  assert.deepEqual(c.deviceReported, {
    model: 'FLIR ONE Pro',
    serialNumber: 'S1',
    programVersion: '1.2.3',
    articleNumber: null,
    deviceId: null,
    interface: 'USB',
    sdk: { name: 'FLIR Atlas Android SDK', version: '2.4.0', commitHash: 'abc' },
    bridge: { name: 'adaxai-thermal-android', version: '1' },
  })
  // A time the tablet filled in (the image carried no date), or one the bridge does not place, is not the camera's.
  for (const capturedAtSource of ['tablet', undefined, 'CAMERA']) {
    const next = a.capture()
    send(target, { type: 'capture', requestId: calls.at(-1)!.replace('capture:', ''), ok: true, fileBase64: 'AAAA', capturedAt: '2026-10-05T10:00:02Z', capturedAtSource, device: {} })
    const t = await next
    assert.equal(t.kind === 'file' && t.capturedAtSource, 'tablet', String(capturedAtSource))
  }
  const failed = a.capture()
  send(target, { type: 'capture', requestId: calls.at(-1)!.replace('capture:', ''), ok: false, error: { code: 'SAVE', message: 'The image could not be saved.' } })
  await assert.rejects(failed, /could not be saved/)
  a.dispose()
})

test('a live capture is sent with its capture time only when the camera gave it', async () => {
  const real = globalThis.fetch
  const sent: FormData[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(init.body as FormData)
    return new Response(JSON.stringify({ id: 'c1' }), { status: 201, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const base = { kind: 'file' as const, file: new Blob(['x']), fileName: 'flir.jpg', capturedAt: '2026-10-05T10:00:01Z', deviceReported: { model: 'FLIR ONE Pro', serialNumber: null, programVersion: null, articleNumber: null, deviceId: null, interface: null, sdk: null, bridge: null } }
    const protocol = { bodyRegion: 'Knee', bodySite: 'knee' as const, view: 'other' as const }
    await submitCapture('p1', 'e1', { ...base, capturedAtSource: 'camera' }, protocol)
    await submitCapture('p1', 'e1', { ...base, capturedAtSource: 'tablet' }, protocol)
    assert.equal(sent[0]!.get('capturedAt'), '2026-10-05T10:00:01Z')
    assert.equal(sent[0]!.get('captureSource'), 'live_capture')
    assert.equal(sent[1]!.get('capturedAt'), null, 'the tablet’s clock is not sent as the camera’s capture time')
  } finally {
    globalThis.fetch = real
  }
})

test('a failed capture is said to have stored nothing only when that is certain', () => {
  // The camera failed before anything was sent; the server refused (4xx).
  assert.equal(nothingStored(new Error('The camera could not capture the image.'), 'camera'), true)
  assert.equal(nothingStored(new ApiError(422, 'thermal_invalid', 'Invalid capture'), 'server'), true)
  assert.equal(nothingStored(new ApiError(409, 'consent_withdrawn', 'Consent withdrawn'), 'server'), true)
  // The answer was lost, or a gateway or the server failed: the server may have stored it.
  assert.equal(nothingStored(new ApiError(0, 'network_error', 'Cannot reach the server.'), 'server'), false)
  assert.equal(nothingStored(new ApiError(504, 'service_unavailable', 'Unavailable'), 'server'), false)
  assert.equal(nothingStored(new ApiError(500, 'http_error', 'The server reported a problem.'), 'server'), false)
  assert.equal(nothingStored(new TypeError('failed'), 'server'), false)
})

test('the simulator is deterministic, plays a missing camera when asked, and its capture is its case and seed (the server makes the numbers)', async () => {
  const gone = new SimulatorAdapter('disconnected', 1)
  await assert.rejects(gone.connect(), /FLIR ONE not connected \(SIMULATED/)
  assert.equal(gone.getStatus().state, 'disconnected')
  await assert.rejects(gone.capture(), /not connected/)

  const first = async (seed: number) => {
    const s = new SimulatorAdapter('localized_difference', seed)
    await s.connect()
    assert.equal(s.getStatus().state, 'connected')
    assert.match(s.getDeviceInfo()?.model ?? '', /SIMULATED/)
    const got = new Promise<PreviewFrame>((resolve) => s.subscribe({ frame: resolve }))
    await s.startPreview()
    const f = await got
    assert.equal(s.getStatus().state, 'previewing')
    await s.disconnect()
    assert.equal(s.getStatus().state, 'disconnected')
    return f
  }
  const a = await first(7)
  const b = await first(7)
  assert.ok(a.kind === 'matrix' && b.kind === 'matrix')
  if (a.kind === 'matrix' && b.kind === 'matrix') assert.deepEqual(Array.from(a.matrix.slice(0, 50)), Array.from(b.matrix.slice(0, 50)))
  // As with the bridge, an image is captured only from a running live view (this changed in V6: the simulator used to capture without one).
  const s = new SimulatorAdapter('invalid_capture', 3)
  await s.connect()
  await assert.rejects(s.capture(), /Start the live view/)
  await s.startPreview()
  assert.deepEqual(await s.capture(), { kind: 'simulated', case: 'invalid_capture', seed: 3 })
  s.dispose()
})

test('a simulator closed or disconnected during its connect starts nothing afterwards', async () => {
  for (const end of ['dispose', 'disconnect'] as const) {
    const s = new SimulatorAdapter('normal', 1)
    const frames: PreviewFrame[] = []
    s.subscribe({ frame: (f) => frames.push(f) })
    const waiting = s.connect()
    assert.equal(s.getStatus().state, 'connecting')
    if (end === 'dispose') s.dispose()
    else await s.disconnect()
    await assert.rejects(waiting, CameraReleasedError, end)
    assert.notEqual(s.getStatus().state, 'connected', end)
    // Even asked to, it streams nothing: no preview timer is left running.
    await s.startPreview().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(frames.length, 0, end)
    s.dispose()
  }
  const gone = new SimulatorAdapter('normal', 1)
  gone.dispose()
  await assert.rejects(gone.connect(), CameraReleasedError)
  await assert.rejects(gone.capture(), CameraReleasedError)
})

test('LIVE needs a frame within the last two seconds', () => {
  assert.equal(frameIsLive(null, 1000), false)
  assert.equal(frameIsLive(1000, 1000 + LIVE_FRAME_MS), true)
  assert.equal(frameIsLive(1000, 1001 + LIVE_FRAME_MS), false)
})

test('a pixel without a reading is drawn grey, never as a temperature', () => {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) lut.set([i, 255 - i, 0], i * 3)
  const px = colourize(new Float32Array([20, 40, Number.NaN, 30]), 4, 1, lut, 20, 40)
  assert.deepEqual(Array.from(px.slice(0, 4)), [0, 255, 0, 255])
  assert.deepEqual(Array.from(px.slice(4, 8)), [255, 0, 0, 255])
  const [r, g, b] = Array.from(px.slice(8, 11))
  assert.ok(r === g && g === b, 'grey')
  assert.equal(px[11], 255)
})
