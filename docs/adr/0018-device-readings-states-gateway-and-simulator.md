# ADR 0018: Device readings: a state for every value, a gate on what a device may send, batches stored once, and a simulator that can never pass for a device

- **Status:** accepted and implemented in slice V5 (after V4, `e82cd4f`). It builds on the device boundary of slice "devices" (registry, assignment, token gateway, stethoscope upload: [docs/DEVICES.md](../DEVICES.md)), the consent rules of [ADR 0006](0006-consent-lifecycle-and-enforcement.md), the facility scope and denial audit of [ADR 0007](0007-default-deny-routes-facility-scope-and-denial-audit.md) and the record reads of [ADR 0016](0016-local-ai-consultation-intelligence.md) and [ADR 0017](0017-mana-ai-doctor-assistant.md).
- **Date:** 5 Oct 2026

## 1. Context

Before this slice a device reading was a row with `source = device` and `validation_status = device_unverified`, and that was all the system knew about it. The audit of the Doctor App ([DOCTOR_APP_AUDIT.md](../DOCTOR_APP_AUDIT.md) §3) and the risk register (R6, R7, R8) listed what was missing: nothing said how **current** a device value was (live, stale, from a device that had gone quiet); the gateway would have accepted **blood pressure** from a device with no pipeline behind it; a gateway that retried could store a reading twice; readings of a device assigned from the nurse's page reached neither the queue nor the consultation; there was **no simulator**, so none of it could be exercised without hardware, and nothing stopped generated numbers from being mistaken for measurements once one existed.

**No wearable band, smart stethoscope or other device has been connected to or tested with this build, before or after this slice.** What this slice builds is the layer a device integration would use, and a labelled way to exercise it without one. Nothing here is a claim about any hardware, and nothing a device sends is treated as validated.

## 2. Decisions

### 2.1 A reading has a state, decided by one function on the server's clock

`readingState` (`packages/contracts/src/devices.ts`) is the only place that decides how current a device value is. The API uses it to answer, and the screen uses the same function to age what it was given between two reads.

| State | Meaning |
| --- | --- |
| `live` | measured within `devices.liveSeconds` (30) of the server's clock |
| `stale` | older than that, with the device's gateway still in contact |
| `disconnected` | the gateway has not presented the device's token for more than `devices.disconnectedSeconds` (120), or never has. A value shown with this state is **the last one received**, and the screen says so |
| `no_data` | the gateway is in contact but has sent no reading of that kind in this assignment |
| `unavailable` | nothing can arrive: no device attached, the device is retired or has no gateway, the patient's consent is not in place, the assignment's time is over, or a simulator in a deployment that does not allow one |

- **"Connected" is about the gateway, not the last reading.** A device record gets `last_seen_at` whenever its token is presented (readings, recordings, or the new `POST /api/device-ingest/heartbeat`). That is what tells *stale* (in contact, nothing new) from *disconnected* (silence).
- **The limits are a display rule** in `config/adaxai.yaml` (env `DEVICE_LIVE_SECONDS`, `DEVICE_DISCONNECTED_SECONDS`), not clinical guidance: they say how old a value is, not whether it is right.
- **The server's clock.** The read model returns `serverTime`; the screen ages readings from it (plus the time since, on its own clock), so a wrong clock on the workstation does not make an old value look new.
- **Nothing is measured after it arrived.** A time a gateway stamps ahead of the server's clock is refused beyond five minutes and otherwise **stored as the time of arrival**: a value cannot stay live for the length of a clock's error, and a band handed to the next patient cannot file its last, future-stamped readings under them.
- **Nothing is filled in.** A kind without a reading says "No reading". There is no interpolation, no carried-forward value presented as current, and no placeholder.
- **Not a monitor.** The card is re-read every five seconds (there is no push channel), raises no alarm and says so on the screen.

### 2.2 The gate: which kinds a device may send

`DEVICE_READING_KINDS` (contracts) lists, per kind of device, the vital signs its gateway may post: a wearable band may send heart rate, oxygen saturation, temperature and respiratory rate; a stethoscope, a thermal camera and "other" may send none. **Blood pressure is in no list**: no cuff or cuffless pipeline has been validated, so blood pressure stays a value typed in by staff (R7). A batch that contains a kind outside the list is refused **whole** (422 `kind_not_allowed`, audited), so that a gateway that sends what it may not is noticed instead of half-accepted. The list is code, not a setting: widening it is a product and safety decision (a validated pipeline, the risk register, a decision record).

### 2.3 A batch is stored once

Every accepted gateway request is a row in `device_batches` (append-only, in the append-only privilege policy): device, assignment, patient, an idempotency key, a hash of what was sent, and whether the device record was a simulator. The key is the one the gateway sends, or, without one, a key derived from the content (device, time and values), so an exact repeat is stored once either way. A repeat answers `200 { stored: 0, duplicate: true }` with the first batch's id; the same key with other content is `409 idempotency_conflict`. The unique index `(device_id, idempotency_key)` makes this hold under concurrent retries (tested with ten copies arriving together). Each reading keeps the batch it arrived in.

### 2.4 Assignment: a patient, a visit and consultation, a time

- **Consultation and visit.** A device attached from a consultation records that consultation and its visit. Attached from the nurse's page with no visit named, the patient's open visit of that day is recorded. At ingestion a reading is filed under **the patient's visit of the facility-local day it was measured on, checked in to by then, and only if that visit is still open when the reading arrives**. A reading that arrives after its visit was completed or cancelled still belongs to the patient but is not added to the visit (a closed visit's vital signs do not change afterwards); a visit left open from an earlier day collects nothing; a band worn for several days files each day's readings under that day's visit.
- **Validity windows** (unchanged in principle, now complete): a reading belongs to the patient the device was assigned to **when it was measured**; it is refused before the assignment started, after it ended, at or after an optional `valid_until` set when assigning (new), and when the patient's consent was not yet given at that time or has been withdrawn (looked at again, holding the consent row, inside the transaction that stores). Buffered readings sent late are filed to the patient they were measured on, **but not without limit**: what was measured more than `devices.maxLateHours` (24) before it arrives is refused (422 `too_late`), so a token is not a way to write into a patient's past. An assignment's visit, consultation and end time are fixed when it is made (the existing guard trigger lets an assignment only be ended).

### 2.5 A simulator is not a device, and the database knows it

A **simulator** is a device record registered with `integration = simulator`: a program that generates values (`npm run devices:simulate`), for development and tests. The rule is that **simulated data can never pass for device data, and the reverse**, and it does not rest on the application behaving:

1. **Fixed at registration.** A record is a simulator from the start or never: the API refuses to change it either way (`simulator_fixed`), and so does a database trigger (`devices_simulator_guard`).
2. **The server decides, from the record.** What arrives through a simulator's token is stored as `validation_status = simulated` (readings) or `simulated = true` (batches, recordings). Nothing in a request can say what its data is.
3. **The database enforces the pairing, and fixes it.** Trigger `device_simulated_guard` refuses any reading, batch or recording that is marked simulated when its device record is not a simulator, or not marked when it is, including rows written directly; two CHECK constraints limit the status to the three known values and tie a non-manual status to a device; and `observations_provenance_guard` (migration 0030) makes a reading's source, device, validation status and batch **unchangeable after it is stored**, so that no UPDATE can turn a simulated value into a device reading or a staff measurement (the first guard looked only at the row as it would become; the independent review found that one statement could relabel a reading consistently and pass). The guard functions name the devices table with its schema and run with a fixed search path, so a temporary table of the same name cannot mislead them.
4. **Nowhere but development.** In a deployment whose data is clinical, or in production, a simulator cannot be registered, cannot be issued a token and cannot post (a record left from before is refused at the gateway and shown as unavailable).
5. **Shown as SIMULATED, and kept out of the record's uses.** The device card, the device lists and the stethoscope list mark every simulator record and value. Simulated values are **left out** of a visit's vital signs (queue, consultation, banner, history summary), of the record's vitals history on the patient page, of the nurse's routing suggestion (red flags, urgency, "intake complete"), of the patient portal, of everything a model reads (the consultation draft's inputs, Mana's tools, the older assistant's context) and of the record rules and safety rules. They are not compared with reference ranges. They exist in the application in exactly one place where a person is told what they are: the device readings card. (The vitals history and the routing rules were not in the first version of this slice; the independent review found both.)
6. **The program checks too.** The simulator asks the server what its token belongs to and posts nothing unless the answer is a simulator record; it stops if the server ever stores a value otherwise.

The simulator is deterministic (`src/devices/simulator.ts`, `device-sim-v1`): a seed and a tick give the same values every time; it produces only the kinds a band may send (never blood pressure) and has scenarios for steady values, a climbing heart rate, a falling saturation, a fever, a gateway that stays in contact but sends nothing, and one that goes silent.

### 2.6 What staff measured stands

A device sends a value every few seconds and none of them is verified. If "the latest reading" simply meant the newest row, a band attached at 10:02 would replace the heart rate a nurse took at 10:00 everywhere a visit is summarised. So, for every place that picks one value per kind (the queue's latest vital signs and its count of values outside the range, the consultation banner and tiles, the history summary, the routing suggestion, the older assistant's safety rules): **the newest value staff measured stands; a device's newest value stands only where staff measured nothing of that kind**, and it is shown as a device value, unverified. The live stream is on the device card, with its states.

A stream is also long. Every reader of observations therefore takes **every staff measurement, and of what a device sent only the newest few of each kind per visit** (one helper, `standingWindow`): the consultation's vital signs keep the device's newest reading of each kind, the record's vitals history the newest five, the AI context the newest three or five. Otherwise an hour of a band would be thousands of rows on every load of a consultation, and "the newest sixty rows" would be nothing but the band.

### 2.7 V3 and V4 read device readings, with their label, and never write

Both read through one loader (`mana/record.ts`), which now:

- keeps the newest five readings per kind, visit **and source**, so that a device's stream cannot push a staff measurement out of the window;
- words a device reading as "device reading (device unverified)" with provenance `device_measured` (as before);
- **does not read simulated values at all** (§2.5).

The record rules were changed for the same reason as §2.6 and carry new version ids (`mana-record-v2`, `record-check-v2`): the value that stands for a kind at a visit is the staff measurement if there is one; "recorded more than once at this visit with different values" is found among **staff measurements only** (a pulse that moves is not a conflict, and an unverified stream is not set against a measurement); where both exist the answer adds "A device also sent … (device reading, device unverified)". Nothing else in V3 or V4 changed: no prompt, no check, no tool, no screen of theirs. Neither can write an observation, an assignment or a device (no tool or route of theirs touches those tables; a test checks the counts before and after).

### 2.8 Stethoscope: three ways a recording arrives, none of them a verified stethoscope

| `capture_method` | What it is |
| --- | --- |
| `file_upload` | a file chosen by staff (existing) |
| `browser_recording` | recorded in the browser from an audio input the member of staff chose, with speech clean-up (echo cancelling, noise suppression, automatic gain) switched off. A stethoscope that presents itself to the computer as an audio input can be chosen like any other input; **the system cannot tell what an input is**, and stores the name the browser gives it, as reported |
| `gateway` | posted by a gateway with a stethoscope record's token (`POST /api/device-ingest/auscultations`): same assignment and consent window, stored once. The only thing that has posted here is the simulator, whose "recording" is generated tones stored and shown as SIMULATED AUDIO |

Every upload must **be** the audio container its type says it is (first bytes, not name or declared type). Recordings are played back through the audited file route. Nothing is analysed.

### 2.9 Authorization and audit

- Gateway requests carry a device token (random, shown once, only its SHA-256 stored) and are rate limited per device, with a separate and much lower limit for recordings (files of megabytes; a stethoscope that has not been assigned to anyone lately is refused before its file is read). A token never names a patient or a facility. Refusals are audited with the reason; stored batches are audited with the patient, the batch and whether they were simulated; the first repeat of a batch in a window is audited, not every retry. **Guessing tokens** is slowed per address (30 a minute, then 429) and reaches the audit log once per address and five minutes, not once per guess: the log is a hash chain that every writer waits for. Heartbeats that succeed are not audit events (one every few seconds per device); the device's last contact is on its record.
- Staff routes are within the caller's facility as before; the read model is for doctors and nurses (`patients:read`), not administrators, who still see that a device is in use and not by whom (nor for which visit or consultation).
- The polled read of a patient's device readings is audited **once per reader and patient per five minutes** (`device.readings_read`, saying that repeats are not logged), not once per read: an open consultation reads it every five seconds.

## 3. What was not built

- **Any real device.** No band, stethoscope, SDK, Bluetooth profile or vendor cloud. No gateway program other than the simulator. Pairing, reconnection, battery, signal quality, units negotiation and time synchronisation of a real gateway are not designed here ([DEVICES.md](../DEVICES.md) "What a real integration needs").
- **Validation.** No reading is anything but `device_unverified`; there is no path that marks one verified, and no comparison with reference measurements.
- **Alarms, trends, thresholds on device values, a push channel, a waveform, heart-sound analysis, any model on device data.**
- **Blood pressure from a device.**
- **Simulated values in the AI paths.** Deliberately (§2.5): the alternative, showing a model simulated values with a label and trusting the label to survive into what it writes, was rejected.
- **Retention rules for device readings and batches**, and editing or deleting an assignment's time once set.
- **A quota** on how much one device may store (readings per day, bytes of recordings per assignment): there are rate limits, not quotas. A token that posts at the allowed rate for a day stores a great deal.
- **Rotating a device's token when it changes hands.** The same token posts for whoever the device is assigned to at the time measured; a gateway that kept an old patient's buffer would file it to that patient (within the late limit), which is the intended behaviour and also a reason to end an assignment promptly.

## 4. Consequences

- A demonstration without hardware shows simulated values on the device card only. The V3/V4 read of device readings is demonstrated by tests that post as a gateway would for a gateway device record; there is no device behind those either, and the tests say so.
- Visit summaries changed meaning where a device and staff both supplied a kind: the staff value now stands (before, the newest row did). Records without device readings are unaffected.
- `mana-record-v2` / `record-check-v2`: answers and drafts stored earlier keep the version they were made with.
- The gate turns away kinds the old gateway accepted (anything from an "other" device; weight, glucose and blood pressure from a band). Nothing in the repository sent those.
- The consultation's `vitals` and the record's vitals history no longer return every device row of a visit (see §2.6); a caller that wants a device's stream reads the device card's model. Readings that arrive after their visit closed are no longer added to it.
- A reading measured more than 24 hours before it arrives is refused; before this slice there was no limit.

## 5. Verification

API: `apps/api/test/devices-v5.test.ts` (states, gate, idempotency including concurrent copies, the simulator in the API and in the database, clinical deployments, assignment and validity windows, the read model as time passes, facility isolation, the gateway, the three stethoscope paths, the V3/V4 read path, the simulator program) and the existing `devices.test.ts`. Web: `apps/web/test/devices.test.ts`. Browser: `e2e/devices-live.spec.ts` (a simulator's values from attached to disconnected, a gateway device record's values, recording in the browser, five widths). Numbers and what was not tested: [STATUS.md](../STATUS.md), slice V5.
