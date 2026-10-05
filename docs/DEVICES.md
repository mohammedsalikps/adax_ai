# Devices: integration boundary (no hardware integrated)

**Status: no wearable band, smart stethoscope or thermal camera has been connected to or tested
with this build.** What exists is the boundary a real integration would plug into, and, since
slice V5, a labelled **simulator** that exercises it without hardware. Nothing in the
application, seed data or demo shows device readings that did not come through that boundary,
and everything a simulator sends is stored and shown as *simulated*. Decisions:
[ADR 0018](adr/0018-device-readings-states-gateway-and-simulator.md).

## Hardware inventory at build time (2 Oct 2026; unchanged for V5 on 5 Oct 2026)

Checked on the development machine (Windows 11) with `Get-PnpDevice` and `Win32_SerialPort`:

| Looked for | Found |
| --- | --- |
| Bluetooth devices paired or present | Only the laptop's own Bluetooth radio (Intel Wireless Bluetooth); no band, stethoscope or other health device |
| Audio inputs | Built-in microphone array only (no USB/Bluetooth stethoscope) |
| Serial / USB health devices | None (USB: webcam, fingerprint reader, hubs) |
| Device SDKs or vendor API credentials | None in the repository or `.env` |
| FLIR camera | None; thermal tests use public sample files (see README) |

V5 was built on a different laptop with the same result: no health device, SDK or credential.

## What is implemented

| Part | Where | Notes |
| --- | --- | --- |
| Device registry | Admin > Devices; `POST/PATCH /api/admin/devices` | Kind, make, model, serial (unique), status, integration mode: `not_integrated`, `manual_upload`, `gateway_api`, `simulator`. A record is a simulator from the start or never |
| Assignment to a patient | Nurse > Devices, or "Attach a device" in a consultation or on a patient record; `POST /api/devices/:id/assignments`, `POST /api/device-assignments/:id/end` | Requires the patient's `device_monitoring` consent; one open assignment per device (database index); records the visit and, when attached in a consultation, the consultation; an optional end time (`validUntil`); assignments can only be ended, never edited or deleted (trigger) |
| Gateway ingestion API | `POST /api/device-ingest/readings`, `/heartbeat`, `/auscultations` | See contract below. Readings are stored as observations with `source = device`, `validationStatus = device_unverified` (or `simulated` for a simulator record), linked to the device and to the batch they arrived in |
| The gate | `DEVICE_READING_KINDS` in `packages/contracts/src/devices.ts` | A wearable band may send heart rate, SpO₂, temperature and respiratory rate. Nothing else is accepted from any device. **Blood pressure is never accepted**: it is entered by staff |
| Idempotent batches | `device_batches` (append-only) | A batch is stored once: by the gateway's `idempotencyKey`, or by its content when no key is sent |
| Reading states | `GET /api/patients/:id/device-readings`; "Device readings" card | Live, stale, disconnected, no data, unavailable: decided on the server's clock by one function (`readingState`), re-read every 5 seconds, aged on the screen in between. Not a monitor; no alarm |
| Gateway tokens | Admin > Devices > Issue token | Random token shown once; only its SHA-256 is stored; replace or revoke at any time; retiring a device revokes it |
| Stethoscope recordings | "Stethoscope recordings" card on the patient record and consultation; `POST /api/patients/:id/auscultations` | A file uploaded by staff, a recording made **in the browser** from an audio input, or one sent by a gateway. Checked by content (first bytes), site, playback. No analysis. The system cannot tell what an audio input is |
| Simulator | `npm run demo:devices`, `npm run devices:simulate` | A program that generates values and posts them as a gateway would, through a record registered as a simulator. See below |

## Reading states

| State | Meaning | What the screen shows |
| --- | --- | --- |
| Live | measured within `devices.liveSeconds` (default 30) | the value, its time, "just now" / "12 s ago" |
| Stale | older, gateway still in contact | the value greyed, "Last measured …" |
| Disconnected | nothing heard from the gateway for `devices.disconnectedSeconds` (default 120), or ever | the last value received, said to be the last one received; or "No reading" |
| No data | gateway in contact, no reading of that kind in this assignment | "No reading" |
| Unavailable | no device attached, retired, no gateway, consent missing, the assignment's time over | the reason, in words |

The limits are settings (`config/adaxai.yaml` → `devices`; env `DEVICE_LIVE_SECONDS`,
`DEVICE_DISCONNECTED_SECONDS`). They are a display rule, not clinical guidance. A device is
"in contact" when its gateway presents its token (a reading, a recording or a heartbeat).

## Gateway contract

A gateway is a separate program (phone app, bedside PC, vendor cloud bridge) that reads the device
and posts to ADAXAI. **None exists except the simulator.**

```http
POST /api/device-ingest/readings
Authorization: Bearer adxdev_…            (token issued for that device)
x-adaxai-csrf: 1
Content-Type: application/json

{ "measuredAt": "2026-10-05T10:15:00+05:30",
  "idempotencyKey": "gw-7f3a-000184",                                   (optional, 8 to 100 characters)
  "readings": [ { "kind": "heart_rate", "value": 72 }, { "kind": "spo2", "value": 97 } ] }
```

- `kind` must be one the device's kind may send (the gate above); each kind once per batch; values
  outside the plausible range are rejected (400). Timestamps more than 5 minutes in the future are
  rejected; one ahead of the server's clock by less is **stored as the time of arrival** (nothing
  is "measured" after it was received).
- The patient is the one the device was **assigned to when the readings were measured**
  (`measuredAt`). The gateway never names a patient. Buffered readings sent late are therefore
  filed to the right patient, even after the device was given to someone else.
- Sending the same batch again stores nothing twice: `200 { "stored": 0, "duplicate": true, … }`.
  The same key with different content is `409 idempotency_conflict`.
- **Refusals** (all audited, nothing stored):

  | Situation | Response |
  | --- | --- |
  | A kind the device may not send (blood pressure, always) | 422 `kind_not_allowed`; the whole batch is refused |
  | Not assigned to anyone at `measuredAt`: before the assignment started, after it ended, or at or after its `validUntil` | 409 `outside_assignment` |
  | Measured more than `devices.maxLateHours` (24) before it arrives | 422 `too_late` |
  | That patient's device consent missing, withdrawn, or given after `measuredAt` | 409 `consent_required` |
  | The key was used for a different batch | 409 `idempotency_conflict` |
  | Unknown token | 401 (audited once per address and five minutes; more than 30 a minute from one address: 429) |
  | Retired device, wrong integration mode, or a simulator where none is allowed | 403 |
  | Too many requests for the device | 429 with `Retry-After` (`config/adaxai.yaml` → `security.rateLimits.deviceIngestPerToken`; recordings: `deviceRecordingPerToken`, much lower) |

  A renewal of the consent under newer wording counts as continuous consent. Withdrawing device
  consent ends the patient's device assignments at once. Changing a device's integration away
  from a gateway mode, or retiring it, revokes its token.
- Response: `201 { "stored": n, "duplicate": false, "validationStatus": "device_unverified", "batchId": "…" }`
  (`"simulated"` for a simulator record).
- `POST /api/device-ingest/heartbeat` (empty body): "still here". It records the contact, which
  is what tells stale readings from a disconnected device, and answers
  `{ "ok": true, "serverTime": "…", "simulator": false, "assigned": true }`.
- `POST /api/device-ingest/auscultations` (multipart: `recordedAt`, `site`, optional
  `durationMs`, `idempotencyKey`, then `file`): one recording from a device registered as a
  smart stethoscope. Same assignment, consent and store-once rules.

## The simulator

A simulator is **a program that generates numbers**. It is not a device, it does not model one,
and nothing it sends is a measurement.

```bash
npm run demo:devices
```

registers two simulator records ("Simulator band 1", "Simulator stethoscope 1"), attaches the band
to the synthetic demo patient of `npm run demo:seed` (recording that patient's consent to device
readings if it is missing) and writes their gateway tokens to `.data/sim/` (git-ignored, never
printed). With the application running (`npm run dev`):

```bash
npm run devices:simulate
```

posts generated values through the band's token every five seconds until stopped. Options:
`--scenario steady | rising_heart_rate | low_spo2 | fever | no_readings | dropout`, `--seed <n>`,
`--interval <seconds>`, `--count <ticks>`, `--recording` (one file of generated tones through the
stethoscope simulator, which must be attached to a patient first). The same seed gives the same
values.

What keeps simulated data apart (each of these is tested):

- A record is a simulator from the start or never (API and database trigger).
- The server stores what arrives through a simulator's token as `simulated`; a request cannot say
  what its data is, and the database refuses a row that claims otherwise.
- A simulator cannot be registered, hold a token or post in a deployment whose data is clinical,
  or in production.
- The screen marks every simulator record and value SIMULATED.
- Simulated values are **not** in a visit's vital signs (queue, consultation, banner, history
  summary), **not** in the vitals history on the patient record, **not** used by the routing
  suggestion, **not** shown to the patient, **not** given to any model (consultation draft, Mana,
  the older assistant) or to the record and safety rules, and are not compared with reference
  ranges. The one place they are shown is the Device readings card, marked SIMULATED.
- Where a reading came from (source, device, validation status, batch) cannot be changed after it
  is stored (database trigger).
- The simulator program posts only through a token the server says belongs to a simulator.

## What staff measured stands

Where the application shows or uses one value per vital sign for a visit (the queue, the
consultation banner and tiles, the history summary, the routing suggestion, the safety rules, the
record the AI reads), the newest value **staff measured** stands. A device's newest reading stands
only where staff measured nothing of that kind, and is shown as a device value, unverified. Lists
of vital signs keep every staff measurement and only the newest few device readings of each kind
per visit. The device's stream, with its states, is on the "Device readings" card.

A reading is filed under the patient's open visit of the day it was measured on. One that arrives
after that visit was closed belongs to the patient but is not added to the visit.

## What a real integration needs

1. **The physical devices** (make and model chosen), on loan for testing.
2. **Data access**, one of:
   - standard Bluetooth LE profiles (e.g. Heart Rate Service `0x180D`, Pulse Oximeter `0x1822`,
     Health Thermometer `0x1809`) — then a gateway can read them directly;
   - the vendor's SDK or cloud API with credentials and documentation (most wearables);
   - for stethoscopes, the vendor's export format or SDK (audio sample rate, filtering, file type).
3. **A gateway** implementing the contract above, tested against the device: pairing,
   reconnection, timestamps and time zones, units, an idempotency key per batch, heartbeats,
   battery and signal quality flags (the contract has no field for the last two yet).
4. **Validation** of readings against reference measurements before any reading is treated as
   anything other than `device_unverified`. There is no path in the product that marks a reading
   verified, and none should be added before that work exists.
5. **A decision record** before the gate is widened (blood pressure in particular).

Until then, the "Devices" pages, the device card, the API, the simulator and these notes are the
only device features, and the README does not claim device integration.
