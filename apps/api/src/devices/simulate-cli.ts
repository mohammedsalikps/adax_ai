// THE DEVICE SIMULATOR, as a program. It is not a device and not a gateway for one: it generates values from a seed (src/devices/simulator.ts) and
// posts them to the gateway API exactly as a gateway would, with the token of a device record that was REGISTERED AS A SIMULATOR. The server then
// stores what it sends as `simulated`. It refuses to post through a token that belongs to anything else.
//
//   npm run devices:simulate                                  (the band of `npm run demo:devices`, steady values, until Ctrl+C)
//   npm run devices:simulate -- --scenario rising_heart_rate --count 40
//   npm run devices:simulate -- --scenario dropout             (goes silent for a while: the screen shows stale, then disconnected)
//   npm run devices:simulate -- --recording                    (one generated-tones "recording" through the stethoscope simulator, then stops)
//
// Options: --token-file <path> (default .data/sim/SIM-BAND-1.token, or SIM-STETH-1.token with --recording; or the environment variable
// ADAXAI_SIM_TOKEN), --url (default the local API), --scenario, --seed <n>, --interval <seconds> (default 5), --count <ticks> (default 0: until
// stopped), --recording, --site <auscultation site>. The token is never printed. For development and tests only: the server refuses a simulator
// in a clinical or production deployment.
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, REPO_ROOT } from '../config.ts'
import { isSimScenario, SIM_SCENARIOS, type SimRun, type SimScenario, simulatedBatch, simulatedTick, simulatedToneWav, SIMULATOR_VERSION } from './simulator.ts'

/** Ends the program with a message and an exit code, by unwinding: the process is left to finish on its own (no exit in the middle of a request). */
class Stop extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message)
  }
}
const say = (msg: string) => console.log(`[simulator] ${msg}`)

async function main(argv: string[]): Promise<void> {
  const opt = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback
  }
  const url = opt('url', `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || '4000'}`).replace(/\/+$/, '')
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && !argv.includes('--allow-non-loopback')) throw new Stop(`${host} is not this computer. The simulator posts to a local development server; pass --allow-non-loopback to post elsewhere on purpose.`)
  const asked = opt('scenario', 'steady')
  if (!isSimScenario(asked)) throw new Stop(`unknown scenario "${asked}". Scenarios: ${Object.entries(SIM_SCENARIOS).map(([k, v]) => `\n  ${k}: ${v}`).join('')}`)
  const scenario: SimScenario = asked
  const seed = Number.parseInt(opt('seed', '1'), 10)
  const intervalMs = Math.max(1, Number.parseFloat(opt('interval', '5'))) * 1000
  const count = Number.parseInt(opt('count', '0'), 10)
  const recording = argv.includes('--recording')
  const tokenFile = path.resolve(REPO_ROOT, opt('token-file', path.join('.data', 'sim', recording ? 'SIM-STETH-1.token' : 'SIM-BAND-1.token')))
  const token = (process.env.ADAXAI_SIM_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim()
  if (!token) throw new Stop(`no simulator token. Run \`npm run demo:devices\` (it registers the simulator records and writes ${path.relative(REPO_ROOT, tokenFile)}), or set ADAXAI_SIM_TOKEN.`)

  const headers = { authorization: `Bearer ${token}`, 'x-adaxai-csrf': '1' }
  const post = async (route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${url}${route}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }
  const why = (json: Record<string, unknown>) => String(json.message ?? json.error ?? '')

  // Who does the server say this token is? Only a record registered as a simulator is posted to.
  const hello = await post('/api/device-ingest/heartbeat', {}).catch((e: Error) => {
    throw new Stop(`cannot reach ${url} (${e.message}). Start the application with \`npm run dev\`.`, 1)
  })
  if (hello.status !== 200) throw new Stop(`the server refused this token (HTTP ${hello.status}: ${why(hello.json)}).`)
  if (hello.json.simulator !== true) throw new Stop('this token belongs to a record that is NOT registered as a simulator. The simulator never posts through a device’s record: nothing was sent.')
  say(`${SIMULATOR_VERSION}: connected to ${url} as a SIMULATOR record${hello.json.assigned ? '' : ' (not attached to a patient yet: attach it in the application; what it sends is refused until then)'}`)
  say('Everything this program sends is generated. The application stores and shows it as SIMULATED, never as a measurement.')

  if (recording) {
    const wav = simulatedToneWav(seed)
    const form = new FormData()
    form.append('recordedAt', new Date().toISOString())
    form.append('site', opt('site', 'mitral'))
    form.append('durationMs', '4000')
    form.append('idempotencyKey', `sim:${SIMULATOR_VERSION}:tones:${seed}:${Date.now().toString(36)}`)
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'simulated-tones.wav')
    const res = await fetch(`${url}/api/device-ingest/auscultations`, { method: 'POST', headers, body: form })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status !== 201) throw new Stop(`the recording was not stored (HTTP ${res.status}: ${why(json)}).`, 1)
    if (json.simulated !== true) throw new Stop('the server did not store the recording as simulated. Stopping.', 1)
    say(`sent ${wav.length} bytes of generated tones (seed ${seed}); stored as SIMULATED AUDIO.`)
    return
  }

  let stopping = false
  process.on('SIGINT', () => {
    stopping = true
  })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
  const run: SimRun = { scenario, seed, startMs: Date.now(), intervalMs }
  say(`scenario "${scenario}" (${SIM_SCENARIOS[scenario]}), seed ${seed}, one tick every ${intervalMs / 1000} s${count ? `, ${count} ticks` : ', until stopped (Ctrl+C)'}`)
  for (let i = 0; !stopping && (count === 0 || i < count); i++) {
    // Short sleeps, so that Ctrl+C is noticed within a moment rather than after a whole interval.
    while (!stopping && Date.now() < run.startMs + i * intervalMs) await sleep(Math.min(250, run.startMs + i * intervalMs - Date.now()))
    if (stopping) break
    const tick = simulatedTick(scenario, seed, i)
    if (tick.send === 'nothing') {
      say(`tick ${i}: silent (the scenario sends nothing: the device will show as disconnected)`)
      continue
    }
    if (tick.send === 'heartbeat') {
      const r = await post('/api/device-ingest/heartbeat', {}).catch(() => null)
      say(`tick ${i}: in contact, no readings (they will show as stale)${r?.status === 200 ? '' : ` — HTTP ${r?.status ?? 'unreachable'}`}`)
      continue
    }
    const body = simulatedBatch(run, i)!
    const r = await post('/api/device-ingest/readings', body).catch(() => null)
    const values = body.readings.map((x) => `${x.kind} ${x.value}`).join(', ')
    if (!r) say(`tick ${i}: the server could not be reached; nothing stored`)
    else if (r.status === 201 || r.status === 200) {
      if (r.json.validationStatus !== 'simulated') throw new Stop('the server did not store these values as simulated. Stopping.', 1)
      say(`tick ${i}: SIMULATED ${values} → ${r.status === 200 ? 'already stored' : `stored ${String(r.json.stored)}`}`)
    } else say(`tick ${i}: refused (${String(r.json.error ?? r.status)}: ${why(r.json)})`)
  }
  say('stopped.')
}

loadDotEnv()
try {
  await main(process.argv.slice(2))
} catch (e) {
  console.error(`[simulator] ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = e instanceof Stop ? e.code : 1
}
