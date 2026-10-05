import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { E2E_DB } from './e2e/db-names.ts'

// The suite runs its own API, thermal service and web app on separate ports,
// against the dedicated e2e database (reset and seeded in global-setup), so it
// can run while `npm run dev` is up and never touches development data.
// Importing db-names stops the run here, before any server starts, if the
// database names are ambiguous (e.g. the e2e name equals the development one).
const PORTS = { api: 4100, thermal: 8101, web: 5273, mockAnthropic: 4199, mockSpeech: 8199, mockLlm: 8181 }
// The secret the stand-in for the local model server checks (a placeholder for the test run, not a credential), and the one the API presents to it.
const MOCK_LLM_KEY = 'e2e-llm-secret-not-a-key'
const WEB = `http://127.0.0.1:${PORTS.web}`
// Opt-in real-model run (e2e/consult-real.spec.ts): E2E_LLM_URL points the API at the running local model server instead of the stand-in. That server
// checks a per-install secret (.data/llm/api-key, made by scripts/llm.mjs); it is read here, handed to the API through its environment, and never printed.
const LLM_URL = process.env.E2E_LLM_URL ?? `http://127.0.0.1:${PORTS.mockLlm}`
const LLM_KEY = process.env.E2E_LLM_URL ? fs.readFileSync(path.resolve(process.cwd(), '.data', 'llm', 'api-key'), 'utf8').trim() : MOCK_LLM_KEY

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Whole multi-role workflows are long: in a fully passing run on the dev
  // machine (2 Oct 2026) doctor-workflow took 27.7 s (desktop) and 26.6 s
  // (mobile), and the longest test of a later passing run took 32.4 s, beyond
  // Playwright's 30 s default; runs under CPU load timed out at the final steps. Each assertion keeps its own 5 s limit, so a hang
  // still fails quickly.
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Chromium's synthetic microphone, so browser recording can be tested.
        permissions: ['microphone'],
        // E2E_FAKE_AUDIO_FILE (opt-in, e2e/capture-real.spec.ts): the synthetic microphone plays this WAV (synthetic speech) instead of a beep.
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(process.env.E2E_FAKE_AUDIO_FILE ? [`--use-file-for-fake-audio-capture=${process.env.E2E_FAKE_AUDIO_FILE}`] : [])] },
      },
    },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      // TEST-ONLY mock of the Anthropic Messages API (e2e/mock-anthropic.mjs).
      command: 'node e2e/mock-anthropic.mjs',
      url: `http://127.0.0.1:${PORTS.mockAnthropic}/health`,
      env: { MOCK_ANTHROPIC_PORT: String(PORTS.mockAnthropic) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // TEST-ONLY stand-in for the local language-model server (e2e/mock-llm.mjs): it answers from the record items it is shown, no model, loopback only.
      command: 'node e2e/mock-llm.mjs',
      url: `http://127.0.0.1:${PORTS.mockLlm}/health`,
      env: { MOCK_LLM_PORT: String(PORTS.mockLlm), MOCK_LLM_KEY },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // TEST-ONLY stand-in for the local speech service (e2e/mock-speech.mjs): a fixed synthetic script, no model, loopback only.
      command: 'node e2e/mock-speech.mjs',
      url: `http://127.0.0.1:${PORTS.mockSpeech}/health`,
      env: { MOCK_SPEECH_PORT: String(PORTS.mockSpeech) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run start --workspace @adaxai/api',
      url: `http://127.0.0.1:${PORTS.api}/api/health`,
      env: {
        DB_NAME: E2E_DB,
        // Uploaded files of the end-to-end run stay out of the development store.
        STORAGE_DIR: 'storage-e2e',
        API_PORT: String(PORTS.api),
        THERMAL_URL: `http://127.0.0.1:${PORTS.thermal}`,
        // Points the real Anthropic SDK at the local mock; the key is a placeholder, not a credential.
        ANTHROPIC_API_KEY: 'e2e-placeholder-not-a-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.mockAnthropic}`,
        // Hosted AI egress is off unless allowed on purpose (a key alone enables nothing). Allowed here, only because the "hosted provider" is the
        // loopback mock above; the capture specs assert that the mock is never called during capture.
        AI_EGRESS_HOSTED: 'true',
        // Local AI consultation intelligence: the local model boundary, pointed at the loopback stand-in (a real model only in the opt-in run above).
        LLM_PROVIDER: 'local',
        LLM_URL,
        LLM_API_KEY: LLM_KEY,
        // Speech-to-text: the local service boundary, pointed at the loopback stand-in. There is no hosted provider to configure.
        SPEECH_PROVIDER: 'local',
        // Opt-in real-model run (e2e/capture-real.spec.ts): E2E_SPEECH_URL points at a running local speech service instead of the stand-in.
        SPEECH_URL: process.env.E2E_SPEECH_URL ?? `http://127.0.0.1:${PORTS.mockSpeech}`,
        // Device reading states (e2e/devices-live.spec.ts): short limits, so that a reading can be watched going from live to stale and its device to
        // disconnected in seconds instead of minutes. The limits are a display rule; nothing else depends on them.
        DEVICE_LIVE_SECONDS: '6',
        DEVICE_DISCONNECTED_SECONDS: '14',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'node scripts/thermal.mjs dev',
      url: `http://127.0.0.1:${PORTS.thermal}/health`,
      env: { THERMAL_PORT: String(PORTS.thermal) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --workspace @adaxai/web',
      url: WEB,
      env: { WEB_PORT: String(PORTS.web), API_PORT: String(PORTS.api) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
