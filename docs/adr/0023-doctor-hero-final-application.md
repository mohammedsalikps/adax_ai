# ADR 0023: the final Doctor HERO application: a four-item doctor app, the five-input workstation, a prescription page, an explicit Complete, service orders, documents, the digital pen and a global Mana

- **Status:** accepted; implemented (see STATUS.md "Doctor HERO final" for what was verified and what was not). Supersedes [ADR 0022](0022-doctor-hero-five-inputs-and-mana.md) §2.1–2.5 for the doctor's consultation (the rail of five modules, the workflow strip, the in-page Mana area) and [ADR 0008](0008-record-lifecycle-and-signed-record-verification.md) on one point: **signing no longer completes the visit**. Builds on ADR 0018 (devices), 0020 (thermal), 0021 (D2 context) and 0017 (Mana).
- **Date:** 6 Oct 2026
- **Basis:** the owner's master specification "FINAL ADAXAI DOCTOR HERO" and its addendum (17A–17E), mapped against `31cb765` in [DOCTOR_HERO_GAP_MATRIX.md](../DOCTOR_HERO_GAP_MATRIX.md).

## 1. Context

At `31cb765` the doctor's application was a seven-item admin-style sidebar, a Home with tiles and quick actions, a queue with front-desk tools, and a consultation of five collapsible rail modules beside an AI area. The owner's final specification asks for a calm clinical product: four destinations, a Today/Week/Month home, a working queue, a workstation where recording starts with the consultation and the five inputs (conversation, wearable, stethoscope, the doctor's own writing, thermal) are visible together, one "Generate prescription" action, a dedicated prescription page, an explicit Complete, the patient app updated from the same record, service orders, documents, and Mana everywhere — with nothing fake.

## 2. Decisions

### 2.1 Navigation and shell
The doctor's sidebar is **Home · My consultations · Patients · Thermal**; every earlier route stays reachable (tests and links use them). The global **development banner is removed for every role**; synthetic, simulated and unverified marks are local to the component that shows the data, and the printed prescription keeps its "not a valid prescription" note. Change password moved into an account menu; Sign out stays a visible button. A floating **Mana** button is mounted for doctors only and requests nothing until opened.

### 2.2 One vocabulary for the doctor's day
`doctorQueueStatus` (contracts) maps visits and appointments to *Yet to see · Waiting · In consultation · Completed* (+ *Signed — to complete*); Home, My consultations and Mana's fixed-rule answers use it and the same "mine" (`mineVisits` / `mineAppointments`). `GET /api/doctor/day?period=today|week|month` counts on the server in the facility's timezone (week = Monday to today, month = the 1st to today, a counted point per day, never padded) and returns today's timeline. Polling is every 30 s while visible; the read is audited with counts and the timeline's patient ids.

### 2.3 The workstation
Header: the patient, allergies (always), the recording state, the last vitals (staff values; device values marked; previous visit's value muted), the profile, a ⋯ menu (overview, photographs, shortcuts, discard). Grid: **live transcription** (main) · **clinical inputs** (vitals tiles + stethoscope) · **patient history** (from the record, with orders); below: **doctor notes** (Pen | Keyboard) and **thermal**. One bottom bar: *Order service* and **Generate prescription** (`data-testid="analyze-mana"` kept). Each panel is mounted once and placed by CSS, so the device card stays the only poller and recordings are not cut by a resize.

### 2.4 Recording starts with the consultation
A **new** Start passes a one-shot `autoRecord` flag; the transcription panel starts the microphone recording at once when the patient's recording consent is on record, the local speech service can record and no recording is open — otherwise it says exactly why not, with the action. The flag is cleared from history after use, so a reload, a resume or a signed record never starts recording; the synthetic demo never starts by itself. Live parts are 10 s (`liveChunkSeconds: 10`). After each transcribed part the **fixed rules** (`extract-rules-v1`) run by themselves; re-extraction keeps unchanged pending points (same id), and nothing is ever confirmed except by the doctor. No model identifies speakers.

### 2.5 Generate prescription and the prescription page
Generate saves the note, runs the fixed safety rules and the local model's draft (V3), and shows "Preparing the consultation": each line ticks only on its real signal (the save; what the server counted as sent; the model's real token count and the time since the click). The prescription page (`/doctor/encounters/:id/prescription`) opens when the draft is ready or partial, or at once when the model is down. Left: the **clinical summary** (AI DRAFT statements with *Add to note* = accept + recorded insertion in one explicit act, *Edit*, *Remove*; allergies and vitals from the record). Right: the **prescription** (clinic, doctor, patient; diagnosis; medicines; before-you-prescribe checks; advice/diet; follow-up; orders). **AI never creates a prescription row.**

### 2.6 Sign, print, complete
*Sign & print* signs (hash scheme **`adaxai.encounter.v3`**, which adds each medicine's `durationDays` and `startDate` to the signed content; v1/v2 records keep verifying) and opens the print page. **Signing no longer completes the visit.** *Complete consultation* (`POST /api/encounters/:id/complete`, the signing doctor only, confirmed in a dialog, audited as `encounter.complete`) completes the visit and its appointment and returns the doctor to My consultations with the row Completed. A database guard keeps a signed visit out of the queue. The patient app lists a consultation only once it is completed and shows **Today's prescription** with each medicine's course ("Day 3 of 7 · 4 days left"), computed on the server from the stored start date and duration in the facility's timezone; legacy free-text durations say "Duration not recorded".

### 2.7 Service orders and a labelled simulated lab
A catalogue in configuration; `service_orders` (+ append-only `service_order_events` written by a trigger). The only provider is a **deterministic simulated lab**: on each read an open order moves to the step its schedule gives for the current time (stored once, with the scheduled time); a completed simulated order carries the fixed text "Simulated laboratory: no test was performed and no result values exist." It never writes investigation results and never invents values. Everything about it is marked SIMULATED.

### 2.8 Documents, surgeries, triage note
`patient_documents` (PDF, JPEG, PNG sniffed by content; lab report, imaging report, imaging image, other; modality, study date, an optional staff-typed report text), `patient_procedures` (surgeries), and a nurse's **triage note** on the visit. No OCR, no DICOM viewer, no model reads an image or a document.

### 2.9 The digital pen
`encounter_handwriting`: versioned, append-only stroke documents (JSON in `files`), saved 1.5 s after the last stroke and on leaving; refused once the consultation is signed. Pointer Events with pressure and coalesced points, palm rejection when a pen is in use, undo/redo/clear. **No handwriting recognition**: the writing itself is the record; it is shown read-only on the signed record and never read by Mana or the draft.

### 2.10 Devices and stethoscope in the workstation
The live clinical inputs show staff values (blood pressure is staff-only by design) and device values with their states; where simulators are allowed a doctor can attach a registered SIMULATOR band or stethoscope and drive it from the page (client ticks, no server timer); everything simulated stays SIMULATED by the existing triggers. No sound analysis.

### 2.11 Mana everywhere
Scoped by route (consultation → encounter, patient page → patient, elsewhere → clinic). **Fixed-rule answers without the model** for the doctor's day (next patient, seen today, arrival time, waiting longest), the nurse's triage, orders and lab status (always "SIMULATED lab"), and imaging/report text; labelled "From the records (fixed rules)". **Voice**: a clip of ≤ 30 s is transcribed in memory by the local speech model and never stored; spoken answers only with the computer's own voices, off by default. **Actions**: only from the doctor's own fully specified words, in their own open consultation; Mana proposes ("Add to the prescription: …" with allergy and duplicate warnings), the doctor approves, the decision is stored and audited, and the row is added to the draft by the page as the doctor's act. The server never writes the prescription.

### 2.12 Thermal
A Thermal page: patient picker → Upload (or Capture, only into the doctor's in-progress consultation of that patient; "FLIR ONE not connected" in a browser; the simulator only where allowed) → the clinical thermal study (image, scale, hover temperature, ROIs with min/max/mean/SD, the reviewed summary), with engineering detail behind "Details". No model output, no score. A file upload into a closed consultation is refused.

## 3. Consequences

- The doctor sees one product: four destinations, one primary action per screen, nothing technical in the primary workflow.
- **Time:** Generate prescription waits for the local model (about 30–45 s on this machine); the screen says so and never pretends otherwise.
- A signed but not completed consultation keeps the visit open and blocks a same-day visit for that patient until Complete; My consultations shows it as "Signed — to complete".
- The patient sees a record only after Complete (a change from "after signing").
- Many end-to-end tests encoded the old layout; they are updated deliberately where the new behaviour is the intended one (see STATUS.md).

## 4. Not built (and why)

AI-proposed prescription rows (no model contract for doses: F); handwriting recognition (F); a trained thermal model or any shock score (F); FLIR ONE capture on hardware, a real wearable or stethoscope (E); a real laboratory integration (G); DICOM/PACS (G); patient self-booking and real-time push (out of the doctor app's scope this round; staff booking and honest polling remain).
