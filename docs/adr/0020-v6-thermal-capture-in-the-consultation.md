# ADR 0020: V6, thermal imaging in the consultation: a camera reached only through a native bridge that has not yet run, every image labelled by where it came from, a summary composed by rules and reviewed once, and no model

- **Status:** accepted and implemented in slice V6 (after D1, `1989b68`), **except the native Android bridge, which is written but not compiled and not run** (§2.1). It builds on the thermal pipeline that existed before it (a radiometric FLIR JPEG uploaded on the thermal pages, decoded by `flyr`, regions with statistics and paired differences, doctor approval, labels, the de-identified dataset export), the consultation workspace of [ADR 0019](0019-d1-integrated-consultation-workspace.md), the rule that a simulator can never pass for a device ([ADR 0018](0018-device-readings-states-gateway-and-simulator.md) §2.5), the consent rules of [ADR 0006](0006-consent-lifecycle-and-enforcement.md) and the recorded insertion of [ADR 0002](0002-ai-text-into-notes-via-recorded-insertions.md). The camera side (hardware, permissions, bridge contract, security, the steps to verify it) is in [THERMAL_CAMERA.md](../THERMAL_CAMERA.md).
- **Date:** 5 Oct 2026

## 1. Context

Before this slice a thermal image reached ADAXAI in one way: a member of staff uploaded a radiometric FLIR JPEG on the thermal pages, the thermal service decoded its temperatures with `flyr`, and a doctor drew regions and approved or rejected the measurements. The consultation had no thermal part (D1 left it out on purpose, ADR 0019 §3), nothing recorded how an image had been taken, and the V6 row of [DOCTOR_APP_PLAN.md](../DOCTOR_APP_PLAN.md) asked for a thermal panel in the workstation, measured data, model output and clinician interpretation kept apart, image quality and uncertainty, and "any trained model with dataset provenance, patient-level splits, metrics, failure cases and a model card, or none".

The camera targeted is a **FLIR ONE Gen 3 or FLIR ONE Pro for Android (USB-C)** plugged into an Android tablet. **No FLIR ONE, no Android tablet, no Android SDK, JDK or Gradle and no FLIR SDK were available on the development machine (a Windows laptop). Nothing in this slice was tested on hardware.** What it builds is the consultation's side of thermal capture, complete and tested with a labelled simulator and with public FLIR sample files, and the native half, written against FLIR's documentation and never run.

## 2. Decisions

### 2.1 The camera is reached only through a native bridge, and that bridge has not run

A FLIR ONE is not a webcam: a browser cannot reach its radiometric data. The Doctor App stays a React web app; on the tablet it runs inside a **WebView host** (a minimal Android app, `android/host-example`) that attaches a `JavascriptInterface` bridge, **`AdaxaiThermalNative`** (contract v1, [THERMAL_CAMERA.md](../THERMAL_CAMERA.md)), written to answer only while the WebView shows the ADAXAI origin (a check on every call). The bridge (`android/thermal-bridge`) wraps the **FLIR Atlas Android SDK**: discovery over USB, connection, the thermal stream, preview frames rendered by the SDK at up to about 9 a second as JPEG (a picture for the screen: it holds no temperature and is never uploaded), and a capture that is the camera's own radiometric JPEG (`ThermalImage.saveAs`). Nothing clinical is in the native code: staff sign in and work in the web app, and the page uploads a capture to the API over its own session like any thermal image.

- **Written against the FLIR Atlas Android SDK 2.4.0 javadoc** (official, hosted by FLIR); every FLIR name the code uses was checked against it and is listed in `android/README.md`. **Not compiled, not run**: every Kotlin file says so in its first line.
- **The SDK** needs a free FLIR developer account and acceptance of FLIR's licence, and **FLIR reviews apps for the FLIR ONE before release**. Neither has been done; no SDK file is in the repository.
- The USB device filter matches FLIR's vendor id **2507** (0x09CB) only; the FLIR ONE product ids are to be copied from FLIR's sample app, not guessed.
- Until the fifteen steps of [THERMAL_CAMERA.md](../THERMAL_CAMERA.md) "Verification on hardware" have passed, ADAXAI has **no working FLIR integration**, and nothing may describe live capture as working.

### 2.2 One camera interface in the web app, and a camera state that never guesses

`apps/web/src/lib/thermalCamera.ts` gives the screen one interface, `ThermalCameraAdapter` (`connect`, `disconnect`, `getStatus`, `getDeviceInfo`, `getCapabilities`, `startPreview`, `stopPreview`, `capture`, `subscribe`), with two implementations: `NativeBridgeAdapter` (the bridge) and `SimulatorAdapter` (§2.5). The screen never talks to a vendor.

| State | Shown as | When |
| --- | --- | --- |
| `disconnected` | Not connected | At start, after a disconnection, or when no camera can be reached |
| `connecting` | Connecting | After *Connect*, until the camera is connected or an error is reported |
| `connected` | Connected | Only when the bridge reports the camera connected (*Connect* resolves only then) |
| `previewing` | Live | Frames are arriving. **LIVE is shown only while the camera in use says it is previewing and a frame from it arrived in the last 2 seconds** (judged twice a second; choosing another camera clears the preview); a stream that stops is "NOT LIVE · last frame <time>" |
| `capturing` | Capturing | From CAPTURE until the camera hands over its file |
| `processing` | Processing | ADAXAI's own step after a capture: storing and measuring the file |
| `capture_failed` | Capture failed | The camera or the server refused the capture: the reason in words and "Nothing was stored." |
| `device_error` | Camera error | An error the bridge reported, in its words; also a status the page cannot read, or a state it does not know |

- **Nothing is guessed.** A status the page cannot read is a camera error, never a state; a bridge of another contract version is not used.
- **In a browser without the bridge** there is no camera: the panel and the workspace say **"FLIR ONE not connected"**, there is no preview and CAPTURE stays disabled. The simulator is offered only where the deployment allows one (§2.5).

### 2.3 Thermal in the consultation: a part of the tools column, and a workspace over the consultation

- **The *Thermal* part** (`ThermalPanel`) joins the tools column after *Devices* (the bar reads *History, Conversation, AI draft, Mana, Devices, Thermal, More*). It lists **this consultation's** thermal images, each with its source, says whether a camera can be reached from this device, says when the patient's consent to thermal imaging is not recorded, and opens the workspace (*Open thermal imaging*). Images of other visits stay in the profile's *Documents*.
- **The thermal imaging workspace** (`ThermalWorkspace`) is a full-screen dialog **over** the consultation, which stays mounted underneath (a recording keeps recording and the device card keeps polling, the reason of ADR 0019 §2.2). Its header names the patient (the heading), age and sex, MRN, token, department and **"this consultation"**, and the capture area repeats "For <name> (MRN …), this consultation". It shows the camera's state in words, the live preview, the **body region** (Hand, Arm, Leg, Knee, Ankle, Face, Joint, Other: **metadata only, nothing is inferred from it**) with an optional description, and **CAPTURE**, enabled only while the preview is live and a region is chosen. It cannot be closed while a capture is being taken or processed. An earlier radiometric FLIR file can be **imported** into this consultation (labelled IMPORTED).
- **After a capture**: PROCESSING, then the analysis of the stored image: a **THERMAL ANALYSIS** dashboard (patient, region, captured, min, max, mean, standard deviation, regions, and the model status, §2.6); the existing thermal viewer (palettes, scale, the temperature under the cursor, regions drawn as a rectangle, an ellipse or, new, a **polygon**, each with an optional comment; **a pixel without a reading is drawn in grey stripes and left out of every statistic**); a **provenance card** (the source; the registered device, or "Not registered"; what the bridge reported, model, serial number, firmware and SDK version, under **"Reported by the device, not verified"**; the capture and receipt times; the **SHA-256 of the original file** with a link to download it; radiometric; the processing); and the summary card (§2.7).

### 2.4 How an image is stored: its source is recorded and fixed, and the file is checked whatever the source says

`POST /api/patients/:id/thermal` takes a `captureSource`:

| Source | Label | Sent by | Carries |
| --- | --- | --- | --- |
| `file_upload` (the default) | UPLOADED | the thermal pages, as before | optionally a consultation of this patient |
| `gallery_import` | IMPORTED | the workspace's *Import a thermal image* | the consultation |
| `live_capture` | LIVE CAPTURE | the workspace, with the file the bridge handed over | the consultation, `capturedAt` and `deviceReported` (both only with a live capture) |
| `simulator` | SIMULATED | **never an upload** (refused): only the simulator route, §2.5 | |

- **A live capture or an import goes only into the doctor's own consultation in progress** for this patient in the caller's facility: another doctor's consultation, a signed or discarded one, another patient's or another facility's is refused. This is checked when the request arrives **and again, holding the consultation, inside the transaction that stores**: a consultation signed or discarded while the image was being processed gets nothing ("This consultation was signed or discarded while the image was being processed. Nothing was stored."; the refusal is audited).
- **Consent** to thermal imaging is required (a grant for this consultation only counts, as an ongoing grant does) and is **looked at again inside the transaction that stores, holding the grant**: a withdrawal that commits while the image is being processed either comes first, and nothing is stored, or waits until the image has been stored.
- **The file decides.** Whatever the source says, the thermal service decodes the radiometric data with `flyr`; a file without it is refused with **"NON-RADIOMETRIC: …"** and nothing is stored (audited, `thermal.capture_refused`). The original is kept **byte for byte** with its SHA-256; the whole-image minimum, maximum, mean and, new, **standard deviation** are stored. The temperatures ADAXAI shows are the ones it computed from the file.
- **The camera** is linked to a registered device only by the **serial number** the bridge reported, and only to an **active device of kind `thermal_camera` in this facility that is not a simulator**; otherwise no device is linked, and what the bridge reported is kept as reported either way. A capture time more than five minutes ahead of the server's clock is refused.
- **What ADAXAI cannot verify:** that a file marked `live_capture` came from the bridge, and anything in `deviceReported`. Both are what the sending application says, and the screen says "not verified".
- **Fixed once stored.** A database trigger (`thermal_capture_provenance_guard`, migration 0031) refuses any change to a capture's source, simulated mark, device, device report, capture time, original and matrix files and data origin. Review and region statistics still update the row as before.

### 2.5 The thermal simulator: generated numbers, never a measurement

`POST /api/patients/:id/thermal/simulate` exists **only where the deployment's data is not clinical and the deployment is not production** (elsewhere 403, audited). Like a live capture it needs the doctor's own consultation in progress and the patient's consent. Its cases are deterministic for a seed (`packages/contracts/src/thermalSim.ts`, **`thermal-sim-v1`**, 160 × 120; the browser draws the simulated preview with the same code, so what is previewed is what is stored):

| Case | What happens |
| --- | --- |
| Even distribution | A warm oval on a cooler background with a little noise: generated shapes, not anatomy |
| Localized temperature difference | The same with one warmer spot |
| High variance | The same with much more noise |
| Missing data | The same with a block of pixels without a reading |
| Invalid capture, Processing failure | **Nothing is stored**: refused with SIMULATED in the message, and audited |
| Disconnected camera | A camera state in the browser; it never reaches the server |

- It is stored with `capture_source = simulator`, `simulated = true` and data origin `synthetic`; **database CHECK constraints** tie the three together and the provenance trigger (§2.4) keeps them. Its "original" is its case and seed as JSON, so that it can be generated again.
- It is marked **SIMULATED** wherever a capture is listed or shown (the device simulator's dashed mark), on the preview, and first in its summary.
- **It is left out of** the patient portal, the older assistant's context, the record Mana and the V3 draft read, and dataset exports (which count it as excluded), and **a simulated summary can never be added to a note** (the insertion route refuses it whatever the doctor decided). A simulated capture can be reviewed, for demonstration; it stays simulated.

### 2.6 No thermal model, and the place where one would go

**No trained thermal model is installed.** `GET /api/thermal/model-status` answers `available: false` with the reason "No trained thermal model is installed." (and "unavailable", with its own reason, when the thermal service cannot be reached); the screen shows **MODEL UNAVAILABLE** and "Nothing about a thermal image comes from a model: measurements and experimental rules only." The `ThermalModel` interface in `apps/api/src/thermal/client.ts` documents where a model would plug in and what every output of it would carry: its id and version, the SHA-256 of its weights, its preprocessing version, when inference ran, its input by reference (never the image, never a simulated one), its output, its own confidence where it has one, and its evaluation. A model would be added only with its weights, its evaluation for the stated use and a decision record. The evaluation pipeline's baseline (`thermal-eval-v1`) is a measurement of an exported dataset, trained and discarded within one run: **it is not a model**, and the product uses none. **No pain analysis exists, and no pain score is produced.**

### 2.7 The thermal summary: composed by fixed rules, decided once, and added to the note only by a separate act

- **Composed by fixed rules, not by AI** (`apps/api/src/thermal/summary.ts`, **`thermal-summary-v1`**; no language model). It is deterministic and states only the stored measurements (the whole image, each region, each pair) and the output of the thermal service's experimental rules `rules-v1` (an area at least **2 standard deviations above the image mean over 12 pixels or more**; an asymmetry between paired regions flagged at **|mean difference| ≥ 1.0 °C**), to which it adds no threshold of its own. Each statement carries its **basis** (*Measured*, *Experimental rule*, *Model*, *Limitation*) and its **source** in words. The model statement is **"No trained thermal model is installed: no model finding."** Every summary ends with the fixed limitations: **skin-surface temperature only; it does not measure pain and does not show swelling, inflammation, infection or fractures; not clinically validated.** SIMULATED or IMPORTED comes first, before any number. It never words a diagnosis, a score or a recommendation, and infers nothing from the body region. **Staff free text is only quoted**: the region description, a region's label and its comment appear only between quotation marks, on one line and cut at 80 characters (a comment as "Comment on this region (written by staff; not a measurement): “…”"), so they can never read as a measurement or a rule's output, and they are never interpreted.
- **Decided once.** A doctor (`thermal:approve`) composes it **only for an approved image** (the patient's consent is required). Approval already freezes the image and its regions (migration 0009), so a summary's numbers cannot go stale; an image awaiting review is told "Approve the image first", and a rejected image gets none. The doctor then accepts, edits or rejects it, once (also only while the image is approved). It is stored in `thermal_summaries`, and a trigger keeps what it says and its decision: it starts pending, is decided once, never changes afterwards and is never deleted; its simulated mark is its image's.
- **Into the note only by a separate act.** An accepted or edited summary **of this consultation**, not simulated, can be added to the note with *Add to Examination*, through the existing insertion route (`POST /api/encounters/:id/insertions`, subject `thermal_summary`), which checks the decision, the consultation and that the text is exactly the reviewed text, and records the composer and rules versions as what produced it. **A known wording limitation:** the note's existing provenance line calls every inserted machine text AI-assisted ("AI-assisted text from thermal study summary (thermal-summary-v1 …)"), as do the sign step's list and its attestation, so this summary is called AI-assisted there although no AI composed it; the versions the line names say what did. The insertion route checks again that the summary's image is **still approved**.

### 2.8 What the record readers see

- The record loader shared by Mana and the V3 consultation draft (`apps/api/src/mana/record.ts`) now gives, for each of the patient's three newest **approved** thermal captures in the facility, its capture time, its source in words, the whole-image minimum, maximum, mean and standard deviation, each region's statistics, each pair's difference, and the **latest doctor-reviewed summary** (accepted, or as the doctor edited it), worded as the doctor's and as "composed by rules thermal-summary-v1, not validated". **A simulated capture is never read, and nothing thermal is read for a patient who has withdrawn consent to thermal imaging.** Mana's record rules carry a new version, **`mana-record-v3`**; the record check is unchanged (`record-check-v2`).
- The older assistant's context reads approved thermal measurements as before, and **no longer a simulated one**.

### 2.9 Audit

| Event | When | What it records |
| --- | --- | --- |
| `thermal.workspace_opened`, `thermal.camera_connected`, `thermal.connect_failed`, `thermal.camera_disconnected`, `thermal.capture_failed` | Reported by the workspace (`POST /api/encounters/:id/thermal-events`); a connection that fails is its own `thermal.connect_failed`; with no bridge and no simulator, *workspace opened* names the bridge that was looked for, with the state `no_bridge` | The adapter, the state or reason, the camera model reported. **At most one event per user, consultation and event a minute**; repeats are answered the same and not logged |
| `thermal.upload` | An image stored, from any source | Source, simulated, device, consultation, the SHA-256 of the original, the image's dimensions, the extractor, the data origin |
| `thermal.capture_refused` | An image not stored: not radiometric or not a format the thermal service reads, a simulator case that fails, a simulator where none is allowed | Why, and how it arrived |
| `thermal.summary_generate`, `thermal.summary_review` | A summary composed; the doctor's decision | Versions, decision, simulated |
| `encounter.ai_insert` | A summary added to the note | Subject `thermal_summary` |

**Never image bytes, a frame or the words of a summary.**

## 3. What was not built

- **Anything that has run with a camera.** The bridge and the host app are not compiled; no FLIR ONE, tablet or SDK was used. The SDK's emulator interface is deliberately not scanned, because an emulated image would reach ADAXAI as a live capture ([THERMAL_CAMERA.md](../THERMAL_CAMERA.md) "Testing without hardware" lists what must exist first).
- **Other cameras:** the wireless FLIR ONE Edge and Edge Pro, other FLIR cameras on USB, FLIR ONE models made for iOS. The camera's battery level (the bridge does not report it).
- **A thermal model of any kind, pain analysis or a pain score, an image-quality or confidence output** (what the screen shows instead is how many pixels have a reading and the capture conditions recorded with the image), and any clinical validation. The camera's accuracy is FLIR's specification ("±3°C or ±5%, typical"), not something ADAXAI measured.
- **Moving an image filed to the wrong patient or consultation.** None can be moved or deleted; one can be rejected at review with a reason (it stays on record, gets no new summary and is not read by Mana or the V3 draft; a summary already accepted stays, §2.7).
- **A doctor-facing audit trail of the consultation** (V8).

## 4. Consequences

- A demonstration without hardware shows simulated captures, marked SIMULATED, and imported public FLIR sample files. **A live capture has never happened.**
- Migration 0031 adds the table `thermal_summaries`, new columns on `thermal_captures` (`capture_source`, default `file_upload`; `simulated`; `device_id`; `captured_at`; `device_reported`; `std_c`) and on `thermal_rois` (`points`, `note`), CHECK constraints and the two triggers. Images stored before V6 are `file_upload`, not simulated, and have no stored standard deviation (the dashboard says "Not stored for this image").
- The patient portal, the older assistant's context, the record readers and dataset exports leave simulated captures out; the dataset counts and exports say how many were excluded.
- `mana-record-v3`: Mana's answers and the V3 drafts now read thermal measurements in more detail, with the reviewed summary; answers and drafts stored earlier keep the version they were made with.
- A file without radiometric data is now refused with a message that starts "NON-RADIOMETRIC:", and the refusal is audited.
- The note's provenance wording calls the rule-composed summary AI-assisted (§2.7). Changing that wording would change it for every inserted text and the sign step's attestation; it was left as it is.
- The consultation's tools bar gains *Thermal*.

## 5. Verification

API: `apps/api/test/thermal-v6.test.ts` (the sources and what each may carry, NON-RADIOMETRIC refused and audited with nothing stored, the doctor's own consultation in progress, matching a camera by serial number, a consultation-only consent, the provenance trigger, the simulator in a synthetic deployment and refused where the data is clinical, the failure cases storing nothing, a simulated capture kept out of the portal, the assistant's context and a dataset export, polygon statistics against a mask worked out by hand, pixels without a reading, the model status, audit details without image bytes) and `apps/api/test/thermal-summary.test.ts` (the composer's order, wording and labels; composing with and without consent and without the matrix; the decision taken once and the database guards; adding to the note only an accepted or edited summary of this consultation, never a simulated one; what Mana and the consultation draft read; workspace events once a minute; facility isolation). Web: `apps/web/test/thermal.test.ts` (polygon selection agrees with the thermal service, pixels without a reading, source labels, when a summary may be offered for the note, the decision in words) and `apps/web/test/thermalCamera.test.ts` (the bridge's status read defensively, its contract version, connecting, frames and a capture from a stand-in bridge object, the deterministic simulator, LIVE within two seconds, a pixel without a reading drawn grey). Thermal service: pytest for the standard deviation, polygon masks, pixels without a reading, flags with polygons, and the model status. Browser: `e2e/thermal-v6.spec.ts` (no camera in a browser; the simulator playing a camera that is not there; a simulated capture measured and summarised, accepted and never in the note; a simulated invalid capture storing nothing; an imported public FLIR sample reviewed, edited and added to the Examination; the audit log, with no image bytes and no summary text). **None of it involves a camera, a tablet or the bridge.** Numbers and what was not tested: [STATUS.md](../STATUS.md), slice V6.
