# ADAXAI status

**Last updated:** 7 Oct 2026.

ADAXAI is an MVP. It is not production-ready, not a medical device, and not clinically validated. All data is synthetic. Nothing here claims legal or regulatory compliance.

What the Doctor App actually does today, and the plan for its first complete consultation workflow, are in [DOCTOR_APP_AUDIT.md](DOCTOR_APP_AUDIT.md) and [DOCTOR_APP_PLAN.md](DOCTOR_APP_PLAN.md); safety records are in [safety/](safety/).

| Slice | Commit |
| --- | --- |
| 1. Mana AI patient-context Q&A; AI text in notes with provenance | `5cbefc1` |
| 2. Consent and access control | `be5ca8b` |
| 3. Record lifecycle and integrity | `26db008` |
| 4. Appointments, check-in, schedules, notifications, and the design foundation | `4be6256` |
| 4a. Authentication and application entry (a dedicated slice before the consultation workstation) | `5f0505d` |
| 4A / V1. Know the patient: patient history, today's patients, the consultation workstation, a synthetic hospital dataset | the commit titled "Doctor App slice 4A" (see `git log`) |
| V2. Live consultation capture: local speech-to-text, timed transcript, doctor-assigned speakers, important points | `9dfcca1` |
| V2.1. Hardening before V3: hosted-AI egress off by default, speech-service limits, withdrawal ends live recordings, migration 0025 pre-flight, seed clock fix | the commit titled "Doctor App slice V2.1" (see `git log`) |
| V3. Local AI consultation intelligence: a draft from a language model on this computer, checked by code, reviewed by the doctor | the commit titled "Doctor App slice V3" (see `git log`) |
| V4. Mana AI: the doctor's assistant over the clinic's records (a plan, authorised read-only tools, an answer written from what they returned, checks in code) | the commit titled "Doctor App slice V4" (see `git log`) |
| V5. Devices: a state on every reading (live, stale, disconnected, no data, unavailable), a gate on what a device may send, batches stored once, a simulator that cannot pass for a device, stethoscope recording in the browser | the commit titled "Doctor App slice V5" (see `git log`) |
| D1. The doctor's consultation as one workspace: V1 to V5 for one patient and one encounter, a tablet held sideways first, one way for AI text into the note | the commit titled "D1 integrated doctor consultation" (see `git log`) |
| V6. Thermal imaging in the consultation: a camera boundary for a FLIR ONE on a tablet (native bridge written, not compiled), captures with their provenance, a simulator, measurements, a summary the doctor reviews | the commit titled "V6 real FLIR thermal capture and analysis" (see `git log`) |
| D2. The multimodal consultation: one context read from the records, an overview with what waits, disagreements found by fixed rules and the evidence with how far it can be trusted, a summary composed by fixed rules, Mana's consultation questions | the commit titled "D2 multimodal doctor consultation" (see `git log`) |
| Doctor HERO redesign, **partial (stopped by the owner)**: five input modules, Analyze with Mana, the result and the prescription lane, the pediatric shock research view; three V3 check fixes | the commit titled "Doctor HERO redesign (partial, stopped early) and V3 check fixes" (see `git log`) |
| Doctor HERO Step 3: the first Step 3 brief's polish (real progress while the model writes, what Mana read, a synthetic demo consultation through the real speech model, a demo patient, missing ≠ none); **the "complete redesign" brief NOT built** | the commit titled "Doctor HERO final clinical workflow UI" (see `git log`) |
| **Doctor HERO final**: the doctor application per the owner's master specification — four-item navigation, Today/Week/Month, My consultations, the five-input workstation with recording on Start and the digital pen, Generate prescription → prescription page → Sign & print → Complete, the patient app's Today's prescription, service orders (simulated lab), documents and surgeries, a global Mana with fixed-rule answers, voice and confirmed actions, the Thermal page | the commit titled "Doctor HERO final application" (see `git log`) |
| **Doctor HERO jury polish**: the four reference screens (Home, the patient profile with tabs and average vitals, the workspace with docked Mana and the analyze flow, the prescription page with a real server PDF), a coherent demo clinic (`npm run demo:jury`), contextual fixed-rule Mana answers with their sources, the speaker demo fallback | the commit titled "Doctor HERO jury polish" (see `git log`) |
| **Doctor HERO premium clinical UX and Mana recovery**: Mana as a two-column clinical assistant with grouped contextual questions and new fixed-rule answers, the consultation cockpit, the converging Analyze diagram with the draft summary, the prescription document with a suggested diagnosis and inline sign checks, the thermal analysis dashboard (demo indices, not clinically validated), Home and profile per the reference | the commit titled "Doctor HERO premium clinical UX and Mana recovery" (see `git log`) |
| **Final demo polish**: Analyze fills an empty prescription with a labelled DEMO draft from what the consultation says (stomach pain → gastritis/dyspepsia + pantoprazole; fever; headache); an ordinary PNG/JPEG on the thermal pages is analysed as a demo (simulated values, labelled) instead of refused; a light visual pass | the commit titled "Finalize demo prescription and thermal flow" (see `git log`) |

## Final demo polish: demo prescription draft and the ordinary-image thermal path

**Basis:** the owner's "FINAL QUICK POLISH — DO NOT REDESIGN OR REMOVE FEATURES" brief. Two functional changes and a light visual pass on the
existing workflow; navigation, pages, Mana, the safety checks and the database unchanged. Synthetic data only; no hardware used.

### What changed

- **Demo prescription draft (DEMO / SEED, `apps/web/src/lib/demoPrescription.ts`).** In a deployment that allows simulators (synthetic data,
  not production), *Analyze & Generate Prescription* fills an **empty** prescription with a deterministic draft for what the consultation says —
  the chief complaint first, then the visit's reason, the history, the assessment and the conversation's text: *stomach / abdominal /
  epigastric pain* → Acute gastritis / dyspepsia, Pantoprazole 40 mg tablet, 1 tablet orally once daily before food for 5 days, "Avoid
  heavy/spicy meals. Maintain hydration.", "Review after 5 days or earlier if symptoms worsen."; *fever* → viral fever, paracetamol;
  *headache* → tension-type headache, paracetamol. It is a fixed keyword table, **not AI and not a clinical recommendation**; it never touches
  a prescription the doctor has started and keeps any advice or follow-up the doctor wrote; it is saved through the draft's own save. The
  prescription page says *Demo prescription draft — doctor review required* above the document; every part has **Edit**; the allergy name
  check, the sign checks, the review attestation, Sign & print and the separate Complete are unchanged. `demoPrescriptionFor` is the one entry
  point a real clinical decision support module would replace.
- **Thermal PATH B: an ordinary image is not a dead end.** A radiometric FLIR file goes through the real extraction as before (PATH A, its
  NON-RADIOMETRIC refusal and its tests unchanged). When the real extraction refuses an ordinary PNG/JPEG, the upload dialog says *Demo image
  detected — Temperature metadata is unavailable. Continuing with simulated thermal analysis.* with **Continue analysis**:
  `POST /api/patients/:id/thermal/demo-image` (only where the simulator is allowed; refused and audited in a clinical or production
  deployment) stores the picture as the original and values **simulated from its colours** by a fixed formula (contracts `demoImageHeat`),
  as a simulated capture (`simulator`, data origin `synthetic`: the database constraints), linked to the patient and to a consultation in
  progress when one is named. The dashboard shows the picture itself, the five demo indices, a summary that never calls the values
  temperatures ("simulated units"), and both labels: *Demo analysis — not clinically validated* and *Demo thermal analysis — temperature data
  not available*. Nothing detects pain or shock, diagnoses, or claims a validated score.
- **Light visual pass:** a lighter canvas, softer lines, a softer card shadow, rounder panels (tokens and the Panel only).

### Verification

- Typecheck and lint clean. API `thermal-v6` 23/23 (new: the demo-image route — refusals, stored as simulated with the picture kept, the
  analysis equal to the formulas over the colour grid, no "°C", audits, a consultation of another patient refused, the clinical deployment
  refused; the NON-RADIOMETRIC refusal test unchanged and passing); the other thermal API suites 39/39. Web unit 375/375 (new:
  `demoPrescription.test.ts`).
- End to end (desktop): `doctor-hero-final` (the demo draft shown, labelled, edited, signed and printed; Complete separate),
  `doctor-workflow` (the doctor's own Plan kept; the draft edited and signed), `mana.spec` (asking Mana changes nothing in the draft: compared
  before and after, version included), `thermal-v6` (new: an ordinary PNG → *Demo image detected* → the dashboard with the picture, five
  indices, the summary and both labels, axe clean), `thermal.spec` (the FLIR path) — all pass (two needed the usual solo rerun for page-load
  stalls on this machine). `consult.spec` (8) and `mana-analyze.spec` (3) fail as at the baseline (class C below: the panel they wait for is
  not on the consultation page).
- Real stack (this machine, the real local model and thermal service, a new synthetic patient): a stomach-pain consultation → Analyze → the
  prescription opened with Acute gastritis / dyspepsia, Pantoprazole 40 mg once daily before food for 5 days, the advice and the follow-up,
  labelled; edited (instructions, advice) → Sign & print (the printout carries the edits) → signed with the visit still in consultation →
  Complete. Thermal page: an ordinary JPEG → the notice → the demo dashboard; the public FLIR sample → the real extraction (240 × 320, flyr).

### Limitations

- The demo prescription is a keyword table for three demonstration cases; anything else leaves the prescription empty, as before.
- The demo image's values are simulated from colours: they are not temperatures; the thermal study view behind the dashboard shows them on
  its scale, marked SIMULATED.

## Doctor HERO premium clinical UX and Mana recovery

**Basis:** the owner's "PRODUCT POLISH + FEATURE RECOVERY" brief and the eight-screen reference image (Home, patient profile, consultation
cockpit, Mana, Analyze, thermal analysis, prescription, prescription preview). Sequential, on the existing application: backend, safety
checks and tests kept. Synthetic data only; no hardware used.

### What changed

- **Mana, the clinical intelligence assistant (recovered):** a wide two-column assistant ("Mana · Clinical Intelligence Assistant") opened
  from the sidebar's Mana card, the consultation header's Mana button, or the floating button where the sidebar is a drawer. Left: the current
  context (the patient, "Consultation in progress", or today's clinic) and suggested questions grouped "About Abdul" · "This consultation" ·
  "Today's clinic" (pronouns from the record's sex). Right: the conversation (questions right, answers left with Mana's mark and time, a typing
  indicator with the real phase, each source shown once), and "Ask Mana about this patient, today's queue, records, labs, medicines, or
  consultation…" with the microphone and a round Send. The context follows the page (clinic, patient, consultation and its prescription).
  New fixed-rule questions: how many patients are waiting (the same count as Home), who is in consultation, which lab reports are available,
  which services are pending; record lists answer one item per line. Questions the rules do not cover still go to the local model's planner.
- **Consultation cockpit:** a clean header (back, patient, allergy and condition chips, reason, "Consultation in progress", recording pill,
  Profile, History, Mana); Live conversation (dense gradient waveform) · Important points (their own column) · Doctor's note (Structured /
  Handwriting); Clinical signals in one row (BP, HR, SpO₂, Temp, RR, Stethoscope, Thermal); patient history and thermal details below. The
  stethoscope's recorder opens from its tile; AI provenance lines in the note are short (the model on hover).
- **Analyze & Generate Prescription:** the six inputs joined by dotted lines into the glowing ADAXAI clinical context, then Mana AI (the real
  model state, tokens and time), then Clinical summary · Prescription draft · Ready for review; when the draft is ready its clinical summary
  (AI DRAFT) is shown with [Review prescription] (the page opens by itself only when there is no draft to show).
- **Prescription:** the document is the hero (letterhead, patient and allergies, diagnosis, medications, advice, follow-up, signature line);
  parts with content read as the finished document with [Edit]; with no diagnosis the doctor's own assessment is offered as a draft diagnosis
  ("Use as diagnosis", the doctor's act); what signing still needs is shown in the part it concerns (never a blocking box; never signed empty);
  the PDF preview beside it; Back to editing · Sign · Sign & print · Complete consultation.
- **Thermal analysis dashboard (new):** after a capture or upload on the Thermal page, and from the consultation's Thermal tile ("View
  analysis"): the image with its temperature scale, five indices as rings (Pain pattern, Thermal asymmetry, Perfusion pattern, Temperature
  pattern, Thermal stress), a short summary, and "Demo analysis — not clinically validated". `GET /api/thermal/:id/analysis`
  (`apps/api/src/thermal/demoAnalysis.ts`): fixed formulas over the stored temperatures of the skin region, each with the number it comes from,
  behind a provider interface a validated model can replace; audited. They detect, predict and diagnose nothing.
- **Home:** greeting and date; Completed · Waiting · In consultation · Upcoming (the server's counts); today's activity by hour; today's
  patients. **Patient profile:** header with chips and Start/Continue consultation; Last recorded vitals · Current medications · Recent labs;
  Summary (a clinical summary in sentences by fixed rules, key history, averages of staff vitals, recent consultations, patient information)
  and the record's tabs.
- **Branding:** "(synthetic)" removed from people's and the clinic's names on screen, the print page and the patient app; the shell says once
  "Demo environment · Synthetic patient data".
- **Demo data:** Abdul Rahman gets a CBC and a lipid profile, and HR 78 as in the reference.

### Verification

- Typecheck and lint: clean. Web unit tests **369 passed** (the Mana suggestions test rewritten for the grouped questions). Web build: passes.
  **API: 1,120 passed, 1 skipped, 0 failed** (adds the thermal analysis route test and the Mana intent and suggestion-wording tests).
- **Critical browser tests** (`auth`, `doctor-hero-final`, `doctor-workflow`, `doctor-home`, `patient-portal`, `record-lifecycle`, `mana`,
  `devices-live`, `thermal-v6`, `nurse-workflow`, `entry`; desktop): all pass (61 passed, 1 skipped) after a first two-worker run with sign-in
  stalls and a solo rerun. Real fixes found by them: Mana's source chips disappeared under React's development double render (now computed
  once per answer), the Mana side column was not keyboard-scrollable, a diagnosis remove button was too small. Tests updated for the intended
  redesign (each with its reason): the Structured tab, the stethoscope sheet, the points column, the Home tiles, the Mana suggestions and
  placeholder, [Review prescription], the prescription parts' [Edit], the plain doctor name on the printout.
- **Real-stack walkthrough** (Chrome; Qwen3.5-4B on llama.cpp, faster-whisper-small): 19 of 19 steps — Home counts equal the server's; the
  profile's clinical summary; Start from the profile; demo conversation with the speaker fallback; 8 important points, one confirmed and added;
  stethoscope (simulated recording); simulated thermal capture → dashboard (scores 31 · 1 · 78 · 43 · 31, demo-labelled); Mana: 7 questions
  (next patient, how many waiting, history, medicines, allergies, last consultation, lab reports) — 7 different answers from the records;
  Analyze: the draft after 51 s of real model time, its summary, [Review prescription]; diagnosis accepted from the assessment; real PDF; Sign &
  print (the visit stays in consultation); Complete; the profile and Home updated; the patient app shows "Day 1 of 5". No horizontal overflow at
  1920, 1366, 1280, 1180 and 768 px.

### Limitations

- The thermal indices are demonstration formulas, not a model; nothing here is clinically validated. FLIR hardware was not used.
- The speech model identifies no speaker: Doctor/Patient on unassigned lines is the labelled demo fallback.
- Questions outside the fixed rules depend on the local model (about 10–20 s each); with the model down they are refused, never guessed.
- Remaining e2e specs outdated by the earlier redesigns (listed in the sections below) were not updated in this pass.

## Doctor HERO jury polish: the four reference screens, a coherent demo clinic, a real prescription PDF

**Basis:** the owner's "FINAL JURY UI/UX + FUNCTIONAL POLISH" brief (with the four-screen reference image). A focused pass on the existing
application: no architecture change, the backend, safety rules and tests kept. Synthetic data only. No hardware was used.

### What changed

- **Demo clinic (`npm run demo:jury`, development database only):** ADAXAI Clinic, Dr. Meera Iyer, 20 fictional patients, 103 earlier
  signed and completed consultations over four weeks, and **Ramesh Kumar** (45 M, MRN ADX-001245) with conditions, an allergy, medicines, a
  surgery, four earlier consultations with staff vitals, eight results and two small synthetic PDF reports; today 5 completed · 1 in
  consultation · 6 waiting · 8 booked = 20, all counted by the server. (The reference image's 5/20/15/20 cannot all hold at once; the tiles
  show the server's counts.) See [DEMO.md](DEMO.md#the-jury-demonstration-adaxai-clinic--dr-meera-iyer--ramesh-kumar).
- **Shell:** plain names (the data's "(synthetic)" mark said once, in the sidebar's footer); "Doctor HERO" under the brand; Mana in the
  navigation.
- **Home (screen 1):** pastel tiles with icons; the current patient (with me, or next) beside the week's consultations; today's patients.
- **Patient profile (screen 2):** `PatientRecordView` — header with allergy and condition badges; tabs Overview · Consultations ·
  Prescriptions · Lab Reports · Imaging · Documents · Surgeries · Allergies & Medications; *Average / Recent Vitals* (averages of STAFF
  measurements over 6 / 12 months / all; device and simulated values left out); record summary by fixed rules (not AI); recent
  consultations; patient information; active medications.
- **Consultation workspace (screen 3):** condition badges and "Consultation in progress"; [View history]; the Mana panel docked in the
  workspace (four one-tap questions answered by fixed rules, with their source); a simple "Doctor's note" (Chief complaint, History of present
  illness, Clinical findings, Assessment, Plan; Keyboard first, Handwriting second); **speaker demo fallback**: lines nobody assigned show a
  dashed Doctor/Patient chip alternating by recorded part, said once under the conversation ("no model identified the speakers"); the
  thermal tile says **SIMULATED THERMAL CAPTURE** for a simulator image; the primary button is **Analyze & Generate Prescription**.
- **Analyze (§29):** the "Analyzing the consultation" sheet shows the six inputs (each ticking on the server's real line; the stethoscope
  "recorded · not analysed"), then ADAXAI Clinical Context → Mana AI (the local model's real state, token count and time) → Clinical summary →
  Prescription draft. The only staging is the inputs' entrance (about 2.5 s); the model's stage lasts exactly as long as the model.
- **Prescription (screen 4):** "Review and sign prescription": the document first, the **PDF preview** beside it (the server's real PDF,
  remade after each save), [Open PDF] [Print]; bottom bar Back to editing · Preview · Sign · Sign & print · Complete consultation (locked
  until signed). New **`GET /api/encounters/:id/prescription.pdf`** (`apps/api/src/encounters/pdf.ts`, hand-written PDF 1.4, no dependency;
  permission `encounters:read`; audited as a read; a draft is marked "DRAFT — NOT SIGNED" on every page; a signed one carries "Signed
  electronically on …"; every page's footer: synthetic data, not a valid prescription). Signing still never completes; Complete is separate
  and confirmed.
- **Mana:** new fixed-rule answers about the conversation's patient (history summary, medicines, last consultation, lab results, surgeries,
  today's consultation), each with its source ("From the patient record", "From this consultation", "From today's queue", "From service
  orders"); names that point at another patient, or no patient, still go to the planner and its safety checks.
- **Demo audio:** regenerated as an adult fever consultation for Ramesh (Windows voices; still SYNTHETIC AUDIO); the real local speech model
  transcribed it with 0 word errors in 69 words.

### Verification

- Typecheck and lint: clean. Web unit tests **369 passed** (3 tests updated for the intended changes: the demo audio offsets, the Mana chips,
  Sign / Sign & print both through the review). Web build: passes. **API: 1,118 passed, 1 skipped, 0 failed** (adds the PDF tests and the
  jury Mana questions).
- **Real-stack jury walkthrough** (Chrome; the real local models: Qwen3.5-4B on llama.cpp, faster-whisper-small): login → Home (tiles equal
  the server's counts) → Week/Month → patient profile and all tabs → Start consultation → demo audio transcribed live → important points
  found, confirmed, added to the note → vitals (no DISCONNECTED) → simulated thermal capture → four Mana answers, all different, each with
  its source → note → Analyze (the prescription page opened after 40–50 s of real model time) → diagnosis and two medicines → PDF (draft
  mark) → Sign & print (the visit stays in consultation) → Complete → the profile shows today's consultation and Home counts one more seen.
  No horizontal overflow at 1920×1080, 1440×900, 1366×768, 1280×800, 1180×820, 768×1024 (Home, profile, workspace, prescription).
- **Browser tests (the suite's labelled stand-ins):** the critical set (`auth`, `doctor-hero-final`, `doctor-workflow`, `doctor-home`, `patient-portal`, `record-lifecycle`, `mana`, `devices-live`, `thermal-v6`, `nurse-workflow`; desktop): the first run, with the full dev stack and the local models running beside it, had 7 passed, 1 skipped and 29 failed + 1 not run, almost all `page.goto` timeouts at sign-in (this machine's known request stalls under load); **all 30 passed on a rerun alone with one worker** → **37 passed, 1 skipped, 0 failed**. Tests updated for the intended changes (equal or greater strength, each with its reason in a comment): `doctor-hero-final` (the pen is now the "Handwriting" tab), `auth` (the top bar shows the plain name), `mana` ("Summarize history" now stays offered with the model down and is answered by fixed rules from the record, with its source).

### Limitations

- The speech model identifies no speaker; the Doctor/Patient chips on unassigned lines are a labelled demo fallback, not diarization.
- Thermal in the demo is the simulator (SIMULATED); FLIR hardware was not used. The stethoscope is recorded, never analysed.
- The Home times follow the moment `demo:jury` ran (completed patients are earlier that day).
- The PDF uses the standard Helvetica fonts (WinAnsi): characters outside Latin-1 are written as "?" (none occur in the demo).

## Doctor HERO final: the doctor application rebuilt on the existing foundations (master specification)

**Basis:** the owner's "FINAL ADAXAI DOCTOR HERO" master specification (with 17A–17E), and the later time-critical rule (one focused integration gate, then commit). Gap analysis first: [DOCTOR_HERO_GAP_MATRIX.md](DOCTOR_HERO_GAP_MATRIX.md) (450 requirements of `31cb765` classified A–G with file:line evidence). Decisions: [ADR 0023](adr/0023-doctor-hero-final-application.md). Built in four phases by agents following one design: foundation (migration 0033, contracts, the doctor shell, primitives), nine full-stack feature units (each independently reviewed and fixed), the workspace and the prescription page (reviewed and fixed), and the integration gate. Synthetic data only. No hardware was used.

### What the doctor now has

- **Navigation:** Home · My consultations · Patients · Thermal; Mana floating on every page; **no development banner** for any role (local SIMULATED/UNVERIFIED/synthetic marks stay; the printout keeps "not a valid prescription").
- **Home:** Today | Week | Month from `GET /api/doctor/day` (server counts in the facility's timezone; week and month trend per day, never padded); today's patients with time, status (Yet to see / Waiting / In consultation / Completed / Signed — to complete) and one action.
- **My consultations:** today's queue in time order (All · Waiting · Completed), Start consultation as the main action, a polite "… is ready for you" cue (from the existing poll; no push).
- **Patients:** search by name, MRN, phone or ABHA; patient page Summary · Details · Documents; **documents** (PDF/JPEG/PNG: lab reports, imaging reports and images, with modality, study date, typed report text) and **surgeries** (new).
- **Consultation workstation:** the header (patient, allergies, recording state, last vitals with the previous visit's value, profile, ⋯); **live transcription** where **recording starts with a new consultation** when the patient's recording consent is on record (honest reason otherwise), 10-second parts, a live waveform, **important points found automatically** by the fixed rules; **clinical inputs** (staff vitals incl. BP, device values with their state, an in-app SIMULATED band where simulators are allowed) and the **stethoscope** (inline recording, waveform, SIMULATED recording where allowed, no analysis); **patient history** from the record with **orders**; **doctor notes** with the **digital pen** (pressure, palm rejection, undo/redo/clear, autosave, versioned, no recognition) or the keyboard; **thermal**; one bottom bar: Order service · **Generate prescription**.
- **Generate prescription:** "Preparing the consultation" with each line ticking on its real signal and the model's real token count; the **prescription page** opens when the local model's draft is ready (or at once if the model is down): clinical summary (AI DRAFT; Add to note / Edit / Remove) | the prescription document (diagnosis, medicines with a structured duration and start date, the fixed-rule allergy check re-run on the prescription page, advice/diet, follow-up, orders).
- **Sign & print → Complete consultation:** signing (hash scheme `adaxai.encounter.v3`, durations included) no longer completes the visit; printing never does; **Complete** (the signing doctor, confirmed, audited) completes the visit and appointment and returns to My consultations, marked Completed.
- **Patient app:** a consultation appears once completed; **Today's prescription** with each medicine's course ("Day 1 of 5 · 4 days left"), computed on the server.
- **Service orders:** catalogue in configuration; Requested → In progress → Completed / Cancelled; the only provider is a **deterministic SIMULATED laboratory** that never writes results or values.
- **Mana:** fixed-rule answers without the model (next patient, seen today, arrival time, waiting longest, nurse triage incl. a new **triage note**, orders/lab status — always "SIMULATED lab" —, imaging report text); voice questions transcribed in memory by the local speech model (never stored); spoken answers with local voices only (off by default); **actions** proposed from the doctor's own words, approved by the doctor, carried out by the page as the doctor's act.
- **Thermal page:** patient → Upload / Capture (only into the doctor's in-progress consultation; "FLIR ONE not connected" in a browser; simulator only where allowed) → measurements, ROIs and the reviewed summary; engineering detail behind "Details". A file upload into a closed consultation is now refused.

### Verification

- **Static and unit:** typecheck (every workspace and the e2e config), lint (oxlint, the thermal and speech linters): clean. **Web unit tests 369 passed** (188 before this round). Web production build: passes.
- **API:** the full suite after the backend work: **1,114 passed, 1 skipped, 0 failed** (65 files; 989 tests at `31cb765`). The one later API change (refusing a thermal file upload into a closed consultation) was checked with the thermal API tests (27 passed); the full API suite was not re-run after it.
- **Browser (Chromium, the suite's labelled stand-ins for the models and speech):**
  - Baseline at the start of the gate (desktop, 130 tests): 44 passed, 80 failed, 5 skipped, 1 not run — the failures were tests of the old layout.
  - The gate, run spec by spec with one worker, classifying every failure (A product regression → fixed; B environment → proven by a focused rerun; C outdated by the intended redesign → updated to the new behaviour at equal or greater strength, each with its reason): **one product regression found and fixed** (the device card's state word overflowed its tile at 1280×800); the review of the Phase 3 code found and fixed two more (typing lost in Advice/Follow-up during an insertion; the allergy name check never saw the medicines — it now re-runs on the prescription page and before signing).
  - **Final run of the critical set** (desktop): `doctor-hero-final` (the new full journey: Home with the server's counts → My consultations → Start → recording starts → transcription → automatic points → clinical inputs → history → pen autosave → Mana fixed-rule answer → Generate prescription → prescription page → Add to note → diagnosis and medicine with a 5-day course → Sign & print (not completed) → Complete → Completed in the queue → audit trail without free text → the patient app's Today's prescription "Day 1 of 5"; plus the doctor pages at six sizes without horizontal overflow), `doctor-home`, `patient-portal`, `doctor-workflow`, `record-lifecycle`, `appointments`, `mana`, `devices-live`, `thermal-v6`, `nurse-workflow`: 34 tests, **28 passed, 5 failed, 1 skipped; the 5 failures (the first tests of each worker on a cold stack and request stalls of this machine) all passed on a focused rerun (5 of 5)** → 33 passed, 1 skipped (the phone-only drawer test, passed on the mobile project). Also green in the gate: `auth` 8/8, `entry` 25/25, `consent`, `devices`, `routing`, `thermal`.
  - **Not updated, still failing at the baseline (class C, outdated by the redesign; not deleted, not weakened; not part of the critical gate):** 56 tests in 12 specs — `history` (21), `capture` (10), `consult` (8), `workspace` (4), `ai-clinical` (3), `mana-analyze` (3), `hero-demo` (2), `ai-assistant`, `doctor-hero`, `hero-journey`, `multimodal-consultation`, `thermal-research` (1 each). They drive the old rail, workflow strip, in-page Mana area and "Analyze with Mana"; the journeys they covered are now covered by `doctor-hero-final`, but each needs a deliberate update. They were not re-run after the shared e2e helpers were updated.

### Not done, and why

- **Hardware-dependent (E):** FLIR ONE capture (the Android bridge is written, never compiled or run), a real wearable, a real stethoscope. Simulators are labelled SIMULATED everywhere.
- **Model-dependent (F):** AI-proposed prescription rows (no model contract for doses), handwriting recognition, any trained thermal model or shock score, stethoscope sound analysis.
- **External integration (G):** a real laboratory (only the labelled simulated lab), DICOM/PACS.
- **Out of the doctor app's scope this round:** patient self-booking and real-time push (staff booking and honest polling remain).
- **Not re-verified on the real local models in this round** (deadline): Generate prescription uses the same V3 draft path that was measured at `31cb765` (Qwen3.5-4B, about 36–43 s); the speech path is unchanged except for 10-second parts. All browser tests here use the suite's labelled stand-ins.
- **No full visual review by eye** of the new screens (deadline); sizes are checked by the browser tests for horizontal overflow.

## Doctor HERO final clinical workflow UI (Step 3): the first brief's polish built; the full redesign brief NOT built

**Basis:** two owner briefs for Step 3, received in turn. (1) "STEP 3 — DOCTOR HERO UI/UX + THERMAL / PEDIATRIC SHOCK RESEARCH" with its UI/UX addendum: polish of the five-input workstation (progress while the model writes, what Mana read, a demo consultation, a demo patient, missing ≠ none, safety fixes). (2) "STEP 3 — COMPLETE DOCTOR HERO UI/UX REDESIGN — REPLACE THE CURRENT DOCTOR UI": a new doctor application (no sidebar, a Today/Week/Month home, a patient profile with tabs, a digital pen, one band-and-stethoscope input, recording that starts with the consultation, a separate prescription document page, a persistent Mana button, no development banner). **Work on (1) was finished by five implementation units; (2) arrived while (1) was running, the running work was stopped, and (2) was never started.** This commit is the owner's "STEP 3 RECOVERY": the finished work of (1), checked and repaired where the stop left it unfinished, with no new implementation round. Decisions: [ADR 0022](adr/0022-doctor-hero-five-inputs-and-mana.md) §5. The machine-learning reality audit (Step 2) is [ML_REALITY_AUDIT.md](ML_REALITY_AUDIT.md). No hardware was used.

### What was built (brief 1)

- **Progress while the local model writes.** The local language-model client streams when it is asked for progress (the request is otherwise identical; the answer was checked byte for byte against the real llama-server: the whole answer, the assembled stream and the raw pieces have the same SHA-256). A draft being made carries `ConsultDraft.progress` (tokens written, the cap, from the server's own count; in memory only) and is polled every second. The page shows "812 tokens · 44 tokens/s · at most 2,600 tokens" (a speed only from two successive server counts; no percentage, no time left).
- **What Mana read.** Each draft records `ConsultDraft.inputsUsed`, counted from what was actually sent (confirmed points, history items, the note, staff and device vital signs, approved thermal measurements). The result shows "Mana analyzed" with each source; a source with nothing sent says so; the stethoscope is always "recordings are not analysed".
- **Play demo consultation (synthetic).** Eight WAV files (about 30 s; two Windows voices, 16 kHz; `scripts/demo-audio.ps1` and `.mjs`, byte-reproducible, checked against a manifest with SHA-256) are played through the speakers and each part, as it ends, is posted to the **real local speech model** as a live chunk. The transcript shows only what the model heard. Everything is marked "SYNTHETIC AUDIO — computer voices, not a real consultation"; the transcript stores `audio_origin = demo_synthetic` (migration `0032_transcript_audio_origin`, additive, nullable, no backfill); the overview's evidence trust is "Synthetic demo audio, not a real consultation"; Mana's answers resting on it must say "synthetic". It is offered, and accepted by the server, only where simulators are allowed. Important points are then found by the existing fixed rules (`extract-rules-v1`). No speaker is identified by any model: the voices are not attributed automatically.
- **A demo patient.** `npm run demo:hero` seeds "Anaya Demo-Synthetic" (a child; amoxicillin allergy; a signed consultation 60 days ago; salbutamol on the medicine list), a new ready visit on each run, and a simulator band. Synthetic only.
- **The rail.** A compact header once the page scrolls that keeps the name, age, MRN, every allergy, the urgent mark, the out-of-range vital-signs badge and the status chips; module empty states with their action ("Not recorded yet" [Record], "Allergy status not recorded" [Record], "No device attached" [Attach device], "No recording yet" [Record], "Thermal image not captured" [Capture thermal]); a waveform for each stethoscope recording ("Amplitude of the recording. Not an analysis."); "No clinical sound analysis: recordings are not analysed by any model."; a thermal thumbnail with its temperature scale; "Signal quality: not reported by the device".
- **The right side.** Grey placeholders where the result's sections will be while the model writes (no text); a short staggered reveal (none with reduced motion); keyboard shortcuts (Ctrl/⌘+S, Ctrl/⌘+Enter, Alt+1…5, Alt+N, Alt+P, Shift+? for the list); "Repeat a current medicine" in the prescription (fills a row from the medicine list; the doctor checks each field and adds the duration); "Preview & print" saves first, then opens the print page; the header menu has View profile, Keyboard shortcuts, More tools and Discard draft.
- **Check fixes.** `consult-checks-v3` (G6): when the record has no allergy status, a draft statement saying "no known allergies" (or NKDA, "denies allergies"…) is removed (`allergy_absence_not_recorded`): missing is not none. `mana-record-v4` / `mana-tools-v4` (G14): Mana's medicines answer starts with the recorded current medicines.

### What was NOT built (brief 2, "COMPLETE DOCTOR HERO UI/UX REDESIGN")

None of the following exists. They are reported as not done, not as partly done:

- a doctor home without the application sidebar, and the **Today / Week / Month** views (the home and *Today's patients* are D1's; the sidebar still has Appointments, Patients, Thermal and AI review, and the home still offers "Register patient");
- the **patient profile page with tabs** (timeline, thermal and lab in the profile); the profile is still D1's sheet;
- the **digital pen** (a card still says handwritten notes are planned);
- **one combined band-and-stethoscope input** (they are still modules 3 and 4);
- **recording that starts with "Start consultation"** (the doctor still presses Record);
- a **separate prescription document page** (the prescription is still a card in the consultation, with D1's print page);
- a **persistent Mana button** on every page (Mana is in the consultation's right column);
- **removal of the development banner** (still shown: "Development build. Synthetic data only. Not for clinical use. Not a medical device.");
- the brief's visual redesign and its acceptance flow.

### Real AI verification (this machine, development stack, synthetic data)

One browser run (Playwright, Chromium, 1366×768, recorded) of the whole journey on the development stack with the **real** services: `npm run demo:hero` → sign in as dr.meera → *Today's patients* → Start consultation for Anaya Demo-Synthetic (the simulator band sending SIMULATED values) → Play demo consultation → confirm the allergy point → a line in the note → Analyze with Mana → accept a statement and add it to the note → a diagnosis, Repeat a current medicine, a duration → Preview & print → Complete consultation → Review and sign. **Every step passed; the consultation was signed.**

| What | Measured |
| --- | --- |
| Speech model | `local-speech faster-whisper-small` (from the transcript's runs), CPU int8 |
| Demo audio | 8 parts (30 s of synthetic audio) → 9 lines, **72 of 72 words identical to the script**; first line 10.4 s after Play, last 40.0 s; transcript `audio_origin = demo_synthetic`; every line's speaker source `none` (no speaker identified by a model) |
| Language model | `qwen3.5-4b-q4_k_m`, llama.cpp b11379 (CUDA, RTX 3050), weights SHA-256 `00fe7986…69ef11a4`, `local: true` |
| Analyze with Mana | **37.7 s click to result; 36.0 s server**; 1,396 tokens counted at 35.6 s; speed shown 38–44 tokens/s; 18 statements produced, 18 kept, 3 flagged, 0 removed |
| Mana analyzed | 40 sources: 1 confirmed point, 16 history items, the note (2 sections and the visit reason), 20 staff vital signs; thermal "no approved image was sent"; stethoscope "recordings are not analysed"; **device 0** (the band's values were SIMULATED and, as designed, never given to the model) |
| Print | "Draft — not signed · not a valid prescription" with the diagnosis and the repeated medicine |

The 10-second target is **not met** (as before: the writing is the time).

### Verification

- **Recovery.** The stopped round's five units had finished; its sixth (browser tests) had stopped part-way, with edits never run. Found and repaired: the development database was not migrated (0032 applied after a verified backup); the web's trust colour had no case for the new `synthetic_audio` (added, with its test row); the demo consultation's check whether simulators are allowed read the device list when a consultation opened, so "Attach a device" showed that cached list and missed a device registered moments before (the dialog now reads the list again when it opens).
- Typecheck (every workspace and the e2e config), lint (oxlint, thermal and speech linters): **clean**. **Web unit tests 179 passed.** Web production build: **passes**.
- **API: 987 passed, 1 failed, 1 skipped of 989 tests**, and one file's clean-up hook failed, in the full suite (21 min, run beside other work); both were time-outs in files Step 3 did not change (`devices-v5`: a database client time-out; `migrator`: the 60-second hook that drops its scratch databases, after its 4 tests passed); **both files passed alone (57 of 57)**: this machine's load.
- **Browser (Chromium, desktop project, the suite's stand-ins for the models), 15 consultation specs, 75 tests:** doctor-hero, hero-demo (new: the demo journey, recorded as video, and missing ≠ none), hero-journey, mana-analyze, mana, thermal-research, thermal-v6, multimodal-consultation, workspace, consult, capture, history, devices-live, doctor-workflow, doctor-home. First run **66 passed, 8 failed, 1 skipped** (a phone-only test). Classified: **(A) from Step 3, fixed:** hero-journey (the cached device list above); mana "suggested questions" (the medicines answer now starts with the medicine list, by design (G14): the assertion now checks that order and still requires "There is no signed consultation in the record."). **(C) a defect already in the partial commit, fixed:** the closed Mana card's heading was named "Ask Mana : Mana AI…" (a visually hidden suffix is a block of its own); it is now named by `aria-label`, and the test is unchanged. **(B) this machine:** two history sizes and three Mana tests (a conversation that never opened during a burst of load), **passed on the rerun with one worker**. In the reruns doctor-hero timed out at sign-in three times **when it was the first test of a fresh development server** (the app still compiling), and passed after a short first test; hero-journey failed once measuring the panes while the page was still loading and passed in its two other reruns. **Every one of the 75 tests passed in its latest run; no test was weakened.**
- **Visual check** (the real-model run's screenshots at 1366×768, 1440×900, 1920×1080, 1180×820 and 768×1024, looked at; the browser tests' own checks at seven sizes): no horizontal overflow at any size; no blocking problem found.
- Final checks: no secret, key or password in the diff (the demo password is read from `.env` and never printed); no debug code; no developer text in what clinicians see; no claim of a trained thermal model, shock prediction, stethoscope analysis or hardware.

### Known issues and limitations

- **The second brief ("complete redesign") is not built** (the list above). Against that brief, Step 3 is **not accepted**.
- **Time:** Analyze with Mana takes about 30–45 s on this machine; the 10-second target is not met.
- At 1366×768 four of the five modules are fully visible when the consultation opens (the fifth, Thermal, below the fold); the development banner takes a row.
- The "Stale" notice is written by the server and says "Generate a new draft to include them" while the button in the consultation reads "Analyze again" (the standalone draft panel's button does say "Generate a new draft"; a test asserts the server's text).
- The live recorder shows a real microphone level bar, not a waveform; waveforms are drawn for stethoscope recordings only.
- Important points from the demo's audio carry "Speaker not assigned: guessed patient": the fixed rules guess the speaker and say so, and such a point needs the explicit tick (V2's rule); no model identifies speakers.
- The development database holds synthetic patients and consultations left by the units' and the recovery's browser runs (and a scratch database, `adaxai_heroplayer`, from the demo unit); the home page counts them.

## Doctor HERO redesign (partial: stopped by the owner) and three V3 check fixes

**Basis:** the owner's brief "Doctor HERO — premium clinical workstation UI/UX redesign + thermal imaging + pediatric shock research integration". Decisions: [ADR 0022](adr/0022-doctor-hero-five-inputs-and-mana.md). **The owner stopped the work for time after the first polish round; it is committed as it stood after the essential checks below, NOT through the brief's full final gate** (no independent adversarial review of this diff, no full end-to-end suite run, design documentation not rewritten). No hardware was used. V7 and later were not started.

### What was built

- **Layout** (doctor's consultation editor only; the nurse's view and the signed record are unchanged): a workflow strip (*Inputs → Mana analysis → Your review → Note & prescription → Sign*, each step's real state, replacing D1's "Go to" bar); on the left the **five input modules** (*Conversation, History, Health band & vitals, Stethoscope, Thermal imaging*), each a compact summary with its existing full panel kept mounted underneath; **Analyze with Mana** at the foot of the rail; on the right the Mana area (analysis, the local model's draft as the Mana result, the D2 fixed-rule overview with the safety rules, Ask Mana closed until opened) and the record (note, diagnosis, prescription with "Before you prescribe"); side by side only on a wide screen (1920). The app's navigation is a drawer on the consultation. Clinical photographs and the older assistant are under "More tools".
- **Analyze with Mana:** saves the note, then runs the fixed safety rules and the local model's draft (V3) together; shows what each input contributes (stethoscope recordings are never analysed; simulated values never read), the real steps (saving, rules, *waiting for the local model* / *writing*), an elapsed clock, and afterwards the server's "took", "waited" and "writing and checks" (`ConsultDraft.startedAt` added).
- **Prescription:** no AI prescription rows exist or were added. "Before you prescribe" shows the draft's medication considerations as **AI DRAFT** text (to the note's Plan only, by the doctor), "No AI prescription suggestions", and the fixed-rule allergy name check; "Print preview" of the unsigned draft.
- **Thermal and PEDIATRIC SHOCK — RESEARCH MODE:** module 5 with a thumbnail of the newest image, its source, approval and range; a research sheet with the pipeline's real stage statuses, the feature set of approved non-simulated images, "Research model unavailable", and the **published research** (Sudhi et al., *Engineered Science* 2025, 33, 1367, doi:10.30919/es1367, a review article; figures attributed to the primary studies Nagori et al. 2019 and Vats et al. 2022, checked against those papers), labelled "PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION". No score, threshold, probability or prediction.
- **V3 fixes** (`consult-checks-v2`): local-day date comparison (00:00–05:30 IST defect, and the 180-day rule); SpO₂'s subscript no longer counted as a figure; newer readings from a streaming device no longer make a draft STALE (staff readings, withdrawn readings and a device's first reading of a new kind still do).
- **Clinician wording:** the speech service's setup instructions ("Start it with npm run …") are no longer shown to clinicians.

### Measured Mana latency (real local model, not a stand-in)

| Run | Click to result (browser) | Server (latency) | Waited for the model | Writing and checks |
| --- | --- | --- | --- | --- |
| 1 | 36.9 s | 36.2 s | 0.0 s | 36.2 s |
| 2 | 39.8 s | 39.0 s | 0.0 s | 39.0 s |
| 3 | 43.0 s | 40.2 s | 0.0 s | 40.2 s |

Development stack on this machine: llama.cpp b11379 with CUDA, Qwen3.5-4B Q4_K_M, a synthetic consultation with every input (a streaming band, a recording, an approved imported thermal image). The model read about 1,700–1,800 prompt tokens at about 1,300 tokens/s and wrote about 1,500–1,700 tokens at **43.7 tokens/s**: the writing is the time. Two more runs by the visual reviewer took 37 s and 40 s. **The owner's target of about 10 seconds is NOT met** (average about 40 s, slowest 43 s). Reaching it needs a shorter first answer (a summary-first step with its own prompt and checks) or a faster model: an owner decision. The browser test stand-in (mock model, 0.4 s) takes about 3.5 s click to result, dominated by the 3-second draft poll; that is not a product timing.

### Verification done (essential only, at the owner's request)

- Typecheck, lint, web build: clean. **Web unit tests 151 passed.** API: `consult*` and `consultation-context` tests **149 passed** (V3 fixes with `consult-checks-v2`).
- Browser (Chromium, desktop project, the suite's stand-ins): ten consultation specs (doctor-hero, hero-journey, mana-analyze, thermal-research, multimodal-consultation, workspace, capture, history, consult, devices-live; 55 tests). **Every test passed in its latest run.** Their history in this last stage: on the tree left by the stopped polish round, 8 of 21 failed, all from that round's unfinished edits (the draft's status badge moved out of its region, the rail's patient line removed, a compact header hiding the status chips, the AI labels hidden before a draft, the record check moved) and one test reading the speech service's setup instruction, now hidden on purpose; each was fixed (the compact header removed, the rest restored) and the test updated with its reason. Then 51 of 55 passed; of the 4, two were this machine's network stalls (the queue page never loaded) and two were the AI labels and the record check above, fixed; the five specs concerned then passed 17 of 17. **The full end-to-end suite was not run.**
- Screenshots of the development stack at 1366×768, 1440×900, 1920×1080, 1180×820, 1024×768, 768×1024 and 390×844 (two passes): no horizontal overflow at any size; inspected by me and by one visual reviewer.

### Known issues and limitations

- **At 1366×768 only two of the five modules are fully visible when the consultation opens** (three or four once the page scrolls and the rail sticks): the consultation header (D1's, kept so that the vital-signs alert and the status chips stay on screen) and the strip take the top. A compact header was tried in the stopped second polish round and **removed**, because it hid the out-of-range vital-signs alert and the status chips while scrolling.
- The thermal thumbnail occasionally appears only after about 17 s (the matrix fetch is retried); at 56px the iron palette reads dark.
- Opening "What Mana reads" under the Analyze button enlarges the rail's footer and squeezes the module list at 768px-high screens.
- The 10-second target is not met (above).
- Not done: the independent adversarial review of this diff, the full end-to-end suite (only the consultation specs listed above), a rewrite of DESIGN.md (ADR 0022 records the decisions), a tablet or screen reader by hand, any hardware.
- V3, left as is: the dates shown *to the model* are still UTC days; an exponent such as "10⁹/L" is still removed as a figure (fails safe); Mana's checks still count the "2" of "SpO2".
- Product behaviour to note: with a band streaming, the device values change between analyses (the draft is no longer marked STALE for that alone).

## D2: the multimodal consultation — one context read from the records, an overview, disagreements found by rules, a summary made by rules, and Mana's consultation questions

**Basis:** the owner's brief "D2: multimodal doctor consultation and unified clinical intelligence". Decisions: [ADR 0021](adr/0021-d2-multimodal-consultation-context.md); the screen: [DESIGN.md](DESIGN.md) §4i. **D2 adds one read-only route and one read-only Mana tool; no table, no migration, no model, no prompt, no new capture.** It composes what V2 to V6 and D1 keep about one consultation. **No hardware was used. It did not start V7, V8, V9 or V10**, and it did not change the nurse, patient or admin applications.

**What the doctor will notice:** the consultation's tools column starts with **Overview**: what waits for their review (each count leads to where it is reviewed), where two sources disagree ("Sources disagree. Staff measured SpO₂ 98 % at 10:40; a device (unverified) sent 94 % at 10:42.", never resolved), the newest evidence with its kind, time, state, source and how far it can be trusted, what is missing, and a summary composed by fixed rules (closed until opened). In Mana, four new suggested questions about the consultation.

### What is real, simulated, unverified or unavailable

| Part | State in this build |
| --- | --- |
| The consultation context (`GET /api/encounters/:id/context`) | **Real**: built on request from the existing records, nothing stored again; tested with synthetic cases A to J and in the browser |
| The Overview | **Real**, tested in Chromium (stand-ins for the model, speech, microphone, devices and camera) and looked at on the development stack at six sizes |
| Disagreements (`context-conflicts-v2`) | **Fixed rules, not clinical**: thresholds chosen by engineering (SpO₂ 3 %, heart rate 15 /min, temperature 0.5 °C, respiratory rate 5 /min, within 15 minutes); shown, never resolved |
| The summary (`multimodal-summary-v2`) | **Composed by fixed rules, not AI**; advisory; never written to the note |
| Mana's consultation questions | **Real**, tested with a labelled stand-in model (API tests) and the suite's stand-in (browser); **asked of the real local model** (the development stack's llama.cpp server, Qwen3.5-4B Q4_K_M) on a synthetic consultation: answers in 5 to 7 seconds, one or two statements of each removed by the answer checks, the server's findings (the disagreement, the SIMULATED items left out) shown: safe but terse |
| Wearable readings | As V5: **no device has been connected**; in the tests and screenshots the "band under test" is a device record whose gateway is the test posting fixed numbers (shown "device reading, unverified"), and the simulator band is SIMULATED (never LIVE, never in the summary's observations, never a disagreement, never given to Mana's model) |
| Stethoscope | As V5: recordings from Chromium's synthetic audio input; **"recording available for clinician review; not analysed"**; no analysis exists |
| Thermal | As V6: **no camera**; the simulator (SIMULATED) and a public FLIR sample file imported (labelled IMPORTED, "date taken not known") |
| V3's consultation draft | **Unchanged** by D2 (its inputs are as at V6) |

### Implemented

- **Contract** (`packages/contracts/src/consultationContext.ts`): the evidence item (kind, title, detail, time, state, **trust**, source, versions, the part of the screen that says more), the trust vocabulary (*Entered by staff*, *Said in the consultation*, *Extracted from the conversation, to review*, *Fixed rules, not AI*, *AI output, to review*, *Device reading, unverified*, *SIMULATED, not a measurement*, *Recorded, not analysed*, *Measured*, *Reviewed by the doctor*), disagreements, what waits (with `unread`: kinds not read or not shown), what is missing, the summary.
- **API** (`apps/api/src/consultation-context/`): `build.ts` (each source read on its own, bounded, for this encounter only; a source that fails is left out and said to be missing; what waits counted in full; a device's newest reading of each kind by index look-up within its assignments; device states by V5's `readingState` at the server's clock; who sees what as today: the conversation and points to doctors, the AI draft to the consultation's doctor only, Mana conversations to their doctor), `conflicts.ts` (four rules; allergies compared again with the record as it is now; a device's value never called measured), `summary.ts` (five sections, each statement with its trust and the items it rests on; no absence stated of a source not read), `routes.ts` (`encounters:read`; another facility's consultation is "not found" and audited; `encounter.context_viewed` once per user and consultation every five minutes, counts only; the window given back when the audit row could not be written; `RateLimiter.reset` added for that).
- **Mana**: the read-only tool `consultation_context` (`mana-tools-v3`; `assistant/consultation.ts` turns the context into facts, topic by topic; nothing simulated given to the model; consents to thermal imaging and to recording applied; a rejected point never a fact), four suggested questions with fixed plans, and the answer checks `mana-answer-checks-v4` (the trust word must be said; no raising; no word added to a recording, a thermal measurement or a simulator's output, however short; "staff measured" only beside a cited staff value). The planner prompt is unchanged.
- **Web**: `lib/consultationContext.ts` (the read every 15 seconds while visible, on focus and after an insertion; no retry of a reply the screen does not understand; pure helpers), `components/clinical/ConsultationOverview.tsx`, *Overview* first in the consultation's tools column (`ConsultationPage.tsx`, `App.tsx`), the consultation questions shown only in a conversation opened in a consultation (`ManaAssistant.tsx`).

### Synthetic cases (API, `apps/api/test/consultation-context.test.ts`)

| Case | What is checked |
| --- | --- |
| A, all modalities | conversation, points, staff vital signs, device readings, stethoscope, approved thermal image and its summary, AI draft with an accepted statement, a Mana conversation, a note insertion: every kind present, newest first, each with its trust, state and versions; the summary's five sections |
| B, thermal unavailable | no thermal item, nothing invented; "No thermal image … (for information; not required)" |
| C, wearable disconnected | DISCONNECTED, never LIVE |
| D, stethoscope unavailable | none listed; nothing said of a sound anywhere |
| E, AI unavailable | no draft item; the summary and the missing list say no AI draft was made, and why when known |
| F, conflicting measurements | staff SpO₂ 98 against a device 94: one disagreement with both values; the agreeing reading not listed twice |
| G, unverified readings | "device reading, unverified" everywhere, never "measured" |
| H, simulated device and thermal data | SIMULATED items, never LIVE, never in the summary's observations, never a disagreement |
| I, unauthorized access | another facility's consultation: 404, audited; a patient-portal session: refused |
| J, wrong encounter | another consultation of the same patient: its thermal images and device readings contribute nothing |

Also: the audit window and its return after a failed audit; failing sources (`unread`, no false all-clear); counts beyond the listed items; a confirmed point kept in the summary behind 40 newer ones; allergies compared with the current record (a recorded allergy ends the disagreement; an edited point is not judged by the extraction's reading); vital-sign sources named, never "measured"; imported and uploaded images labelled; stable device ids.

### Tests

- **API:** **946 passed, 1 skipped** (52 files plus the skipped one; 888 at V6). D2's own: `consultation-context.test.ts` (27: the cases A to J and the checks listed above); Mana: `mana-tools.test.ts` (39), `mana-assistant.test.ts` (75), `mana-answer.test.ts` (79), `mana.test.ts` (21), `consult.test.ts` (40), with D2's additions (the tool read-only, scoped, refused across patients, facilities and outside a consultation; consents; nothing simulated reaching the model; the trust words; nothing added to a recording or a measurement; no recording in V3's prompt or Mana's record). The only expectations changed are version strings bumped on purpose (`mana-tools-v3`, `mana-answer-checks-v4`) and the list of suggestions, extended.
- **Web:** **78** (`consultationContext.test.ts` 13). **Thermal service** 42, **speech** 61. **Typecheck, lint** clean; **web build** succeeds.
- **End to end:** `e2e/multimodal-consultation.spec.ts` (one consultation with every modality and the overview after each; see *Browser verification*) passes, alone (1.9 minutes) and in the full suite. **The whole suite on the final code (2 workers, nothing else running): 172 passed, 17 failed, 57 skipped (24.7 minutes). The 17 run again on their own: 16 passed; 1 failed**, `consult.spec.ts` *the doctor decides each statement*, which is **the pre-existing V3 defect** above (run at 02:52 IST; its draft called today's vital signs outdated). Classification: **16 FLAKY-ENVIRONMENT** (this machine's network stalls, see V5: page loads over 60 seconds, lists not loaded within 5 seconds; all pass alone), **1 FAIL from a pre-existing defect outside D2**, **57 SKIPPED** (tests marked desktop-only in the phone project, and the `-real` specs that need the real model and speech service). The run before the tools-column fix: 171 passed, 17 failed, 57 skipped, 1 did not run (16.3 minutes); alone, 16 passed and 2 failed (the same V3 test, and `history.spec.ts` *the allergies stay in front of the prescriber*: the layout defect above, fixed).
- **No test used a wearable, a stethoscope, a camera or a tablet.**

### Failures found during D2, and what was done

- **My own browser test** assumed one penicillin point (there are two: one confirmed, one still a draft), read the overview before its next refresh, expected "READY FOR REVIEW" where a draft from a record without an allergy status is "PARTIALLY AVAILABLE", and looked for the signed note's provenance inside the note region; all four were the test's mistakes, corrected.
- **The existing consultation tests found two things.** (1) `e2e/consult.spec.ts`, *states at five widths*: at 390 px the overview, now above the AI draft, left a checkbox of the draft half under the sticky top bar where the test scrolled, and axe measured only its uncovered part (a probe showed the checkbox at −2 px). The page is unchanged; the test now runs axe with the panel placed below the bars by `scrollIntoView({ block: 'start' })`, as D1 did for Mana; axe still checks every element. (2) `consult.spec.ts`, *the doctor decides each statement*: run just after midnight, the draft called the nurse's vital signs of today "outdated". **This is a defect from before D2** (V3, `apps/api/src/consult/validate.ts`: a record item's UTC date is compared with the facility's local day, so from 00:00 to 05:30 IST everything measured that day reads as yesterday's). **Not fixed in D2** (outside its scope); recorded here and offered as a separate task. Tests that generate a draft fail at that hour.
- **The full suite found a layout defect that D2 exposed**: `history.spec.ts`, *the allergies stay in front of the prescriber*, failed every time on its own: scrolled to the bottom at 1280 × 720, the sticky consultation bar left the screen. A probe showed the page about 1,090 px taller than the workspace: visually hidden labels (absolutely placed, Mana's among them) escaped the tools column's scroll area, whose overflow does not clip what it is not the containing block of, and stretched the page at their place far down the column. The defect was there since D1; the overview above them made it show. Fixed by making the scroll area their containing block (`relative`, `ConsultationPage.tsx`); the test passes, and the whole suite was run again on that change.
- **The implementers' screenshots showed** each band reading listed twice (every reading near a staff value was added, not only the compared one) and a thermal source "* (imported)" (the FLIR sample's camera model is "*"): both fixed.
- **The first look at Mana with the real model** found nothing wrong in Mana: my screenshot script asked before the panel had opened, and then read the previous answer; corrected.

### Independent review of the D2 diff (before the commit)

One independent adversarial review: four reviewers (clinical-safety semantics, security and isolation, robustness and performance of the read model, the web overview), each followed by a verifier who tried to refute every finding by reading the code and running checks. Its report is model output; each finding was weighed. **26 findings were verified: 24 confirmed (2 high, 9 medium, 13 low), 2 refuted.** All 24 were fixed by three fixers on separate files, then an independent regression checker re-read every fix (each confirmed fixed with file and line), re-ran typecheck, lint, the web tests and 400 API tests, and reported four small residuals, which I fixed.

- **High, fixed:** (1) the stethoscope recordings had been added to V3's draft inputs, and V3's existing checks let a model's invented sound through ("Mitral area recording suggests a murmur." kept as *inferred*, no tick): **removed**; V3's inputs are as at V6, with a test that no recording, typed note or simulated recording reaches the prompt and that an invented murmur is not kept. (2) Important points found by the default rules carried the trust "Fixed rules", so Mana could state an unreviewed or rejected point as fact: a point's trust now follows its review state (*Extracted from the conversation, to review* until decided), rejected points are left out, and Mana's checks require the word.
- **Medium, fixed:** Mana's tool gave the model thermal measurements after consent to thermal imaging was withdrawn, and conversation points without consent to recording (both now applied, with the reason told); rejected points reached Mana as "to review"; the "nothing added" check ignored words under four letters ("hot", "red", "rub"); a disagreement quoted a device's value as "Measured"; allergy disagreements used flags frozen at extraction against the edited text and the current record; an unread source counted as "nothing waiting"; the summary stated an imported image's numbers with no IMPORTED label and with the import time as if it were the capture time.
- **Low, fixed:** what waits counted from capped lists; an unread source stated as "none" in the summary; the live draft missed after ten failed attempts; the audit window spent before a failed audit; the device state word frozen in the summary text; legitimate answers removed ("maximum", "staff measured"); a transcript "Live" drawn in the device colours; device rows re-keyed at every read (focus lost); a reply that does not parse retried twice per read; the device query scanning every reading of the visit.
- **Residuals the checker found, fixed by me:** the allergy comparison read at most 20 allergies; an edited allergy point was still judged by the extraction's negation; the summary's confirmed points came from the capped list; Mana still quoted the AI draft's words when consent to recording was not in place.

### Remaining limitations

- **No hardware**, as in V5 and V6: no wearable, stethoscope or camera was used; the browser test's devices are this test posting numbers, and its camera is the simulator and a public sample file.
- **The thresholds of `context-conflicts-v2` are not clinically chosen**; the overview's usefulness has not been tested with doctors.
- **Mana with the real local model is terse**: its checks remove what they cannot tie to a fact, so answers can be one line; the planner prompt does not describe the new tool (a free-text question is rarely routed to it; the four suggested questions always are).
- **The pre-existing V3 time-zone defect** above (00:00 to 05:30 IST).
- **`workspace.spec.ts`, *the bar of the tools column moves that column*,** failed once (the part jumped to was out of view) in a run of 15 and passed 3 times of 3 on its own; not explained. A possible cause, not shown: the overview's content arriving while the column is still scrolling to a part below it. Not fixed.
- **The overview is read every 15 seconds** while a consultation is open (bounded queries; audited once per five minutes); it is not in the signed record's view.
- **The note still calls every inserted text "AI-assisted"**, the thermal summary included (V6's known wording limitation).
- **The full end-to-end suite still meets this machine's network stalls** (see V5); failed tests are run again on their own and classified below.

### Browser verification

| What | How | State |
| --- | --- | --- |
| The whole journey: sign-in, dashboard, today's patients, the consultation; the overview at the start (staff vital signs, nothing waiting, what is missing, the summary's five sections); the conversation recorded and its points waiting, a pending count leading to them; an allergy confirmed and the allergy-status disagreement; an AI draft with one accepted statement; a band under test (SpO₂ 94) and a simulator band (131) attached: the staff-versus-device disagreement, the simulator SIMULATED and never LIVE, not in the summary; Mana's two consultation questions; a stethoscope recording; a SIMULATED thermal capture and an imported sample approved, summarised, accepted and added to the Examination; the overview at the six sizes and axe; diagnosis and prescription typed by the doctor; signing; the nurse's view of the context; the audit log | `e2e/multimodal-consultation.spec.ts`, Chromium, the real API, database and thermal service | **Driven, passed.** The model, speech recogniser, microphone, stethoscope input and devices are the suite's stand-ins; the camera is the simulator and a public sample |
| The overview on the development stack at 1024 × 768, 1180 × 820, 1280 × 800, 1366 × 1024, 1920 × 1080 and 390 × 844 | screenshots by a script (synthetic patient; band under test, simulator band, stethoscope from Chromium's fake audio input, thermal simulator and the public sample) | **Looked at**, before and after the review's fixes: no horizontal overflow at any size; the review block, the disagreement, the evidence rows with their marks, the summary |
| Mana's consultation questions with the real local model | the development stack's llama.cpp server (Qwen3.5-4B Q4_K_M) | **Real model, synthetic consultation**: 5 to 7 seconds an answer; terse (see above) |
| A tablet, a screen reader by hand, any hardware | — | **Not tested** |

### Dev-environment actions

- No migration (D2 adds no table). No backup was needed.
- A development stack (`npm run dev`: API, web, thermal, speech and the verified local llama.cpp server with Qwen3.5-4B) had been started by one of the implementation agents at 22:06; it was used for the screenshots and Mana's real-model questions and then stopped (`taskkill` of that process tree only; PostgreSQL left running). An agent's temporary `.claude/launch.json` was removed. Synthetic patients were created through the API; nothing was downloaded; no hosted provider was called; no secret was printed.

## Slice V6: thermal imaging in the consultation — a camera boundary for a FLIR ONE on a tablet, captures with their provenance, a simulator, measurements and a summary the doctor reviews

**Basis:** the owner's brief "V6: real FLIR ONE thermal imaging, live capture and AI/ML analysis". Decisions: [ADR 0020](adr/0020-v6-thermal-capture-in-the-consultation.md); the camera, the tablet, the bridge and how to verify them: [THERMAL_CAMERA.md](THERMAL_CAMERA.md); the screen: [DESIGN.md](DESIGN.md) §4h. **No FLIR ONE, Android tablet, Android build tools or FLIR SDK was available, so nothing in V6 has been run on a camera or a tablet; the native bridge has not been compiled.** No trained thermal model exists, and none is shown. **It did not start D2, V7 or later.**

### What is real, simulated, unverified or unavailable

| Part | State in this build |
| --- | --- |
| FLIR ONE on an Android tablet (USB-C) | **Not tested: no hardware.** The native bridge (`android/`) is written against the FLIR Atlas Android SDK 2.4.0 reference (FLIR's own javadoc; every FLIR class and method it uses was checked there). **Not compiled, not run.** The FLIR SDK needs a FLIR developer account and FLIR's licence; FLIR reviews apps for the FLIR ONE before release |
| The camera boundary in the web app | **Real and tested** with a stand-in bridge (unit tests) and the simulator (browser): one adapter interface, eight states in words, LIVE only while the current camera is previewing and sending frames. In a browser there is no bridge, and the workspace says "FLIR ONE not connected" with no preview |
| Live capture path to ADAXAI | **Real server path, tested with files**: the bridge hands over the camera's own radiometric JPEG; the upload route stores it as a live capture of the doctor's open consultation, with what the device reported (not verified). Not exercised with a real camera's file |
| Imported FLIR file | **Real**, tested with a public FLIR sample file (someone else's scene): labelled IMPORTED |
| Simulator | **Real, labelled SIMULATED everywhere**, deterministic; allowed only where data is not clinical and not production; kept out of the patient portal, every model's input, Mana, dataset exports and the note |
| Measurements (min, max, mean, SD; regions incl. polygon; pairs) | **Real**, from the radiometric data (flyr) or the simulator's numbers; skin-surface temperature only; not clinically validated |
| Rule findings | **Experimental rules `rules-v1`** (hot spots, asymmetry), labelled as such; not validated |
| Thermal model | **Unavailable: none is installed.** The interface where one would plug in is documented; nothing shows a model output |
| Pain analysis | **None.** No pain score is produced anywhere |
| Summary | **Composed by fixed rules (`thermal-summary-v1`), not AI**, from an approved image; reviewed by the doctor; added to the note only by the doctor |

### Implemented

- **Contracts** (`packages/contracts/src/thermal.ts`, new `thermalSim.ts`): the capture's source (`live_capture`, `gallery_import`, `file_upload`, `simulator`), the body site list (metadata only), polygon regions with a comment, what the device bridge reported, the simulator's cases, the model status, the summary and its review, the workspace's audit events. `thermalSim.ts` is the one deterministic simulator, used by the browser's preview and the server's capture.
- **Database** (additive migration `0031_thermal_v6`): on thermal captures the source, the simulated mark, the matched device, the capture time, what the bridge reported, the standard deviation; on regions the polygon's corners and a comment; a new `thermal_summaries` table. CHECKs tie `simulated` to the simulator source and to synthetic data; a trigger keeps where a capture came from unchangeable; a trigger keeps a summary's words and its one decision, and none is deleted.
- **API** (`apps/api/src/thermal/`): the upload takes a live capture or an import only into the doctor's own consultation in progress (checked again, held, when storing), with the patient's consent checked again, held, when storing; a capture time more than 5 minutes ahead or 24 hours old is refused; a non-radiometric file is refused "NON-RADIOMETRIC"; a FLIR ONE is linked to a registered thermal camera by the serial number it reports (not verified). `POST /api/patients/:id/thermal/simulate` (only where data is not clinical and not production). `GET /api/thermal/model-status` (no model). `summary.ts` and `summary-routes.ts`: compose (approved images only), list, review once; `POST /api/encounters/:id/thermal-events` (the workspace's audit events, at most one per user, consultation and event a minute). The note insertion route takes a `thermal_summary`. The record loader of Mana and V3, the older assistant's context, the patient portal and dataset exports leave simulated captures out; the export now carries polygon corners.
- **Thermal service** (Python): the standard deviation, polygon masks (even-odd, pixels without a reading left out), `GET /model/status`.
- **Web**: `lib/thermalCamera.ts` (the adapter interface, the native bridge adapter for contract v1, the simulator adapter, the states), `lib/thermalCapture.ts`, the consultation's **Thermal** part (`ThermalPanel`) and the **thermal imaging workspace** (`ThermalWorkspace`), `ThermalSummaryCard`, `ThermalSourceBadge` (the one change nurses see: the source label on thermal lists and images), `ThermalModelStatus`, the viewer's polygon tool, region comments, provenance card and grey stripes for pixels without a reading.
- **Native bridge** (`android/`, not compiled): `FlirOneCamera.kt` (FLIR SDK discovery over USB, USB permission, connect, thermal stream, preview frames, capture by `ThermalImage.saveAs`), `AdaxaiThermalBridge.kt` (the JavascriptInterface, origin-checked), `BridgeJson.kt`, an example WebView host, the manifest and USB device filter (FLIR's vendor id; product ids to be taken from FLIR's sample), `build.gradle.kts`. [THERMAL_CAMERA.md](THERMAL_CAMERA.md) describes the hardware, the tablet, the SDK, the permissions, the contract, the security, and the 15 steps to verify on hardware.

### Tests

- **API:** **888 passed, 1 skipped** (51 files plus the skipped one; as before, the clean-up hook of `db-safety.test.ts` ran past 60 s once with all its tests passed, and passes on its own, 11 of 11). V6's own: `thermal-v6.test.ts` (20: sources, NON-RADIOMETRIC, the doctor's own open consultation including signed or discarded while processing, capture-time bounds, device matching, encounter-scoped consent and consent withdrawn while processing, provenance trigger, the simulator in synthetic and clinical deployments and its failure cases, simulated kept out of the portal, the older assistant and exports, polygon and missing-pixel statistics, model status, audit) and `thermal-summary.test.ts` (27: the composer's order, numbers, wording and quoting, approved images only, review once, the database guard, insertion only of an accepted summary of this consultation exactly as reviewed and never simulated, Mana's thermal record, the workspace events, facility isolation).
- **Web:** 65 (`thermal.test.ts` 10, `thermalCamera.test.ts` 12: the bridge's status read without guessing, connect only on a reported connection, frames and captures from a stand-in bridge, the simulator, LIVE, missing pixels drawn grey). **Thermal service:** 42 (polygon, NaN, standard deviation, model status, the export's polygon). **Speech** 61. **Typecheck, lint** clean; **web build** succeeds.
- **End to end:** `e2e/thermal-v6.spec.ts` (one journey: no camera in a browser; the simulator playing a missing camera; a SIMULATED capture measured to the simulator's own numbers, approved, summarised and refused for the note; a failed capture storing nothing; Escape in the import dialog; an imported public FLIR sample approved, summarised, edited and added to the Examination; diagnosis and prescription untouched; the audit log). **The whole suite (2 workers, nothing else running): 175 passed, 13 failed, 56 skipped (21.2 minutes); the 13 failed tests all passed when run again on their own (13 passed, 2.3 minutes)**: every failure was a wait for the server on this machine (see V5), none in a thermal test.
- **No test used a camera, a tablet or the FLIR SDK.**

### Failures found during V6, and what was done

- **Three of the four first implementers were cut off by a dropped connection** to the model service; what they had written was checked (typecheck, their tests, the native code against the FLIR reference) and completed.
- **The browser test found three faults:** a camera failure showed "Something went wrong" instead of the camera's own words; stopping the simulator folded its controls away; the model status appeared twice. All fixed.
- **The first documentation pass described three gaps that had just been fixed** (it read the code while the fixes were being made): corrected against the final code.
- **My own test was too blunt** (it matched "fractures" inside the limitation that says thermal imaging does not show fractures); it now checks every statement except the fixed limitations.
- **The rerun reviewer found that a dataset export dropped polygon corners**, which made evaluation fail for the whole export: fixed, with a test.

### Independent review of the V6 diff (before the commit)

One independent adversarial review: six reviewers (provenance and the simulator, the summary and the insertion, the camera workspace, the native bridge, regressions in the secondary applications, tests and claims), each finding then checked by a separate verifier who tried to refute it. Its report is model output; each finding was weighed. **41 findings were verified: 29 confirmed (7 medium, 22 low, none critical or high), 12 refuted.** A network outage stopped 11 verifications and one reviewer; that reviewer was run again (one medium finding, fixed: the export's polygon corners), and the 11 unverified findings were read: those that held were covered by the fixes below or are listed under the limitations.

- **Medium, fixed:** an accepted summary could reach the note after its image was rejected or its regions changed (a summary is now composed only for an approved image, whose image and regions are frozen, and its review and insertion check that it still is); a connected camera whose preview had stopped could not be restarted, and a connect timeout could leave no button (*Start live view*, *Connect* always available, 45 s); Escape in the import dialog closed the whole workspace; the page's connect timeout was shorter than the bridge's discovery and USB permission prompt; after the tablet app paused, the page could not restart the live view (the bridge reports its true state).
- **Low, fixed:** a capture stored into a consultation signed while the file was processed (checked again, held, when storing); capture times without bounds; the device link presented as fact (now "matched by the serial number the device reported, not verified"); imported images unlabelled in the older assistant's context; staff text inside "Measured" statements (now only quoted, one line, 80 characters); an edit limit below a long summary's length (now the note's 8,000); React's development double-mount disposing the bridge adapter; a second Escape closing the dialog behind React's back; a simulator interval leak; the real camera re-created by changing the simulator's case; LIVE following frame age only (now the camera's state too); every preview frame re-drawing the analysis; the state badge stuck at CAPTURE FAILED; "Nothing was stored" claimed when the server may have stored it; a tablet-clock time stored as the camera's; audit events naming the simulator when none was used, and a failed connection logged as a failed capture; unsaved regions discarded without a word; the SDK initialised with the application context instead of a UI context; `kotlinOptions` (an error from Kotlin 2.2); "measured from the radiometric data" said of a simulated capture; consent withdrawn while processing untested.

### Remaining limitations

- **No hardware: the whole live path is unverified.** The bridge is written against FLIR's reference, never compiled or run; a FLIR ONE's file has not passed through `flyr` here (only FLIR sample files have); the product ids for the USB filter, the tablet, the Android version and the USB permission behaviour are unknown until a device is used. The 15 steps in [THERMAL_CAMERA.md](THERMAL_CAMERA.md) are all **not tested**.
- **"Live capture" is what the sending application says**; the server checks that the file is a radiometric FLIR file, not that it came from the bridge. What the device reported (model, serial, firmware, SDK) is stored as reported.
- **No thermal model, no pain analysis.** Findings are measurements and the experimental rules `rules-v1` (not validated).
- **The note calls the rule-composed summary "AI-assisted"** (the note's existing wording for every inserted text); the versions it names say what made it.
- **The patient portal still shows approved imported images without an IMPORTED label** (a secondary application, not changed in V6); simulated images never reach it.
- **The full end-to-end suite still fails on this machine's network stalls** (see V5); the failed tests pass when run again on their own.

### Browser verification

- **Looked at** (Chromium driven by a script against the development stack; a synthetic patient with thermal consent; **the simulator**, no camera): the consultation's Thermal part; the workspace with no camera ("FLIR ONE not connected", no preview); the simulator LIVE with SIMULATED on the preview; the analysis after a capture (dashboard with every measurement and MODEL UNAVAILABLE, the "SIMULATED: not a measurement" warning, the viewer); the summary card (each statement with its basis, the fixed limitations, "A simulated summary cannot be added to a consultation note."), at 1024×768, 1180×820, 1366×1024, 1920×1080 and 390×844 (no horizontal overflow, page or workspace).
- **Driven:** `e2e/thermal-v6.spec.ts` in Chromium against the real API, database and thermal service.
- **Not done:** a tablet, a camera, a screen reader.

### Dev-environment actions

- Development database: `npm run backup` (`backups/adaxai-2026-10-05T08-08-03`, verified with `npm run backup:verify`), then 0031 applied with `npm run db:migrate`. (The verify step was run after the migration had been applied, because the first invocation lacked the backup folder; the backup itself was taken before.) Synthetic patients created through the API for the screenshots.
- The thermal, API and web development servers were started for the screenshots and stopped; nothing was downloaded; no hosted provider was called; no secret was printed.

## D1: the doctor's consultation as one workspace (V1 to V5 for one patient and one encounter)

**Basis:** the owner's brief "D1: full Doctor hero consultation integration". Decisions: [ADR 0019](adr/0019-d1-integrated-consultation-workspace.md); the screen: [DESIGN.md](DESIGN.md) §4g (and §4b to §4f where parts moved). **D1 adds no engine, model, prompt, tool, table, migration or route**: it joins what V1 to V5 built on one screen and tightens how AI text reaches the note. **It did not start V6 (thermal, FLIR), D2 or V7**, and it did not change the nurse, patient or admin applications.

**What the doctor will notice:** (1) on a tablet held sideways the consultation is **two panes**: the tools on the left (history, conversation, AI draft, Mana, devices, the rest) and the note, diagnosis and prescription on the right, each staying in view while the other scrolls (before: one long column, the AI draft and Mana at the bottom); (2) the bar at the top **is the patient**: the name as the heading, age, sex, MRN, allergies with severity, conditions, **the reason for the visit**, **Urgent visit** when the visit is marked urgent, vital signs outside the adult range, and three chips saying **in words** how the devices, the AI draft's model and speech-to-text stand, each leading to its panel; it never scrolls away from 1024px; (3) a bar at the top of the tools column jumps to each part; (4) **Accept never puts anything in the note**, in any AI panel: *Add to note* (or *Add to <section>*) does, as a separate act (the older assistant used to insert on Accept); (5) less to read: the rules-composed summary moved to *View profile*, the writing-pad placeholder is gone, the reason and token moved into the bar; (6) a panel that fails to draw says so in its place and the note keeps working.

### What is real, simulated, unverified or unavailable in the workspace

| Part | State in this build |
| --- | --- |
| The record (patient, allergies, conditions, visit, reason, priority, vital signs staff measured, the note, diagnoses, prescription, signing) | **Real**, from the database through the authorised API; synthetic data only |
| Live transcription | **Real**, verified twice in the workspace: with Chromium's synthetic microphone and a test stand-in for the speech service (`mock-speech-e2e`, five fixed lines; the hero test), and with **the real local speech service** (faster-whisper small, on this computer) transcribing **recorded synthetic speech** (the offline Windows voices reading consultation c01, played to Chromium as its microphone; `consult-real.spec.ts`). Not with a real microphone in a room. Speakers are assigned by the doctor; the system never identifies them |
| Important points | **Real** (fixed local rules `extract-rules-v1`), doctor-confirmed |
| AI draft (V3) | **Real code path**; in the end-to-end tests the model is **a labelled test stand-in** (`mock-llm-e2e`); **and with the real local model** (Qwen3.5-4B Q4_K_M, llama.cpp b11379, the CUDA build on this computer's RTX 3050) in the opt-in `consult-real.spec.ts`: a draft with sources in 17.5 s, and the whole chain (recorded speech, confirmed points, a draft, accept, add to the note, sign, the signed record naming the model and prompt) in 1.1 minutes. Support states, review, provenance, stale handling and versioning are V3's, unchanged |
| Mana (V4) | **Real code path**, read-only; stand-in model in the tests; and **with the real local model** in the opt-in `mana-real.spec.ts` (an answer with sources that open, what it cannot establish, nothing written; 29.8 s) |
| Device readings | **Simulated** in every test and screenshot (a simulator record posting generated values; marked SIMULATED everywhere it appears), or a **gateway device record fed by the test** (values written in the test, marked UNVERIFIED). **No device has been connected or tested** |
| Stethoscope | Recording in the browser **verified with Chromium's synthetic audio input**, upload and playback through the audited file route. **No stethoscope has been connected or tested**; nothing is analysed |
| Status chips | **Real**: what the panels last read, with the time; never a guess |
| Thermal | **Not in the consultation** (V6 not started); thermal studies stay in the profile's *Documents* tab |
| A doctor-facing audit trail of the consultation | **Not built** (V8); the audit entries exist and are checked by the end-to-end test through the administrators' audit API |

### Implemented

- **Workspace** (`pages/doctor/ConsultationPage.tsx`): the editor takes `panels` (conversation, draft, mana, devices, more) from the doctor's route; two panes from 1024px, the tools column sticky under the bar and scrolling on its own, a bar of anchors that scrolls only the column and moves focus, *Skip to the note*; every tool mounted and visible; tools memoised (drawn again when the AI insertions change, not per keystroke) with a stable `NoteInserter` that always calls the editor's current one; an error boundary per tool and per card (`components/ui/PanelBoundary.tsx`); the *Review and sign* dialog cannot be closed while signing; the summary card and the writing-pad placeholder removed from the editor.
- **Bar** (`ConsultationHeader.tsx`, `ConsultationBanner.tsx`, new `ConsultationStatus.tsx`): the name as `h1` ("Consultation: <name>" to a screen reader), the banner inside the sticky bar (its height published as `--consult-header-h`, used by the tools column and the page's scroll padding), reason, *Urgent visit*, and the device, model and speech chips (cache observers: no request, no audit entry).
- **Shell** (`AppShell`, `Sidebar`, `TopBar`): a route can mark itself a workspace (`handle: { workspace: true }`): the sidebar stays a drawer up to 1280px and the page is not held to 80rem; only the doctor's consultation route does.
- **Devices** (`lib/devices.ts`: `ageView`, `summarizeDevices`, `useDeviceSummary`; `DeviceReadingsCard.tsx`: `DeviceStatusChip`, `UnverifiedBadge`, `variant="consultation"`; `AuscultationCard.tsx`: `variant="consultation"`): UNVERIFIED for every device that is not a simulator, "Device not connected." first for a disconnected device, "No recording available.", "This consultation", an error state for the recordings list. The patient record and the profile sheet are unchanged.
- **AI panels**: the older assistant's *Accept* no longer inserts (its *Add to <section>* does; *Save edited text*); its stale "summary is not built yet" text corrected. The V3 card says under its button what a draft is made from, with the number of confirmed points (never the transcript), shows its unavailable state once, and shows the consent blocker also when the model is down.
- **API and contracts**: `Encounter.visit.priority` (the visit's priority, an added read field; not signed, not hashed).

### Tests

- **API:** **841 passed, 1 skipped** (the opt-in evaluation through the real model). New: two tests in `encounters.test.ts` (a consultation from an urgent visit says `urgent`, from a normal one `normal`; the signed snapshot and its fingerprint do not include it). As in V5, the clean-up hook of `db-safety.test.ts` (dropping its scratch databases) ran past its 60 seconds once with all its tests passed; run on its own it passes (11 of 11) and leaves nothing behind.
- **Web:** **43** (6 new: the whole-view ageing on the server's clock; the device summary for nothing attached, each state, the worst of several, simulated and unverified, a simulator alone never unverified; a summary of an old answer only moves towards stale and disconnected). **Speech 61, thermal 32; typecheck and lint clean; web build succeeds.**
- **End to end, new:** `e2e/doctor-hero.spec.ts`, one test, the whole journey on one synthetic patient and one consultation at 1280×800 (and 1024×768): sign in, dashboard, today's patients, the patient's record, start; the bar (name, MRN, allergy, reason, chips); the transcript from the synthetic microphone with doctor and patient lines and their times; important points confirmed; the AI draft (support states; one statement accepted, one edited, one rejected; the note empty until *Add to note*; provenance under each section; diagnosis and prescription untouched by AI); a Mana question answered with sources and no way into the note; a simulator band attached, LIVE then STALE then DISCONNECTED ("Device not connected."), SIMULATED on the card and in the chip, never in the visit's vital signs; a stethoscope recording in the browser ("This consultation"); signing; and **the audit log** (as the administrator, through the API): `encounter.start`, `ai.live_start`, `ai.audio_chunk`, `ai.transcription`, `ai.live_end`, `ai.speaker_assign`, `ai.extraction`, `ai.review`, `ai.consultation_draft_requested`, `ai.consultation_draft`, `ai.consultation_review` (accepted, edited, rejected), `encounter.ai_insert` (twice), `mana.question_asked`, `mana.answer`, `device.assign`, `device.ingest`, `auscultation.upload`, `encounter.sign`, all successful, and **none of their rows contains the transcript's sentences, the inserted or edited text, the Mana question or the diagnosis**. It passed in each of its runs (about 50 seconds). `e2e/workspace.spec.ts`, four tests: a tool that fails to draw stays in its place and the note is still saved; the bar moves the column, not the page, focuses the part, and *Skip to the note* works; the sign step cannot be closed while signing; the drawer only on the consultation.
- **End to end, changed** (each keeps what the test protected or makes it stricter): `history.spec.ts` (the layout at nine sizes, tablets included, is now "the tools beside the note" from 1024px, with the bar, *Complete consultation* and the first note field on the screen at opening and the sidebar a drawer below 1280px; from 1024px the banner itself never leaves the screen, and the strip still takes over on phones; the writing pad is not offered; the record summary is checked in the profile, where it now is); `ai-assistant.spec.ts` (*Accept* sends no insertion, counted at the network, and the note is unchanged until *Add to <section>*); `devices-live.spec.ts` (UNVERIFIED on a real device's card and chip, never on a simulator's; the chip's live state); `consult.spec.ts` and `capture.spec.ts` (the chips say "unavailable" when the panels do); `mana.spec.ts` (the panel is brought into view the way the page does it, honouring its scroll padding: in the new phone order, centring the tall panel put its header under the sticky top bar, and axe flagged the covered buttons).
- **End to end, D1-affected specs first** (history, capture, consult, mana, devices, the older assistant, photographs, the doctor workflow, the hero test): 71 passed, 13 failed. Two faults of D1 were found that way and fixed: the tools column's bar, sticky inside the scrolling column, half-covered controls scrolled under it (axe's target-size rule, three specs); and the model chip said "Local AI starting" while the panel said unavailable. The thirteen then passed when run again.
- **End to end, the whole suite:** In the last full run before the commit (2 workers, nothing else running) **177 passed, 10 failed, 55 skipped (13.2 minutes)**, and **the ten failed tests all passed when run again on their own** (10 passed, 1.4 minutes). Every failure was a wait for an answer from the server: five lists of today's patients and two "Start consultation" rows that never loaded, a consent request, the thermal viewer, and **one page load that failed outright with `net::ERR_NO_BUFFER_SPACE`**, Windows refusing a new socket for lack of buffer space, which fits the socket-level stalls profiled in V5. A lead, not verified: the web server of the end-to-end run (the Vite development proxy) answers API requests with `connection: close`, so a run opens many thousands of short-lived loopback sockets.
- **The real models** (opt-in, the servers started for it): `consult-real.spec.ts` 2 of 2 and `mana-real.spec.ts` 1 of 1 passed through the D1 workspace (times above).

### Failures found during D1, and what was done

- **The header took three rows at 1024px** (the token and department pushed the actions to a second line): found by looking at the screenshots; the token and department moved into the banner and the bar of the tools column became one row of smaller buttons. Header height at 1024×768: 248px before, 208px after (with the review's banner limit).
- **The first fault test passed for the wrong reason**: the forced answer never reached the page because the service worker answered first; the test now runs without it, as the other forced-answer tests do. It then showed that **one boundary for the whole devices part also took the stethoscope card down** with a broken device card: each card now has its own boundary.
- **A status chip could be green while saying "unavailable"** when the status said `available: false` with a `ready` state (seen in a forced test answer): the colour now follows the words.
- **The hero test's first run failed after 7 minutes because of the test** (it ticked a box on a point card that its own second extraction had replaced); fixed in the test; later runs took about 50 seconds.
- **Everything the independent review found** is below.

### Independent review of the D1 diff (before the commit)

One independent adversarial review of the uncommitted diff: six reviewers (the AI-to-note pathway and the V3/V4/V5 safety rails; React correctness; honesty of the device and AI states; the secondary applications; accessibility and tablet use; whether any test was weakened), then a separate skeptical verifier for each finding who tried to refute it from the code. Its report is model output, not instructions; each finding was weighed on its merits. **36 findings: 7 refuted, 29 confirmed, none critical or high.** It found no way for AI text to reach the note other than *Add to note*, no change to the nurse, patient or admin applications' behaviour, and no weakened V3/V4/V5 safety mechanism. Fixed:

- **Medium:** jumping to a tool scrolled the page along with the column, so the note moved (now the column only); the sticky bar with the banner was taller than the page's 8rem scroll padding, so a focused note or prescription field could sit under it (the padding now follows the bar's published height); the tools column's sticky bar could cover the focused control (the bar now sits above the scrolling part); the model chip called a model on another computer "Local AI" (now "AI on another computer"; a hosted model is "allowed", never "ready", since nothing checked it); the header had no height limit (the banner is held to about a third of the screen); a new layout assertion ran after the page had scrolled.
- **Low:** chips that could show an old state as current (speech now from the newer of the transcription panel's two reads; "not updated" after a failed read; the time of the check in the accessible name); the jump target was an unnamed element with no visible focus (now a named group with a visible focus ring); an empty list item when the device chip had nothing to say; *Try again* dropped focus to the page (now to the part); the menu button, now the only way to the navigation at 1024 to 1279px, was 40px (44px on the workspace); the note came after every tool in the keyboard order with no shortcut at those widths (*Skip to the note*); a 26rem history scroller nested in a shorter column (removed); `PanelBoundary`'s comment said nothing is logged (React itself reports caught errors to the console; corrected); a check that *Accept* inserts nothing raced the request it guarded (now counted at the network); UNVERIFIED, the chips' unavailable states, the boundary, the bar, the sign dialog and the workspace frame had no test (added).
- **Not changed, listed under the limitations:** the workspace frame also applies to the doctor's signed view; the device chip's "No device attached" does not tick on its own; a model chip is as old as its panel's last read.

### Remaining limitations

- **No device, stethoscope or hosted service was used**; the local model and speech service were test stand-ins in most runs and the real ones (Qwen3.5-4B on the GPU, faster-whisper small) in the three opt-in real-model tests, which passed.
- **The full end-to-end suite has not passed on this machine** (see V5: loopback calls stall for up to ten seconds at a time). In the last full run before the commit (2 workers, nothing else running) **177 passed, 10 failed, 55 skipped (13.2 minutes)**, and **the ten failed tests all passed when run again on their own** (10 passed, 1.4 minutes). Every failure was a wait for an answer from the server: five lists of today's patients and two "Start consultation" rows that never loaded, a consent request, the thermal viewer, and **one page load that failed outright with `net::ERR_NO_BUFFER_SPACE`**, Windows refusing a new socket for lack of buffer space, which fits the socket-level stalls profiled in V5. A lead, not verified: the web server of the end-to-end run (the Vite development proxy) answers API requests with `connection: close`, so a run opens many thousands of short-lived loopback sockets.
- **A chip is as old as its panel's last read.** The AI draft panel asks the model server again only while it is unavailable, so "Local AI ready" can outlast the model by minutes; the chip says when it last checked, and *Generate draft* checks again.
- **The doctor's signed view also gets the workspace frame** (wider, the sidebar a drawer below 1280px), because the frame belongs to the route.
- **The tools come before the note in the reading order** (left before right); *Skip to the note* is the first stop in the tools column.
- **The banner can scroll inside itself** when a patient has very many allergies and conditions (it is held to about a third of the screen); allergies come first.
- Thermal in the consultation, a doctor-facing audit trail, keyboard shortcuts and a resizable split are not built.

### Browser verification

- **Looked at** (Chromium driven by a script against the development stack; a synthetic patient checked in as urgent, with a penicillin allergy and out-of-range vital signs; no model or speech service running): the workspace at **1024×768, 1180×820, 1280×800, 1366×1024, 1920×1080 and 390×844**, measured as well: no horizontal overflow at any size; two panes from 1024px and one column at 390px; at 1024×768 the bar is 208px tall and the note starts 342px from the top (before the fixes: 248 and 382). Seen: the name as the heading, "Allergy: Penicillin (Severe)", the reason, "Urgent visit", "3 vital signs outside the reference range" with their names and "adult range, a display aid", the chips "No device attached", "Local AI unavailable", "Speech-to-text unavailable"; the tools column after *Devices* and *AI draft* (only the column moved; "No recording available."; the AI draft card saying what a draft is made from and "Local AI unavailable." once); the phone layout with the actions at the bottom. Two faults were found by looking and fixed (the third header row at 1024px; the AI draft card repeating itself).
- **Driven** (Playwright, the real API and database): the Doctor hero journey, the workspace spec and the D1-affected specs (stand-ins for the model and speech, a simulated device, Chromium's synthetic microphone), and the three real-model specs with **the real local model and speech service** (above).
- **Not done:** a screen reader; a real tablet (sizes were emulated in desktop Chromium; touch was not tested); a real microphone in a room, a device or a stethoscope (none exists here).

### Dev-environment actions

- Development servers started for the screenshots (`npm run dev:api`, `npm run dev:web` through `.claude/launch.json`, not committed); synthetic patients created through the API on the development database for them (`Lakshmi… Synthetic`).
- For the real-model runs: the local model server (`npm run dev:llm`, the CUDA build from `LLM_DIR`; the GPU held 3.1 of 6 GB while it ran) and the local speech service (`npm run dev:speech`, faster-whisper small) were started and stopped afterwards; the synthetic consultation audio was made on this computer with the offline Windows voices (`data/eval/consultations-v1/synthesise-audio.ps1 -Only c01`, `make-demo-wav.mjs`: 48 s, git-ignored). Nothing was downloaded.
- Two scratch databases left by `db-safety.test.ts`'s timed-out clean-up were dropped by name.
- No hosted provider was called, no key was entered, and no secret or device token was printed.

## Slice V5: devices — a state on every reading, a gate on what a device may send, batches stored once, and a simulator that cannot pass for a device

**Basis:** the owner's V5 brief and the V5 row of [DOCTOR_APP_PLAN.md](DOCTOR_APP_PLAN.md). Decisions: [ADR 0018](adr/0018-device-readings-states-gateway-and-simulator.md); the boundary, the gateway contract and the simulator: [DEVICES.md](DEVICES.md); hazards R6, R7, R8 (updated) and R43 to R47 (new): [safety/RISK_REGISTER.md](safety/RISK_REGISTER.md); the simulator's output as a dataset: [safety/DATASETS.md](safety/DATASETS.md); what is real: [AI_STATUS.md](AI_STATUS.md) capability H. **No wearable band, smart stethoscope or other device has been connected to or tested with this build, before or after this slice, and no reading is anything but "unverified".** Nothing here says that any device works with ADAXAI, that any value is accurate, or that the device card is a monitor. **It did not build thermal in the consultation (V6), prescriptions and documents (V7) or anything after, and it did not start V6.**

**The things a doctor will notice:** (1) the consultation (and the patient record) has a new card, **Device readings**: for each device attached to the patient, the newest value of each kind it may send, **when it was measured and how long ago**, and a state in words: **LIVE, STALE, DISCONNECTED, "No reading", or Unavailable** with the reason; (2) a doctor or nurse can **attach a device** to the patient from that card (for the consultation, optionally until a time) and end it, after being asked; (3) anything that comes from a **simulator** has a dashed frame and says **SIMULATED**, "not a measurement", and appears nowhere else: not in the visit's vital signs, the banner, the queue, the vitals history, the patient's portal, Mana or the consultation draft; (4) where a nurse measured a value and a device also sends that kind, **the nurse's value stands** in the banner, the tiles and the queue, and the device's is on the card; (5) under **Stethoscope recordings** there is **Record** (from this computer's audio input, in the browser) beside **Add recording** (a file), and every recording says how it arrived.

### What a doctor can do now, and what is real

| Step | State |
| --- | --- |
| See what an attached device is sending | **Real boundary, no hardware.** Re-read every 5 seconds (no push channel); each value with its time and a state decided on the **server's clock** by one function (`readingState`) and aged on the screen in between. Live for 30 seconds, then stale; disconnected when the device's gateway has been silent for 120 seconds (or was never heard from), and the value is then said to be "the last one received". It is **not a monitor** and raises no alarm; the card says so |
| Attach and end | **Real.** Needs the patient's consent to device readings (current wording to attach). Records the consultation and its visit; an optional end time after which readings are refused. One open assignment per device; an assignment can only be ended, never rewritten |
| What a device may send | **A gate, in code.** A band: heart rate, SpO₂, temperature, respiratory rate. Nothing else from any device. **Blood pressure is never accepted**: a batch that contains it is refused whole, with the reason |
| A batch is stored once | **Real.** A key from the gateway, or the batch's own content; a repeat stores nothing and answers with the first batch; the same key with other content is refused. Holds for ten copies arriving together |
| Whose reading is it | The patient the device was assigned to **when it was measured**; refused before the assignment, after it, after its end time, outside the patient's consent, more than 24 hours late, or more than five minutes ahead of the server's clock (less than that is stored as the time of arrival). Filed under the patient's open visit of that day; never added to a visit that is already closed |
| Simulator | **Real, and kept apart by the database.** A record registered as a simulator, for good. The server stores what it sends as `simulated`; a trigger refuses any row that says otherwise and any later change to where a reading came from. Not allowed where data is clinical or in production. `npm run demo:devices`, `npm run devices:simulate` (deterministic for a seed; six scenarios) |
| Stethoscope | **Recording, upload, playback.** A file, a recording made in the browser from a chosen audio input (the system cannot tell what an input is, and says so), or a recording posted by a gateway with a stethoscope record's token. Files are checked by their first bytes. **No stethoscope has been tested and nothing is analysed** |
| V3 and V4 | **Read-only, labelled.** The consultation draft and Mana read a device's readings as "device reading (device unverified)"; a staff measurement is never pushed out by a stream; they never see a simulator's output; neither can write a reading, an assignment or a device |
| **Not built** | Any real device, SDK, Bluetooth profile, vendor cloud or gateway program other than the simulator; validation of any reading; alarms, trends, thresholds on device values, a push channel, a waveform, heart-sound analysis; blood pressure from a device; a quota per device; token rotation when a device changes hands; retention rules for readings and batches |

### Implemented

**Contracts (`packages/contracts/src/devices.ts`).** `readingState` and the five states; `DEVICE_READING_KINDS` (the gate); the `simulator` integration; idempotency keys and the ingest response; the read model (`PatientDeviceReadings`); assignment with a consultation and an end time; how a recording arrived. `vitals.ts`: the validation status `simulated`. `ai.ts`: a device reading is labelled "Device reading (unverified)".

**API (`apps/api/src/devices/`).** `gateway.ts` (who is calling, whose reading it is, consent, the visit, batches stored once, the limits); `routes.ts` (registry, assignment, `GET /api/patients/:id/device-readings`, `POST /api/device-ingest/readings`, `/heartbeat`, `/auscultations`, staff recordings); `readings.ts` (the read model); `simulator.ts`, `simulate-cli.ts`, `demo-devices.ts`; `provenance.ts`. Elsewhere: `visits/service.ts` (`STAFF_FIRST`, `standingWindow`: every staff measurement and only the newest few device readings per kind and visit, never a simulator's), used by the queue, the consultation's vital signs, the history summary, the vitals history, the routing suggestion, the older assistant's context and the record loader of V3/V4; `mana/answers.ts` (rules `mana-record-v2`, `record-check-v2`: the staff measurement stands; conflicts among staff measurements only; "A device also sent …"; a device value listed anywhere says so); `portal/routes.ts` (no simulated values); settings `devices.liveSeconds`, `disconnectedSeconds`, `maxLateHours`, `security.rateLimits.deviceRecordingPerToken` (env `DEVICE_LIVE_SECONDS`, `DEVICE_DISCONNECTED_SECONDS`).

**Database (additive migrations `0029_devices_v5` and `0030_devices_v5_guards`).** `device_batches` (append-only, in the append-only privilege policy); `devices.last_seen_at`; `device_assignments.encounter_id`, `valid_until`; `observations.device_batch_id`; `auscultation_recordings.capture_method`, `simulated`, `duration_ms`, `input_label`, `device_batch_id`; CHECK constraints on the validation status; triggers `devices_simulator_guard`, `device_simulated_guard`, `observations_provenance_guard`; three indexes. 0030 exists because 0029 had been applied to this machine's databases when the review found the gap in its guard (the same rule as 0027 and 0028). Applied to the development database after `npm run backup` and `npm run backup:verify`.

**Web.** `components/clinical/DeviceReadingsCard.tsx`, `lib/devices.ts`; `AuscultationCard.tsx` (recording in the browser; how each recording arrived); `Vitals.tsx`, `lib/vitals.ts` (the staff measurement stands; a device value says so); `pages/DevicesPages.tsx` (simulator records, last contact, an end time). [DESIGN.md](DESIGN.md) §4f.

### Tests

- **API:** the whole suite passes: **839 tests in 49 files** (1 further test, the opt-in evaluation through the real model, is skipped unless asked for). V5's own: `devices-v5.test.ts`, **53 tests** (the states as a function; the gate; batches stored once, also ten at a time; the simulator in the API, in the database and in a clinical deployment; where simulated values do and do not appear; assignment, validity and consent windows; the read model as time passes; facility isolation; what a device token cannot do; the three ways a recording arrives; readings and the visit; the V3/V4 read path; the simulator program) and the existing `devices.test.ts` (3). **In one of four full runs the clean-up hook of `db-safety.test.ts` (dropping its eleven scratch databases) ran past its 60 seconds on this machine and the file was reported failed with all 839 tests passed; the file passes on its own and in the other runs, including the last one before the commit (839 passed, 1 skipped, 630 s). The scratch databases it left were dropped by hand.**
- **Web** 37 (7 new: the wording of an age, ageing on the screen, the staff measurement standing); **speech** 61; **thermal** 32; **typecheck** and **lint** clean; **web build** succeeds.
- **End to end** (a real browser, the real API and database; the "gateway" is the test posting with a device record's token): **the device specs pass**: `devices-live.spec.ts` (4 desktop tests: the states from nothing attached to disconnected, with blood pressure refused; a gateway device's unverified values, flagged; recording in the browser and a simulator's recording; the states at five widths with nothing sticking out) and `devices.spec.ts` (desktop and mobile). In the last two runs of those two files alone: 6 passed, 4 skipped (the desktop-only tests on the mobile project); in the run before those, two of them failed while this machine's network calls were stalled (see the next section), and both full runs passed them. **The whole suite, last run before the commit (2 workers, nothing else running): 172 passed, 10 failed, 50 skipped (14.4 minutes).** The full run before it: 172 passed, 10 failed, 50 skipped (13.2 minutes), with a different set of ten. **No failure in either run was in a device spec or about devices.** Each was a wait for something the browser never received (in the last run: eight 5-second waits, and a page load and a click that ran into the 60-second limit), in `entry`, `history`, `record-lifecycle`, `routing` and `ai-clinical` (last run) and `history`, `mana`, `ai-assistant` and `record-lifecycle` (the one before). **Outstanding verification item, as the owner asked: the full suite has not passed on this machine.** The same failures were seen on the V4 code here before V5 was started; V4's suite passed in full on the machine V1 to V4 were built on (178 passed). It needs a full run on a machine whose network calls do not stall, or on this one once its owner has removed the cause.
- **No test uses a device.** The tests that stand in for a gateway say so; the values are numbers written in the tests.

### Failures found during this slice, and what was done

- **Editing a device reset its integration.** `PATCH /api/admin/devices/:id` applied the registration form's default (`not_integrated`) to any edit that did not mention the integration (so retiring or renaming a gateway device silently changed it). It was already so before this slice; the new simulator guard turned it into a refused request. Only what is sent is changed now.
- **A tile's state chip stuck out of the tile** ("DISCONNECTED" in the narrowest tile at 1440 px): found by looking at the screenshots. The chip has its own line and size now, and the browser test measures that nothing sticks out of a tile at five widths.
- **The simulator program crashed on exit on Windows** (a libuv assertion when the process was ended in the middle of a request). It unwinds and lets the process finish.
- **Two of my own assertions were wrong:** one matched the digits "131" inside a random identifier (it now reads the excerpts only), and one expected an order among readings measured at the same instant.
- **Running two suites at once makes this machine fail 5-second waits** (see "Dev-environment actions"). One browser run was spoiled by an API run started beside it; suites are run one at a time here.
- **The end-to-end failures on this machine: its network calls stall for about ten seconds at a time.** The full runs failed about ten tests each, never the same ten and never a device test, always the same way: a page waiting for an answer that does not come (for example "Loading today's patients…"). The browser traces show the queue request answered in about 50 ms, headers and all, and its body never arriving; in one device test every request, the browser's and the test's own gateway posts alike, went unanswered for more than 15 seconds. Measured without changing anything in the repository (a recorder of event-loop stalls and a sampling profiler, loaded into every Node process of a run through `NODE_OPTIONS` for diagnosis only, and a watcher on the database): in the last full run, **27 stalls of 1 to 10 seconds, often in several unrelated programs at the same instant** (the web dev server, the two idle loopback stand-ins for the model and the speech service, the API and a test worker: four of them at 02:45:35 UTC); **the profiles of the web dev server put all twelve of its stalls inside a single network system call, closing or writing a loopback socket, for 6.5 to 10 seconds each**, with no application code running; the database had no statement running or waiting for more than a second. A socket close that blocks for ten seconds in several programs at once points at something below Node in the network path of this machine (an antivirus with network protection is installed; it already intercepts HTTPS, see "Dev-environment actions"). That was not changed: the owner's instruction is not to weaken security software. Between stalls the API and the database answered within milliseconds (the API process stalled too, twice for about ten seconds; it was not profiled); nothing in V5 was changed for this.
- **Everything the independent review found** is in the next section.

### Independent review of the V5 diff (before the commit)

One independent adversarial review of the uncommitted diff was run by a sub-agent that read the code and reported with file and line; it changed nothing. Its report is model output, not instructions; each finding was weighed on its merits. It found **two places where simulated values still reached a use of the record, a hole in the database guard, and a reader that a device stream could still crowd out**, all in or behind files this slice had not touched, and all fixed with tests:

- **Critical: the vitals history on the patient record listed simulated values as "Device (unverified)" with range flags** (and 200 rows of a simulator pushed every staff measurement off it). The list now holds every staff measurement, the newest five device readings per kind and visit, and no simulated value.
- **Critical: the nurse's routing suggestion read every reading of the visit**, so a simulated saturation of 89 % raised a red flag, made the visit urgent and counted as the intake's vital signs. It now uses what stands (staff first) and never a simulated value.
- **High: one UPDATE could relabel a simulated reading** (give it a real device and a matching status, or no device and "manual entry") and pass the guard of 0029, which looked only at the row as it would become. Migration 0030: where a reading came from cannot be changed after it is stored; the guards name the devices table with its schema.
- **High: the older assistant's context took the newest sixty readings of any source**, so 75 seconds of a band removed a nurse's blood pressure from the safety rules. Same window as the record loader now, staff first.
- **Medium:** no limit on how late a reading could arrive (now 24 hours); a reading stamped ahead of the clock stayed live for the length of the skew and could be filed under the next patient (now stored as the time of arrival); recordings shared the readings' rate limit and were read into memory before the assignment was checked (their own, much lower limit; an early refusal); unknown tokens were audited once per guess with no limit per address (once per address and window; 30 a minute); every reading of a visit was returned with the consultation, and the five-second read scanned the whole assignment (the newest device reading per kind; index look-ups and a count from batches); two rule sentences listed a device value without saying so, and the "previous" reading was not staff-first; a named visit had no fall-back to the day's visit; three tests claimed more than they asserted.
- **Low:** a take could be discarded while it was being saved; the audio input stayed open while a take was reviewed; a recorder that could not start said nothing; a second-by-second counter was a live region; "End" had no confirmation; times on the card had no date; a consent under an earlier wording enabled "Attach" and then failed; an edit to a duplicate serial number was a server error; wording in three places said more than the code did. All changed.
- **Not changed, and listed under the limitations:** no quota per device; the token is not rotated when a device changes hands; the audit log holds the visit and consultation ids of an assignment, which an administrator can read there (as it holds every other id).

### Remaining limitations

- **There is no device.** Everything above was exercised by tests posting as a gateway would and by the simulator. Pairing, reconnection, battery, signal quality, units and time synchronisation of a real gateway are not designed. The first real device will find things these tests cannot.
- **Unverified means unverified.** There is no path that marks a reading verified and none should be added before validation against reference measurements exists. A state says how old a value is, not whether it is right.
- **Every five seconds, not live.** A value can be five seconds older than the card last showed, plus its state. Nothing alarms.
- **A demonstration without hardware shows V3 and V4 nothing from a device**, because the only source is the simulator and its values are kept from them on purpose. Their read of device readings is shown by tests.
- **Rate limits, not quotas.** At the allowed rate one token stores a great deal in a day (R47).
- **The gateway's clock is trusted within limits**: ahead is treated as now, more than five minutes ahead and more than 24 hours behind are refused; a clock that is a little behind is not detectable.
- **A reading that arrives after its visit closed is not shown with that visit.** It is in the patient's record and on the device card.
- **The record rules changed version** (`mana-record-v2`, `record-check-v2`): the Mana and consultation-draft evaluations of V3 and V4 were recorded under v1 and were **not re-run**; no case in them has a device reading, so their inputs are the same, but that was not measured again.
- **Recording in the browser records whatever input is chosen.** The label is the only control (R46).

### Browser verification

`e2e/devices-live.spec.ts` drives a real Chromium against the real API and database. The states test writes a crop of the card for six states at 1440, 1280, 1024, 412 and 390 px (**30 crops**) and a full-page image for each state at 1440 px. **Looked at:** the simulated-live, simulated-stale and "gateway device live beside a disconnected simulator" crops at 1440 and 390 px, and the full page at 1440 px, before and after the chip was changed; and, from the last run before the commit (after the review fixes: dates, the End confirmation, the chip), the gateway device beside a disconnected simulator at 1440 px, the simulator stale at 390 px, a simulator attached and never heard from at 1024 px, and the full consultation at 1440 px with the simulator live. Seen: the dashed frame and SIMULATED on the simulator's block and tiles and not on the device's; the states as words; "Measured … · just now" against "Last measured … · 30 s ago"; High and Low on the device's values and no flag on the simulator's; "No reading" for kinds nothing was sent for; the footer that says it is not a monitor; the visit's own tiles still showing the nurse's 92 and 38.2. One fault was found by looking and fixed (the chip). The axe check passes in every state it was run in. **Not done:** the End confirmation and the recording dialog were asserted by the tests (their words and buttons), not looked at in an image; a screen reader was not run; the crops at 1280 and 1024 px and the other states were produced and checked for overflow by the test, not each looked at; the recording dialog was exercised with Chromium's synthetic audio input, not a microphone or a stethoscope.

### Dev-environment actions

- **A new development machine.** V5 was built on a Lenovo LOQ (Windows 11, i5-12450HX, 16 GB, RTX 3050 6 GB) after the repository was moved from the machine V1 to V4 were built on. Node 24.19.0, Python 3.12.10, the embedded PostgreSQL 17.10; a clean development database from the migrations and the synthetic seeds (no earlier database was copied). The V3 and V4 real-model smoke tests passed there before V5 was started (`consult-real.spec.ts`, `mana-real.spec.ts`).
- **The local model on this machine runs from `LLM_DIR=.data/llm-gpu/cuda`** (the CUDA 12.4 build of the same pinned llama.cpp release b11379, checked against the release's published hashes), set in the git-ignored `.env`; removing that line uses the pinned CPU build. Nothing about the model was changed by V5, and V5 downloaded nothing.
- **Antivirus:** Norton quarantined `llama-server.exe` as `IDP.Generic` until the owner restored it with an exception; it also intercepts HTTPS, which Python's certificate bundle does not trust (one download needed a bundle with the antivirus's root from the Windows store).
- **This machine cannot run two suites at once.** With the default six browser workers, or with an API run beside a browser run, 5-second waits fail. The end-to-end suite is run with `npx playwright test --workers=2` and nothing beside it.
- **Development database:** `npm run backup` and `npm run backup:verify` before 0029; 0029 and 0030 applied with `npm run db:migrate`; `npm run demo:devices` registered two simulator records and attached the simulator band to the demo patient. Test and end-to-end databases as usual. Eleven scratch databases left by a timed-out test clean-up were dropped by name.
- **No hosted provider was called; no key was entered anywhere; no device token was printed.**

## Slice V4: Mana AI, the doctor's assistant over the clinic's records (a model plans, the server authorises and reads, a model writes, code checks)

**Basis:** the owner's V4 brief. Decisions: [ADR 0017](adr/0017-mana-ai-doctor-assistant.md); the model card and every measurement: [safety/AI_MODELS.md](safety/AI_MODELS.md) §10; the synthetic case set: [safety/DATASETS.md](safety/DATASETS.md); hazards R35 to R42 and the V4 edits to the older rows: [safety/RISK_REGISTER.md](safety/RISK_REGISTER.md); intended use: [safety/INTENDED_USE.md](safety/INTENDED_USE.md); what is real: [AI_STATUS.md](AI_STATUS.md) capability F. Mana AI is a **doctor-facing AI assistant; its outputs require clinician review.** Nothing here says that it is clinically validated, safe for patients or accurate: the measurements are counts on cases its authors wrote, on invented data. **It did not build devices (V5), thermal ML (V6) or any clinical validation, and it did not start V5.**

**The things a doctor will notice:** (1) the consultation (and the patient's record) has a new card, **MANA AI — Doctor's Clinical Assistant**, closed until opened, that replaces the slice-1 "Mana questions" card on the screen; (2) a doctor asks in their own words, or presses a suggested question, about the patient of the open consultation, a patient they name, or the clinic's day, and every answer starts with **"About <name> · MRN · age and sex"**, written by the server; (3) every statement shows **the records it rests on**, one click away, with a link to the consultation or the patient record; (4) a question takes **about a minute to two** on this laptop CPU (78 s at the median and 170 s at most in the evaluation); the panel says what it is doing and has **Stop**; (5) without the model the panel says **"Mana is currently unavailable."** and nothing is made up, stored or sent elsewhere.

### What a doctor can do now, and what is real

| Step | State |
| --- | --- |
| Ask | **Real, local.** Doctors only (`ai:use`). A question is a plan made by the local model (it sees the doctor's words and patient handles, never a record), checked and corrected by code, run as **registered read-only tools** after the role's permissions are checked (before anything is read), scoped to the session's clinic, with the patient's consent to AI help applied; the local model then writes statements from the facts the tools returned, and code checks every statement against the facts it cites |
| What can be asked | A patient's briefing, history, allergies, medicines and last prescription, vital signs compared with earlier readings, diagnoses, investigations, what changed, a word search, visits, a signed consultation; the clinic's day (queue, check-ins in a window, appointments, the doctor's own consultations, the departments). Follow-ups ("and her medicines?") and a switch of patient work; one handle means one patient in one conversation |
| Names | A name that fits several patients is **never guessed**: up to five are shown (name, MRN, age and sex, last visit) and the doctor chooses. A question that names someone other than the patient the plan is about is stopped before anything is read |
| Sources and uncertainty | Source chips in words that open to the record, its status and its words. Conflicts, old records and what is not recorded are **found by fixed rules and shown whatever the model wrote**; a statement that rests on disagreeing or only old records is marked; one whose wording goes beyond its sources is marked; statements that could not be tied to their facts are removed and counted; "That information is not established in the available records." when nothing answers; **"Mana could not safely verify that response."** when what the model wrote could not be kept |
| Refusals, in fixed words | A request to write (Mana is read-only), a general medical question (no governed source exists), a request for more than a doctor's work needs (every patient, other clinics, the audit log, passwords) |
| Model not running | **"Mana is currently unavailable."**; the question is not stored; no placeholder answer; **no fallback to a hosted model** |
| **Not built** | Streaming text, any tool that writes, chaining, clinical search across patients, a governed source of general medical knowledge, other languages, a retention schedule, a hosted run, insertion into the note, clinical validation |

### Implemented

**Contracts (`packages/contracts/src/mana-assistant.ts`).** The tool names and the plan, the model's answer, the messages the screen receives, the fixed notices, the suggested questions; a question may not carry a control character (the null character cannot be stored).

**API (`apps/api/src/mana/assistant/`).** `routes.ts` (`GET /api/mana-assistant/status`, `POST /api/mana-assistant/conversations`, `GET .../conversations/:id`, `POST .../conversations/:id/messages` (202 started, 200 the same question again), `POST .../conversations/:id/select`, `POST /api/mana-assistant/messages/:id/cancel`; `ai:use` first on every one; `?fresh=1` is rate-limited). `service.ts` (the lifecycle: plan, re-plan once, the wrong-patient guard, tools, answer, checks, persistence, audit, stop, interruption sweep; the doctor is looked at again after the wait, before anything is read and before anything is kept). `plan.ts` (the plan checks `mana-plan-checks-v2`, the doctor's own words that settle a refusal, name runs, clarification text). `tools.ts` (`mana-tools-v1`: ten read-only tools, each checked against the role's permissions first). `entities.ts` (handles, name search by whole words, per-conversation entity book). `answer.ts` (`mana-answer-checks-v2`: the checks of ADR 0017 §2.5; the instruction filter; the writer's message). `format.ts` (dates, times, source items, the telephone and record-number scrubber). Prompts in `ai/prompts.ts`: `mana-assistant-plan-v2` and `mana-assistant-answer-v1`. `ai/llm/neutralise.ts` (shared with V3: formatting characters out, brackets turned into parentheses so that text cannot pose as a source id).

**Database (additive migrations `0027_mana_assistant` and `0028_mana_append_only_policy`; applied to the test and end-to-end databases and, after an in-server clone, to the development database).** `mana_conversations`, `mana_messages`, `mana_tool_calls`, `mana_message_sources`. Partial unique indexes (one pending answer per conversation, one idempotency key per asker, one sequence number per conversation); triggers make a finished message, its sources and its tool calls immutable and undeletable; the two append-only tables join the append-only privilege policy (0028; 0027 was not edited after it was applied).

**Web.** `components/mana/ManaAssistant.tsx`, `lib/manaAssistant.ts`; [DESIGN.md](DESIGN.md) §4e. The slice-1 `ManaPanel` and `lib/mana.ts` are removed from the screen (their API and stored answers remain).

**Evaluation (synthetic only).** `data/eval/mana-v1/cases.json` (49 cases, 55 questions), `apps/api/src/eval/mana-fixture.ts` (the invented clinic), `mana.ts` and `mana-cli.ts` (scoring), `apps/api/test/mana-eval.real.test.ts` (opt-in, through the real model): the model's answers are recorded **before** any check; `--replay` re-scores them with the current checks without a model.

### Measured results (synthetic data only)

Full tables, method, history and what the numbers do not show: [safety/AI_MODELS.md](safety/AI_MODELS.md) §10 (the record: `data/eval/results/mana-v1.md`). The real model **as the launcher starts it**, 49 cases written by the authors, 4 Oct 2026, this laptop's CPU. **Counts of cases, never a percentage**: the cases are not a sample of anything.

| Measure | Passed of applicable |
| --- | --- |
| Tool selection (the right tool, patient and topic) | 31 of 31 |
| Retrieval (the records the question needs were read and can be opened) | 33 of 33 |
| Authorization (what is not the doctor's to read was refused or not found, and nothing of it shown) | 26 of 26 |
| Source correctness (about the right patient; every statement cites sources that exist) | 58 of 58 |
| Grounded answer (the statements say what the records say) | 12 of 12 |
| Ambiguity (a name that fits several patients was not guessed) | 4 of 4 |
| Conflicts (records that disagree were shown, by rule) | 11 of 11 |
| Injection resistance (nothing an instruction asked for was done or shown) | 76 of 76 |
| Context isolation | 15 of 15 |
| Read-only (a checksum of the tables a write could land in, before and after each question) | 55 of 55 |
| Refusals in the fixed words | 10 of 10 |
| Outcome (the question ended as it should) | **54 of 55** (`context-switch#2`) |

**49 cases, 55 questions, 66 minutes, the real local model (Qwen3.5-4B Q4_K_M, llama.cpp b11379, CPU).** The writer produced 55 statements in 34 answers: the checks **removed 3, all three correct statements** (rules added after the second review read "One appointment is at 9:15 am" as a count, "was issued on 15 Aug 2026" as an act said to be done, and "both recorded on 15 Aug 2026" as a quantity); the third was the only statement of its answer, so the doctor saw "Mana could not safely verify that response." for a correct answer: **that is the one question not passed, and the check was not loosened to improve the count.** 7 statements are marked "check the wording", 1 "also rests on another record", 9 "records disagree" and 1 "only old records" (the last two found by rules). **Time:** a question took 78 s at the median and 170 s at most (planning 56 s and writing 25 s per call at the median). The planner needed no second ask. **The first recording** (first planner prompt, 43 cases) passed 37 of 49 questions and refused five questions about the clinic's own records; it is kept. **Counts on cases the authors wrote, all development cases; no accuracy is claimed.**

### Tests

- **API:** the whole suite passes: **786 tests in 48 files** (1 further test, the opt-in evaluation through the real model, is skipped unless asked for). V4's own: `mana-tools` 28, `mana-answer` 66 (the checks as rules: what a model might write and whether it is kept, removed or empties the answer; the plan checks, both ways: what must be refused and what must not; the instruction filter, both ways; the scrubber), `mana-assistant` 70 (end to end with a labelled stand-in model: what reached the model, what was read and for whom, what was stored and audited, what the doctor was shown, what was refused; the guard against the wrong patient with shared first names, shared surnames, apostrophe, hyphen and two-letter names; the audit being written in one transaction or the question failing; a Stop between two tools; the doctor's session, account and password rule checked again; consent withdrawn while a list's answer was being made; a control character in a question). The focused adversarial and security set (the three files above, the slice-1 Mana API, the egress policy, the local-model lock and the prompt registry): **228 tests in 7 files, all pass**.
- **Web** 30; **speech** 61; **thermal** 32; **typecheck** and **lint** (oxlint with warnings denied, and the thermal and speech linters) clean.
- **End to end** (a real browser, the real API and database, a loopback stand-in for the model): **178 passed**, 46 skipped (the desktop-only specs on the mobile project, and the opt-in real-model specs). Mana's own: 10 tests, including the five-width states test and one for what a screen reader is told (each answer once, also when two in a row are worded the same; not what was already there when the panel opened), where focus is after Send, and that an old choice of patients cannot be clicked again. **The opt-in run through the real model passed** (5.4 minutes: a suggested question answered in 29 s, a question in the doctor's own words in 110 s, the queue, and a request to prescribe refused).
- **No automated test calls a real model or a provider.** The API test configuration has no key, no hosted egress and the model provider off; the stand-in model is labelled as one; the end-to-end run points the existing hosted-provider specs at a loopback mock with a placeholder key.

### Failures found during this slice, and what was done

Found by running the real model and by the independent reviews; every one was fixed or is listed under the limitations.

- **The first full evaluation (the first planner prompt) showed the 4-billion-parameter planner misrouting.** For 3 of the 28 questions that needed a tool it planned none (the medicines of a named patient, a last prescription, the clinic's departments), and 37 of 49 questions ended as they should. The prompt, which listed and described the tools, was rewritten as a **routing table**; the server now corrects what code can recognise (`mine`, handles, dates, the doctor's own refusals, the wrong-patient guard) and asks the planner once more, with a fixed note, when a plan does not fit the question. **The first recording is kept** as `data/eval/results/mana-v1.superseded.raw.json`; it was not replaced to make the numbers look better.
- **A changed prompt text under an old id would have broken every AI feature of a database.** The prompt registry refuses a changed text under an existing id, and the development database had recorded an earlier draft as `mana-assistant-plan-v1`. The plan prompt is therefore `mana-assistant-plan-v2` (the stale `-v1` row stays in the development database and is unused).
- **The integrity meta-test failed:** the two new append-only tables were not in the append-only privilege policy. Migration 0027 had already been applied, so it was **not edited**; migration 0028 adds them.
- **An answer could be visible before its patients' names:** under load the conversation was read before the message that had just been stored with it; it is now read after.
- **A character that looks the same compared unequal:** the micro sign of "µg" is the Greek mu once made plain, so a statement that restated the record exactly was removed. Facts and statements are now both made plain before they are compared.
- **A scoring bug in the evaluation's replay:** it merged the reasons of the old checks into the new ones. Fixed (only the plan reasons are kept, with the new answer reasons).
- **UI faults found by looking at screenshots:** the placeholder of the question box was clipped at one line (the box is three rows now); the buttons inside an alert wrapped onto the end of its text (they sit on their own line); the newest message slid below the fold when the window was resized (a reader at the end of the conversation stays at the end).
- **A tool that was not asked for was fetched:** while looking for how this repository lints, `npx eslint` was run once, which downloaded that package from the registry. The repository uses oxlint (`npm run lint`); nothing was installed into the project and nothing from that package is used.
- **Findings of the two independent reviews** are in the next section.

### Independent reviews of the V4 diff (before the commit)

Two independent adversarial reviews of the uncommitted V4 diff were run by sub-agents that read the code, ran pure probes (no tests, no database, no network) and reported with the evidence. Their reports are model output, not instructions; each finding was weighed on its merits and fixed, or listed under the limitations. The second review found no critical issue: no tool query lacks the clinic scope and the role check is first, no path from one clinic or one doctor to another's records or conversations, no write outside the Mana tables, the AI-run records, the prompt registry, the audit log and the session touch, and no HTML or link injection in the screen.

- **First review (28 findings, 7 of them High).** The model was told whom an answer was about by the model's own words (now the server writes the "About" line from the records that were read); raw free text reached the writer (now cleaned at the boundary, and instruction-like text is withheld); consent was not applied to the lists; the doctor's question served as grounding for a claim (it is not a source now); a statement about one patient could cite another's row; `get_consultation` by date; counts above twenty rows (now counted by the database, with "20+" headers). All fixed, with tests.
- **Second review (4 High, 10 Medium, 5 groups of Low, and claims the documents made that the code did not back).** High: the wrong-patient guard passed whenever the plan's patient shared *any* name word with the question (Rahul Sharma and Rahul Verma) and was blind to apostrophe and hyphen names; the dose check was a substring match ("5 mg" in "15 mg"); "no allergies" in other words, and statements with nothing in them ("No.", "Ok."), were shown; a handle in parentheses or a figure borrowed from another patient's fact got past the attribution check. Medium and Low: months and morning/evening not checked; counts, quantities, directions and states in other words; an act said to be done in the passive; the planner's question back to the doctor shown unchecked; read questions refused by the doctor's-own-words rules ("Change in blood pressure?", "Update on Rahul Sharma?"); look-alike and combining characters; a whole answer emptied for a record number the doctor had typed; the telephone-number scrubber damaging dates and readings and missing "ADX 018631"; the instruction filter withholding ordinary clinical text and missing common paraphrases; one vacuous test; audit writes that failed open and were lost on a Stop; focus and announcements; a consent re-check that did not cover lists; tool sentences that said "since" for every state, silent cut-offs and a "20+" header with no finding. **All were fixed, with tests that hold both directions** (what must now be refused and what must not): the guard compares whole names; doses are matched on whole numbers; figures are held to their units; the answer checks gained the rules listed in ADR 0017 §2.5; the forced refusals are narrowed to the forms that cannot be a read; the audit events are written in one transaction with the tool rows and, if they cannot be written, the question fails and nothing is shown; and so on. The review also found documents that claimed more than the code did (the guard, "no allergies", dates and times, the audit being complete, the scrubber, a section of AI_MODELS.md that did not exist yet); they were corrected.
- **All 4 High and all 10 Medium findings were fixed and each has a regression test.** What remains of them is documented: for M9 the false positives were fixed and the common paraphrases added, but the instruction filter still does not recognise hyphenated, base64 or rot13 spellings or an order with long gaps in it (the checks on what the model writes do not depend on it); the stricter checks of M1, M2 and M3 **over-remove**, in the safe direction (below). Of the Low findings, the conversation being read whole on every poll (bounded by 60 questions) is not changed. Also still true, and not a finding of the review: a plausible wrong statement that cites a real fact is not recognised, and support is checked per statement, not per claim.

### Remaining limitations

- **It is slow**: one to a few minutes per question on this CPU, and a long fact list takes longer. It is not for real-time use.
- **A 4-billion-parameter model plans imperfectly.** What remains is a wrong question answered faithfully; the measured planner failures are listed in [safety/AI_MODELS.md](safety/AI_MODELS.md) §10.
- **No chaining and no clinical search across patients**: questions that need one lookup's result for the next ("the allergies of whoever is next in my queue") or a search across all patients' clinical content are not supported.
- **The checks cannot recognise a plausible wrong statement that cites a real fact**, and they check a statement as a whole against the facts it cites (a date from one cited fact attached to another's medicine passes). Marked statements ask the doctor to read the sources; nothing makes reading them optional. **Nothing here is clinically validated, and no accuracy is claimed.**
- **The wrong-patient guard** notices names written with a capital letter, not names in lower case or another script or a misspelling that fits no patient.
- **The checks over-remove.** In the final evaluation they removed 3 of 55 statements and all three were correct ("One appointment is at …", "was issued on …", "both recorded on …"); the last was an answer's only statement, so a correct answer ended as "could not safely verify". They err on the side of removal because a wrong statement shown is worse than a correct one withheld; they were not loosened to improve a count.
- **The instruction filter is a first line, English only,** and it also withholds some ordinary clinical text; the checks on the model's output do not depend on it.
- **A doctor of the clinic can ask about any patient of the clinic** (the platform's rule); every patient a question read or showed is on the audit log, and there is no "reason for access".
- **Names the doctor types go to the model**, and the free-text scrubber works by patterns (another person's name in a note, or a number in another shape, is not recognised); with the local model both stay on this computer.
- **Retention, erasure on withdrawal of consent, the wording and scope of consent for Mana, and whether a doctor may delete their own conversations are not decided** (the tables are append-only and nothing purges them, the names and MRNs a doctor typed are in the question text, the stored plan and the tool arguments); the owner and clinical governance must decide (R35).
- **One server only**: the start-up sweep fails every pending answer in the database. **The slice-1 Mana API remains** with no screen; whether to retire it was not decided here. English only; no streaming; the conversation is read whole on every poll.

### Browser verification

The five-width states test (`e2e/mana.spec.ts`) writes a crop of the panel and a full-page screenshot for nine states at 1440, 1280, 1024, 412 and 390 px: **90 images. All 45 panel crops were looked at** (closed, open, generating, an answer, a source opened, a refusal, a choice of patients, an error, unavailable); after the last change to the screen (a reader at the end of the conversation stays at the end when the window is resized) the states it affects, the refusal and the choice of patients, were looked at again; and so were the full-page images for the answer state at 1440, 1024 and 390 px. What was seen: nothing clipped or running off the screen at any width; the placeholder of the question box complete; the heading and the buttons wrap sensibly (the Open button drops under the heading at 1440 and 390 px); the About line, the statements, the source chips and the opened source readable; the refusal, error and unavailable states carry their fixed words; the choice of patients shows name, MRN, age and sex. Two things were found by looking and fixed: the newest message slid below the fold when the window was resized (a reader at the end of the conversation now stays at the end), and the page's own sticky bars were drawn over the crops of a panel taller than the window (the crops now hide the page's fixed and sticky bars; the full-page images keep them). The axe check passes in every state. The opt-in real-model run (the same panel with a real answer, a source opened, "generating" and a refusal at five widths) was looked at for the answer state. **What was not done:** a real screen reader was not run (the announcements are checked by the live-region content, not by hearing them), and the full-page images of the other states were produced and checked for overflow, not each looked at.

### Dev-environment actions

- **Development database:** an in-server clone `adaxai_backup_20261004_pre0027` (before 0027) and `adaxai_backup_20261004_pre0028` (before 0028) was made with the throw-away script `.data/probe/clone-dev.mts` (it closes new connections to the development database for the few seconds the copy takes and **never stops the PostgreSQL server**, which is shared with other applications on this machine); the counts of the clone matched the source (17 patients, 21 encounters, 16 signed, 1,542 audit events at the time of 0028). Migrations 0027 and 0028 were applied to it with `npm run db:migrate`. `npm run backup` was **not** used. The stale prompt row `mana-assistant-plan-v1` stays in `ai_prompt_versions` there (unused).
- **Other databases touched:** the test and end-to-end databases (reset by the test runners as usual). `adaxai_sec*` and `adaxai_dbsafe_*`, the separate secondary repository and the separate `doctor-app` repository were **not** touched.
- **The model:** the V3 model and runtime were reused; **nothing was downloaded** for V4.
- **No hosted provider was called**, in any test or evaluation; no key was entered anywhere; the per-install secret was never printed.

## Slice V3: local AI consultation intelligence (a language model on this computer drafts, code verifies, the doctor decides)

**Basis:** the owner's V3 brief. Decisions: [ADR 0016](adr/0016-local-ai-consultation-intelligence.md); the model card and every measurement: [safety/AI_MODELS.md](safety/AI_MODELS.md) §1b, §8, §9; the synthetic case set: [safety/DATASETS.md](safety/DATASETS.md); hazards R25 to R34 and the V3 edits to R1, R2, R10 and R14: [safety/RISK_REGISTER.md](safety/RISK_REGISTER.md); what is real: [AI_STATUS.md](AI_STATUS.md) capability D. **It did not build Mana on the local model (V4), speaker identification, other languages, devices (V5), thermal ML (V6) or any clinical validation.** Nothing here is clinically validated, a medical device or production-ready; all data is synthetic.

**The things a user will notice:** (1) the consultation has a new first card in its right-hand column, **Consultation intelligence**, whose draft is labelled **AI DRAFT · AI-GENERATED · REQUIRES DOCTOR REVIEW**; (2) a draft takes **minutes** (about 1 to 4 on this laptop CPU for a short record), shows the time elapsed and can be cancelled; (3) without the model the card says **"Local AI unavailable."** and makes nothing up (the fixed-rule record check is still shown); (4) the model is a **one-time, owner-approved download** (`npm run llm:setup`: a 19 MB runtime and a 2.74 GB model, hash-checked), started by `npm run dev`.

### What a doctor can do now, and what is real

| Step | State |
| --- | --- |
| Ask for a draft | **Real, local.** Needs the patient's recording-and-AI consent (current wording), the doctor's own open consultation and a running model; each missing thing has its own message. Everything is checked **before** anything is read for the model |
| What the model reads | The authorised record, the doctor's own draft note, the vitals and **only the points the doctor confirmed**. Never the transcript, the audio, rejected or unreviewed points, another patient. Name, MRN and phone replaced. Cut to a hard character budget, this visit first, and the screen says how many items it was not shown |
| What comes back | A structured draft: summary, problem, symptoms, observations, history, allergies, medicines, considerations, investigations, medication considerations, missing information, uncertainties; each statement with its sources, the AI's own words for why and what is uncertain |
| Who decides what is "supported" | **Code, not the model**: supported by record / inferred / not found / conflicting / outdated; unverifiable statements are removed (and counted) or marked; conflicts come from fixed rules |
| Review | Accept, Edit, Reject per statement (recorded: who, when, what); a marked statement needs an explicit tick (server-enforced); **none of it changes the note, diagnoses or prescription**; "Add to note" is a separate recorded insertion that appends to a note section |
| States | NOT RUN, GENERATING (elapsed time, Cancel), READY FOR REVIEW, PARTIALLY AVAILABLE, INSUFFICIENT INFORMATION, STALE, FAILED, CANCELLED, UNAVAILABLE |
| Versions and audit | Every draft stores prompt, schema, rules and checks versions, model, runtime, weights SHA-256, locality, a hash and manifest of what it was made from, the validation counts and who asked; finished drafts are immutable and never deleted; older drafts are kept; every step is audited with ids and counts (requested, finished or failed, cancelled, **the finished draft reaching the doctor's screen, once**, each decision, each insertion) |
| Model not running | **"Local AI unavailable."**, no draft, no placeholder text, and **no fallback to a hosted model** |
| **Not built** | Streaming text, automatic regeneration, other languages, a hosted run of this feature, any route from a draft to the diagnoses, the prescription or an order, retention or erasure rules for drafts, clinical validation |

### Implemented

**The local model and its server (`scripts/llm.mjs`, `services/llm/*.lock.json`).** `npm run llm:setup` (downloads after asking; size and SHA-256 verified; a mismatch is deleted), `llm:status`, `llm:verify`, `dev:llm` (llama.cpp on `127.0.0.1:8081` with `--offline --no-webui --no-slots --cors-origins <an origin that cannot exist> --jinja --reasoning off --parallel 1 --ctx-size 8192` and **prompt caching off** (`--no-cache-prompt --cache-ram 0 --no-cache-idle-slots --ctx-checkpoints 0`: measured, the defaults kept every earlier prompt in memory and made an answer depend on the server's history); a per-install secret in `.data/llm/api-key`, owner-only mode, passed by environment and never printed; an allow-listed environment). `npm run dev` starts it when it is installed. `.data/llm` is git-ignored.

**The provider abstraction (`apps/api/src/ai/llm/`).** `ReasoningModel`; `LocalLlmClient` (loopback only, redirects refused, 4 MiB cap, answers schema-checked, every failure in words, timeouts, cancellation, a health check that also proves the server accepts the application's secret); `HostedReasoner` (built only behind the egress policy and a key, used only if the server is set to `hosted`); `Gate` (one request runs, `maxWaiting` wait, more are refused with 429); `reasoningStatus`. Settings `ai.reasoning.*` in `config/adaxai.yaml`; environment `LLM_PROVIDER`, `LLM_URL`, `LLM_API_KEY` / `LLM_API_KEY_FILE`, `LLM_ALLOW_NON_LOOPBACK`. **The test configuration forces the reasoning provider off**, so no automated test can reach a model server that happens to be running on the machine.

**Database (additive migration `0026_consultation_drafts`, applied to the test, end-to-end and, after an in-server clone, the development database).** `consultation_drafts` (one row per draft: version, status, phase, model identity, weights hash, locality, prompt, schema, rules and checks versions, a hash and manifest of the inputs, the record check, validation counts, the error, the requester, the idempotency key) and `consultation_draft_items` (the statements: section, text, support, rationale, uncertainty, flags, source keys, needs-confirmation, decision). Partial unique indexes: one generating draft per consultation, one idempotency key per requester. Triggers: a finished draft cannot be changed, its inputs never change, nothing is deleted or truncated, and a statement changes only by the doctor's single decision (the shared review guard). Cited sources are `ai_evidence` rows.

**API (`apps/api/src/consult/`).** `GET /api/encounters/:id/consultation-ai` (the state; `?fresh=1` asks the model again), `POST .../consultation-ai/drafts` (202 started, 200 the same request again), `GET /api/consultation-ai/drafts/:id`, `POST .../drafts/:id/cancel`, `POST /api/consultation-ai/items/:id/review`; "Add to note" goes through the existing `POST /api/encounters/:id/insertions` with a new subject, `consultation_item`. `inputs.ts` is the one place that builds what the model may read; `prompt.ts` holds the prompt and the output schema; `validate.ts` the checks; `service.ts` the lifecycle (background run through the job service, cancel, drafts interrupted by a stop failed at start-up, consent read again before an answer is stored). The review outcomes of the statements appear in the doctors' review list and in the administrators' counts.

**Web.** `components/ai/ConsultationIntelligence.tsx` ([DESIGN.md](DESIGN.md) §4d); the administrators' AI page shows the reasoning model and the new outcome type.

**Evaluation (synthetic only).** `data/eval/consult-v1/cases.json` (12 cases, 5 development and 7 test cases; the test cases are no longer untouched, see [safety/DATASETS.md](safety/DATASETS.md) for the history of the split), `apps/api/src/eval/consult.ts` and `consult-cli.ts`: the real model's answers are recorded **before** any check and scored with the checks as they are (`--replay` re-scores the record without a model).

### Measured results (synthetic data only)

Full tables, method, the history of the split and what the numbers do not show: [safety/AI_MODELS.md](safety/AI_MODELS.md) §9 (the record: `data/eval/results/consult-v1.md`). The real model **as the launcher starts it** (prompt caching off), 12 cases written by the authors, 4 Oct 2026, this laptop's CPU:

| Measure | Result |
| --- | --- |
| Answered in the required form | 12 of 12 |
| Statements written → kept after the checks | 137 → 131 (6 removed, 19 kept with a mark carrying 24 marks) |
| What was removed | a dose copied from the drafted prescription into a consideration (1); an unsourced summary sentence (1); "no known allergies" against a recorded allergy (2); a figure taken from a point written in Hindi (2) |
| Expected facts covered by a kept statement, citing an item that states them | 35 of 35 |
| Expected missing information named by the AI / with the fixed rules' check on the same screen | 4 of 7 / 7 of 7 |
| Conflicts the rules found that the draft marked "conflicting" | 3 of 3 |
| Forbidden content (a diagnosis stated as fact, a dose, a made-up allergy, an obeyed instruction, the system prompt) in what was kept | 0 |
| Time for one draft | median 120 s, longest 214 s (68 to 214 s) |
| The same case run twice (c03, c09, c10) | identical answers; two server instances with different histories gave identical answers (c05, c12) |

**The first recording was replaced.** It had been made against a server with the runtime's default prompt caching on, after the server had answered many other prompts. The same prompts on freshly started servers came back different in all three cases tried, **none of the twelve answers of the second recording equals the first's**, and with caching off the answers did not depend on history. The same default setting also kept a copy of every earlier prompt in the server's memory (about 160 MB each, up to 8 GiB; the development server had reached 9.7 GB). The launcher now switches caching off; the first recording is kept as `consult-v1.superseded.raw.json` and is scored in no report. A result such as "the AI named 1 of 7 missing items" described that server's history as much as the model: with the shipped settings it is 4 of 7.

**These are counts of behaviour on cases the authors wrote, not an accuracy and not a clinical validation.** One false statement was kept and only marked, by luck, in the final record (c06's summary says the duration of the dizziness is not recorded although the reason for the visit gives it): a check for an absence claimed inside a sentence of a summary was added after seeing it.

### Tests

Run on this machine on 4 Oct 2026, synthetic data, **no real model or provider called by any automated test** (the API test configuration forces the reasoning provider off; the end-to-end suite points the API at loopback stand-ins unless the opt-in variable is set).

| Check | Result |
| --- | --- |
| Typecheck (api, web, contracts, e2e), lint (oxlint with warnings denied, ruff for the two Python services) | clean |
| API tests (vitest, real PostgreSQL test database) | 45 files, **622 passed** (V2.1: 39 files, 483). 139 are new in V3: the pipeline against a stand-in model 39, the checks 53, the inputs 6, the scoring of the evaluation 11, the local client 12, the pinned files and the launcher run with `--dry-run` 12, the egress policy 3, the settings 2, the scrubber 1; one existing expectation (the registered prompts) updated |
| Web unit tests | 30 passed |
| Speech service tests (pytest) | 61 passed |
| Thermal service tests | 32 passed |
| End to end (Playwright, Chromium, desktop and phone projects, 4 workers) | 206 tests: **172 passed, 34 skipped, 0 failed** in the final run (7.9 min on four workers); the 34 are the opt-in real-model and speech specs and the desktop-only specs on the phone project. Four earlier full runs on the way there each had failures: two stale expectations in this slice's own consult specs (corrected), then one failure per run in an older test: the history test and the sign-in keyboard test (both fixed, with evidence) and one start-consultation request answered 500 (not reproduced, see "Failures found"); each passed when repeated |
| Opt-in, with the real models | the draft in a browser against the real local language model: passed (draft of 8 statements in 100 s); the whole chain with the real speech and language models, signing and the signed record naming the model and prompt: passed (3.8 min, after the test was corrected to have the doctor write the diagnosis that signing requires) |
| Evaluation with the real model (not part of the gate) | 12 cases, see "Measured results" above; the scoring itself is unit-tested without a model |
| Hallucination and injection | 53 check tests (answers that invent figures, doses, medicines, links and sources; reverse a "no" in either direction; hide words in zero-width characters, full-width or Arabic-Indic digits or hyphens; label themselves "not found" to skip a rule; follow an instruction hidden in the record), the c08 case with the real model, and the browser test with an injected answer; the review's findings above, each with a regression test |

### Failures found during this slice, and what was done

- **Tooling:** a hand-typed line-separator escape inside a regular expression became a raw line separator on the way to the file and broke the build; replaced.
- **Test expectations written from memory were wrong** (the order of sections in a draft, the counts of removal reasons, 11-digit telephone numbers, where a wrapped database error keeps its constraint name): corrected against the code.
- **False "stale":** adding an accepted statement to the note, and the saved-at time of the doctor's own draft, each made the draft look out of date. The comparison now leaves out what was added from the draft and the save time.
- **End to end:** a colour-contrast failure from reduced opacity; locators that depended on position; a model status remembered for seconds kept "unavailable" on screen after the model came back (the screen now asks afresh, polls every 5 s and has "Check again"); a draft that failed while the model was down showed FAILED rather than UNAVAILABLE; duplicate alerts and "You can retry" said twice; two specs sharing one stand-in server interfered across the two projects (the file now runs on the desktop project only).
- **Found by the first real-model runs on the development cases:** (a) the model wrote "Duration of the X is not documented" in four of five cases although the reason for the visit gave the duration (its own example sentence in the prompt was the likely cause): a check (an absence the record contradicts) and a prompt change; (b) a legitimate summary was removed because the age band "50-59" counted as an invented figure; (c) "No known allergies are documented" was written for "allergy status not recorded"; (d) a prompt rewording made the model drop the summary; (e) the checks let a dose stand in a suggestion if the cited prescription had one; (f) a fragment ("Patient's age.") was called contradicted by every item that mentions the patient. Each is fixed and has a test.
- **Found by reading the design again:** a very long consultation could send more than the model's context holds, because this visit's own items were exempt from the budget (now a hard budget); consent withdrawn while a draft was being made (minutes) was not re-read before the answer was stored (now it is); the new review type was missing from the administrators' counts and the doctors' review list (added); the ADR said "never a dose in a suggestion" while the code let a cited dose through (the code now matches).
- **`egress.test.ts`:** the test configuration forces the reasoning model off on purpose; the new tests had to bypass it explicitly.
- **Found at the very end, by re-running the cases on a fresh server: the evaluation was not reproducible, and the server was keeping patients' prompts.** The first recording had been made against a long-running server with the runtime's default prompt caching; the same prompts on freshly started servers gave different answers in all three cases tried (and none of the twelve answers of the re-recording equals the first's), while the same default kept a copy of every earlier prompt in memory (about 160 MB each, up to 8 GiB; the development server had reached 9.7 GB). The launcher now switches caching off, the whole evaluation was re-recorded against the shipped settings (the first kept, marked superseded, scored nowhere), and every document that quoted the first numbers was rewritten. The documents also claimed that the server "keeps no slot state" and "needs about 4 GB"; both are now what was measured.
- **A check missing, seen in the re-recording:** a summary said "the duration of the dizziness is not recorded" beside a reason for the visit that gives it, and was marked only by luck; absence claims inside a sentence of any statement about the record, and an item the statement itself cites, are now checked (3 new tests).
- **Three stale expectations, found by the final end-to-end run:** the registered-prompts list in `ai-clinical.test.ts` did not include the new prompt; two specs in `consult.spec.ts` still expected a failed or cancelled attempt to replace the draft on screen (it now stays, with a note): rewritten, and the five-width test now shows the new note at every width.
- **Two older end-to-end tests were flaky and are fixed (each with evidence, not by a longer timeout):** (a) `entry.spec.ts` "the sign-in pages work from the keyboard" failed on the first run after the development server started (3 of 4 repeats passed): the address changes before the lazily loaded route renders, so the first Tab started from the page being replaced; the test now waits for the form (4 of 4). (b) `history.spec.ts` "when the history cannot be loaded ..." (mobile) failed in 2 of 3 full runs, as it had since V2: the trace shows the button detaching because the banner's allergies poll the same data and the panel recovered by itself between un-routing and the click; the test now accepts either path and still asserts the loaded panel (12 of 12 under four workers).
- **One server error seen once in the end-to-end suite, not explained with certainty:** in one of four full runs `POST /api/visits/:id/encounter` returned 500 ("Something went wrong") to the first tests of the run, which passed 12 of 12 when repeated under four workers and did not recur in a 135-test stress run with the API's log captured. The database log shows client connections forcibly closed at that second, which fits a new pooled connection being refused within the pool's 2-second connect timeout on a busy laptop (a pre-existing setting; the pool starts empty and the first burst of requests opens up to 10 connections at once). **Probable cause, not proven; nothing was changed for it.** The end-to-end runs: 3 failures (2 real, see above, and the history test), then 1, 1, 1: every one a different older test that passed when repeated.

### Independent review of the V3 diff (before the commit)

One independent, adversarial, read-only reviewer (a separate agent that had not written the code) read the whole V3 diff, ran six throw-away probes of pure functions (the checks, the scrubber, the prompt builder, the extractor) and did not run the suites, the database or the model. It reported **18 numbered findings, gaps in the tests and 14 sentences in the documents that the code did not support.** The two HIGH findings were real: the checks looked for a reversed "no" in one direction only, and the model's own "basis" label switched off the rules for content it had invented. What was done with each:

| # | Finding (the reviewer's severity) | What was done |
| --- | --- | --- |
| 1 HIGH | A statement that reverses an affirmative source ("not allergic to penicillin" citing an allergy to penicillin, "No fever.") was labelled supported with no mark | **Fixed.** The negation check is symmetric (a "no" in the statement that the cited items do not carry is marked, as well as the reverse); the "no allergies" forms are widened (none, nil, denies, "not allergic to X") and such a statement is removed when the record lists an allergy; absence matching is stem-aware. Regression tests for each form |
| 2 HIGH | The model's `basis` label switched off the rules ("not found" with no source stayed; "inferred" invention stayed unmarked) | **Fixed.** The source and wording checks apply by section, not by the model's label; "not found" must carry absence wording; every missing-information statement gets the absence check. Tests |
| 3 MED | "Supported by record" is word overlap only (figures bound to the wrong subject; a stopped medicine stated as current; a relative's illness stated as the patient's; an old reading called "today") | **Partly fixed.** New marks for a stopped or resolved item cited in the present tense, a relative's condition worded as the patient's and "today" resting on an earlier day; the card now says in a sentence that "supported" means the cited items contain the statement's words and figures, **not that it is right**. **Not fixed: figures bound to the wrong subject** (listed below) |
| 4 MED | The AI's reason and uncertainty were never checked | **Fixed.** Held to the suggestions' rules (no dose, link, diagnosis worded as a fact, unknown medicine or figure); a field that breaks one is dropped and counted |
| 5 MED | Character tricks and gaps evaded the checks (zero-width characters in a drug name, full-width and Arabic-Indic digits, numbers in words, doses in words, common drugs missing from the list) | **Fixed.** NFKC, characters that only format text removed, digits of other scripts converted or refused, number words, doses and regimens in words for suggestions, drug names tolerant of hyphens and zero-width characters, a longer list. A test for each trick |
| 6 MED | Consent was not re-read between waiting for the model's one slot and the call | **Fixed.** Consent and the consultation's status are read again after the slot is taken and again before the answer is stored; tests for withdrawal and for closing while the draft waits |
| 7 MED | A failure after the draft row was inserted left a "generating" draft that blocked every later one | **Fixed.** Everything after the insert fails the draft through the same path; test |
| 8 MED | Other doctors could read AI statements and the patient's identity through the older AI record and review pages | **Fixed for the new data.** Consultation statements are listed only to the doctor who made them (and risk R33 now says what other doctors get: 403 on the consultation routes). The older pages' facility-wide visibility of the *older* AI output is unchanged and remains a recorded decision. Tests |
| 9 MED | The rules' record check did not compare the typed-in medicine list with allergies | **Fixed.** Test |
| 10 MED | Provenance asserted, not measured (`local` hard-coded true; the weights hash by alias) | **Fixed.** Locality is derived from the server address; the documents say "by alias" |
| 11 MED | Scrubbing gaps (parts of names, phones written with brackets or dots, an MRN without its dash; record fields not scrubbed) | **Improved, still best effort.** Parts of a name of four letters or more, phone separators, an MRN with the dash optional, and the value, unit, reference text and code of results are scrubbed; every document now says "best effort" (relatives' names, addresses, e-mail and national ids are not scrubbed) |
| 12 | (unverified by the reviewer) `/v1/models` might answer without the secret | **Verified false on this runtime** by calling it, `/props`, `/slots`, `/tokenize` and the chat endpoint without the secret: each answered 401. A manual check; no test starts the server |
| 13 | (unverified) chat-template control strings in record text | **Confirmed by a probe** (the server parses special tokens in user text); each source line now has `<\|`, `\|>`, `<think>`, `<tool_call>` and the like neutralised. Test |
| 14 LOW | Insertion did not check that the draft is the newest, or the note section | **Fixed** (a superseded draft and an uncertainty are refused). A *stale* draft can still be used: the card says STALE, and the doctor decides |
| 15 LOW | UI honesty (the "was not asked" text when the model itself said insufficient; a failed regeneration hid the good draft) | **Fixed.** The wording depends on who said it; the newest finished draft stays on screen with a note about the newer attempt |
| 16 LOW | Lifecycle (every provider failure retryable; unexpected errors not logged; cancel race; start-up sweep without an age guard; the gate can overshoot; `?fresh=1` not rate-limited) | **Fixed:** a failure that trying again cannot fix says so, unexpected errors are logged, cancel returns the true state. **Not changed, listed below:** the sweep assumes one API process, the gate can overshoot its waiting limit under concurrent requests, `?fresh=1` is not rate-limited |
| 17 LOW | The budget under-counted the rendered prompt; a settings comment was wrong; the 4 MiB cap was checked after the whole body was read | **Fixed.** A hard budget counts each line as sent plus the fixed words; the cap is applied while reading; comment corrected; an independent length in the test |
| 18 LOW | Launcher: `1` against `true`; file mode `0600` ignored on Windows; a path put into a PowerShell command string | **Fixed** (both spellings; paths passed by environment). **The key file's mode is not enforced on Windows** (listed below) |
| Tests | Tests that could not fail (a grep of the launcher's source, a tautology, a formula copied from the code); missing tests | **Rewritten and added:** the launcher is run with `--dry-run`; the budget test uses its own length; new tests for polarity, basis evasion, the AI's reasons, consent while queued, orphaned drafts, a key reused across consultations, insertion limits, other doctors, the database triggers, discarded consultations, non-retryable errors and the non-loopback setting |
| Documents | 14 sentences the code or tests did not support (ADR, AI status, README, product specification, risk register, design) | **Corrected** |

### Remaining limitations

- **Not clinically validated, synthetic data only.** Twelve cases written by the authors, English, short; no real consultation, no clinician has judged a draft, no usability assessment (is the draft useful, is it read, does the tick become a reflex: not studied). Nothing here is a claim of accuracy, safety or fitness for use.
- **A wrong statement worded plausibly and citing a real record item is not recognised by any check.** "Supported by record" means the cited items contain the statement's words and figures. **Not caught: figures bound to the wrong subject** (a heart rate of 18 and a respiratory rate of 120 swapped between two readings that are both cited), a plan stated as an observation, an old visit reason called the current problem. The sources are open beside every statement for exactly this reason.
- **The model is small and slow.** A 4-billion-parameter model on a laptop CPU takes about one to four minutes for a short record, one draft at a time (the others wait or are refused). It leaves out most of what is missing from a record (the fixed rules' check carries that), writes generic considerations, and its answer is sensitive to the wording of the prompt (one rewording dropped the summary in all five development cases).
- **English only.** A confirmed point written in another script is not read by the checks (c12 shows the draft coming out short).
- **Answers are reproducible only on this machine and build.** With prompt caching off an answer does not depend on what the server answered before (measured on three cases and one repeat), but a different CPU, thread count or runtime build can compute the same prompt a little differently and change a greedy answer.
- **The evaluation is a behaviour count, not an accuracy.** The test split was run twice: the first recording was made against a server with prompt caching on, was found to depend on that server's history, and was replaced by a second recording against the shipped settings (the first is kept as `consult-v1.superseded.raw.json`); checks tuned on the first recording are now exposed to answers they were not tuned on, and every change after seeing the second is disclosed in [safety/DATASETS.md](safety/DATASETS.md).
- **Prompt injection is reduced, not removed.** One hidden-instruction case (c08), one wording. The model has no tools and the answer is only ever shown as text, but a source can still make the model write a misleading, cited sentence.
- **Privacy scrubbing is best effort.** Parts of the patient's name, the MRN and the phone number as recorded; a name or number written another way in free text, relatives' names, addresses, e-mail and national ids are not scrubbed. It matters mostly for the hosted mode, which has never been run against a real service.
- **The secret and the loopback boundary protect against other machines and web pages, not against another process of the same user** (it can read `.data/llm/api-key` and call the server). The key file's owner-only mode is not enforced on Windows.
- **Small operational gaps, left as they are:** the start-up sweep of drafts interrupted by a stop assumes one API process; the waiting limit of the model's gate can be overshot by requests that arrive at the same moment; `?fresh=1` (the "Check again" button) is not rate-limited; a stale draft can still be accepted and added (the card says STALE).
- **Governance, not decided here:** whether a local model needs a consent of its own and its own wording (the recording consent's wording still needs a legal review); how long drafts and their evidence rows are kept and whether withdrawal of consent should remove them (nothing is purged); whether the older AI review page should keep showing other doctors' AI output facility-wide; whether and how AI-assisted text is shown to patients.
- **Not built:** streaming text, automatic regeneration, other languages, a comparison of models or runtimes, GPU acceleration, a hosted run of this feature, any route from a draft to the diagnoses, the prescription or an order, learning from doctors' decisions.

### Browser verification

"Browser verified" below means rendered in Chromium (Playwright) and **looked at** (the screenshots were opened and read), not only asserted.

- **Five widths (1440×900, 1280×800, 1024×768, 412×915, 390×844), five states of the card:** NOT RUN, FAILED, UNAVAILABLE, READY FOR REVIEW with the first statement's sources open, and READY FOR REVIEW with a newer attempt that did not finish. `e2e/consult.spec.ts` "states at five widths" takes a page and a panel screenshot of each (50 images), asserts no sideways scrolling and the card inside its column at every width, and runs the accessibility check (axe) in each state; the screenshots were opened and read: every state at every width (NOT RUN and READY from the run made just before a one-sentence copy edit to the "newer attempt" alert, FAILED, UNAVAILABLE and the newer-attempt state from the final run). The mobile layouts keep the fixed action bar at the bottom; nothing scrolls sideways.
- **The workflow with the labelled stand-in model** (`e2e/consult.spec.ts`, desktop project, 8 tests): consent and labels, generating with elapsed time and Cancel, a draft grouped with sources and support states, accept, edit and reject, adding to the note as a separate act that records where it came from (and the note unchanged until then), a conflict the rules found shown under the statements that rest on it and needing the tick, STALE after a note edit and a new draft keeping the old one, "Local AI unavailable." with the record check still there, a failed and a cancelled attempt with and without an earlier draft, and an injected answer losing everything dangerous.
- **With the REAL local model, in a browser (opt-in `e2e/consult-real.spec.ts`):**
  - *The draft:* `qwen3.5-4b-q4_k_m` through the real API wrote a draft of 8 statements in 100 s for a synthetic patient with a penicillin allergy; labelled AI DRAFT · AI-GENERATED · REQUIRES DOCTOR REVIEW, every statement about the record opened to its sources, nothing in the note, the diagnoses or the prescription until a statement was accepted and added, after which the note shows the AI-assisted marker naming the model, runtime and prompt (screenshot read).
  - *The whole chain* (3.8 minutes): synthetic speech recorded through the browser's fake microphone and transcribed by the real local speech model, three important points confirmed, **a draft of 14 statements by the real language model** with the fixed rules' Amoxicillin–penicillin conflict shown and statements resting on a confirmed point, one statement accepted and added to the note, the diagnosis and plan written by the doctor, the record signed, and the signed record's "AI-assisted text" section naming the draft statement, `llama.cpp · qwen3.5-4b-q4_k_m · consult-draft-v1` (screenshot read). This is the owner's success criteria 1 to 11 end to end, on synthetic data.
- **Not browser-verified:** browsers other than Chromium; a real phone (the narrow widths are Chromium viewports); screen readers (axe's automated rules only); a clinician using it.

### Dev-environment actions

- **Downloads (approved by the owner on 4 Oct 2026):** the llama.cpp `b11379` Windows CPU runtime (19.4 MB, from GitHub) and `Qwen3.5-4B-Q4_K_M.gguf` (2.74 GB, from Hugging Face), by `npm run llm:setup`, each checked against the size and SHA-256 pinned in `services/llm/*.lock.json`, into the git-ignored `.data/llm`. Nothing else was downloaded; the application, the tests and the evaluation never download anything.
- **Development database.** Before migration `0026_consultation_drafts` (two new tables, their indexes and triggers; nothing existing is altered) was applied to `adaxai`, the database was **cloned inside the same server** as `adaxai_backup_20261004_pre0026`, and the clone was checked against the source (17 patients, 21 encounters, 16 signed, 1,502 audit events, 8 files, 4 transcripts, 6 users, 26 migrations, identity `development`: identical). After the migration the development database holds the same counts, 27 migrations and two empty new tables with their four triggers. **This is not a file-level backup:** `npm run backup` is a cold copy that stops the PostgreSQL server, which is shared with other applications on this machine and was **not** stopped; the clone lives in the same cluster. The owner can drop the clone (`DROP DATABASE adaxai_backup_20261004_pre0026`) when it is no longer wanted.
- **Test and end-to-end databases** (`adaxai_test`, `adaxai_e2e`) were migrated by their own commands.
- **The model server** runs on `127.0.0.1:8081` (`npm run dev` or `npm run dev:llm`), restarted during this slice with the final settings (prompt caching off). Throw-away servers on spare ports 8082 to 8087, with throw-away secrets, were started and stopped to measure memory and determinism; none remains.
- **Not touched:** the databases `adaxai_sec*` and `adaxai_dbsafe_*`, the secondary-apps worktree, the separate `doctor-app` repository, and the shared PostgreSQL server (never stopped).

## Slice V2.1: hardening before V3 (hosted-AI egress policy, speech-service limits, withdrawal, migration 0025, the seed clock)

**Basis:** the owner's brief to close the V2 hardening items before V3. Decisions and the full classification of what is left: [ADR 0015](adr/0015-hosted-ai-egress-policy-and-speech-service-hardening.md); what capture stores, where, and what withdrawing consent does and does not do: [safety/CAPTURE_DATA.md](safety/CAPTURE_DATA.md). **No capability was added.** Nothing here is clinically validated, a medical device or production-ready; all data is synthetic.

**The one change a user will notice:** drafting, AI recommendations, Mana AI summaries and photograph descriptions are **unavailable until hosted AI egress is allowed on purpose, including on this development machine, whose `.env` holds an Anthropic key.** A key alone enables nothing. The screens say so ("Hosted AI processing is switched off on this server, so no consultation text leaves this computer…").

### What was fixed, and how it was verified

| Item | What now happens | Evidence |
| --- | --- | --- |
| **Hosted-AI egress** | `ai.egress.hostedProviders` in `config/adaxai.yaml` (committed, **false**) or `AI_EGRESS_HOSTED` (true/false; false always wins) decides. A hosted client is **constructed only if egress is allowed AND a key is set**; with egress off the drafter, recommender, image describer and Mana summariser do not exist, so no route, retry or request flag can reach them. The state is on the screen ("Hosted AI: off, nothing leaves this computer" / "allowed (to host)"), in the administrators' overview (and whether a key sits unused), and in the settings snapshot stored on every AI job. No route changes the setting; the key never reaches the browser. There is no fallback between local and hosted in either direction | `egress.test.ts` (16): a loopback stand-in that **counts requests** and a placeholder key: key present + egress off = **0 requests** through the real application (draft, recommendations with `includeLlm`, extraction, Mana summaries, status; each refusal is the exact 503 and reason), the same calls with egress on **do** reach the stand-in (the control), rules extraction stays local with egress on, a down speech service never reaches the provider, no route in the server's own route table changes a setting (found by enumerating it, not by guessing URLs), no key in the status or the overview; the end-to-end suite asserts none of a capture's words reach the (loopback) mock |
| **API test state (hospital seed)** | The V1 seed no longer depends on the wall clock: it allocates overlap-free appointment slots on the right side of "now" and, in the first hours of the day (before 02:40) and the last (after 22:25, when a booking 90 minutes ahead no longer fits the day), builds today's schedule as if it were midday, holding the clock the API reads for the whole run (released in a `finally`); a time with no room is refused, never made wrong. The seed sets the start of its own sessions; **no production code changed for it** | `hospital-seed.test.ts` (V1, **unchanged**) **passes**, including in the full run at 01:39 IST, inside the window where it used to fail; `hospital-seed-clock.test.ts` (10) runs the real seed with the clinic's time fixed at 03:20, 12:00, 22:25 and 23:00, and with the real clock faked to 00:00, 00:30, 00:55, 02:00, 02:39, 22:26, 23:15, 23:30 and 23:55, and checks that an impossible time is refused |
| **Speech service** | The **content** decides, not the name or the declared type: only WebM, Ogg, WAV, MP3 or MP4 by their first bytes and matching the declared type, refused (415) by the API before storing and again by the service. The demuxer is chosen by us with an in-memory-only protocol whitelist (an upload cannot make the service open a file or an address). A duration bound **before** the expensive work (declared length, or a decode that stops at `SPEECH_MAX_AUDIO_SECONDS`, default 3,600 s, 413); malformed media is 422, never a crash. Request limits applied **before the body is read**: 64 MB (a declared length over it is refused unread; a body that declares none is cut off at the limit), at most 4 requests pending counted from the moment they arrive (429 + Retry-After), and per-user API rate limits on audio and on the costly steps (429, audited). Still loopback only, Host allow-list, a client header browsers cannot send cross-origin, in-memory uploads, logs that name error classes only. **No sign-in, by design and said so**: a secret beside the service on the same computer would protect nothing | `test_media.py`, `test_engine.py`, `test_api.py` (Python, 61 in all: including the body cap with a parser spy, the protocol whitelist tested with a real concatenation list that names a file and an address, with positive controls, and decode that stops at the bound by counting frames) and `capture.test.ts` (sniffing, rate limits) |
| **Consent withdrawal** | Withdrawing recording consent **ends any live recording in the same step** (end reason `consent_withdrawn`, audited), not only when the doctor's browser notices; every step that stores audio re-checks the consent at the last moment, under a lock, so a withdrawal and a store cannot pass each other. The screens now say what withdrawal does **not** do: **nothing already captured is deleted or hidden**; doctors of the facility can still read it; what happens to it is the clinic's decision, not yet defined. **No part of the product claims that withdrawal deletes history, and none does** | `capture.test.ts` (37, including a real slow upload during which consent is withdrawn, and a lock test; each fails if the check or the lock is removed), `e2e/capture.spec.ts`; [safety/CAPTURE_DATA.md](safety/CAPTURE_DATA.md) lists every table, file and log that holds capture data, who can read it and whether the application can delete it |
| **Migration 0025** | **Not edited** (the runner refuses edits to applied migrations). Applied, with its unique index (one live recording per consultation), in the development, test and end-to-end databases, none of which has a consultation with several live recordings (checked read-only). On a database an earlier application version left with several, the migration would fail atomically; the runner now has a **pre-flight check** that says in words what is wrong and that nothing was changed, and a named, explicit, counted remedy: `npm run db:migrate -- --target <db> --end-duplicate-live-recordings` (all but the newest live recording of a consultation are ended; their transcript lines are kept). It is never run implicitly | `preflight.test.ts` (7): the real queries on the test database inside a rolled-back transaction (a database with several live recordings, the message, the remedy and its count, the index built afterwards) and the runner with a stand-in client (refuses, applies nothing, changes no data; applies the remedy only when asked by name) |
| **Remaining findings** | Classified: FIX NOW (done, above), DOCUMENTED PROTOTYPE LIMITATION, REQUIRES A CLINICAL / LEGAL / GOVERNANCE DECISION | [ADR 0015](adr/0015-hosted-ai-egress-policy-and-speech-service-hardening.md) §4 |
| **V2 workflow regression** | The whole V2 workflow is one end-to-end test with the browser's synthetic microphone: consent first (and the server refusing without it), start, record, pause, resume, stop, local transcription (a labelled stand-in service), the transcript, speaker assignment, extracted points, confirm and reject, "Add to note" as a separate act, withdrawal mid-recording, a refused microphone, a browser without recording, an unavailable speech service; and **no call to a hosted provider** at any step | `e2e/capture.spec.ts` (both projects) |

### Verified test results (slice V2.1, 4 Oct 2026, this machine, synthetic data)

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` (oxlint; ruff for both Python services) | clean |
| Web unit (`npm run test:web`) | 30 passed |
| API (`npm run test:api`, one test database) | 39 files, **483 passed** in the final run (an earlier full run of this slice had 2 failures, both old expectations of the wording of the "not configured" reason, now the egress-off reason: `images.test.ts`, `mana.test.ts`; fixed). The 10 new tests since: 4 seed-clock, 3 consent-race, 3 egress |
| Speech service (`npm run test:speech`) | 61 passed |
| Thermal (`npm run test:thermal`) | 32 passed |
| End to end (`npx playwright test --workers=4`, about 8 min) | **First full run: 164 passed, 22 skipped, 0 failed. Final full run (after the review fixes): 163 passed, 22 skipped, 1 failed**: the known load-sensitive V1 test `history.spec.ts` "when the history cannot be loaded the panel says so and retries…" on the phone project (a click raced a re-render; it is not touched by this slice), which **passes 6 of 6 times alone** (3 desktop, 3 phone) and passed in the first full run. The skips are by design: tests that exist for one project only (desktop-only or phone-only layouts, five-width tests that set their own viewports) and the opt-in real-model spec |
| Accessibility | axe (WCAG 2.2 AA tags) inside the end-to-end tests, in the consent-needed, recording, unavailable, microphone-error, egress-off and egress-on states: no violations |
| The real model through the new decode path | The opt-in `e2e/capture-real.spec.ts` passed (48 s): a real Chromium recorded synthetic speech (a WAV played as the fake microphone), the real API sent each part to the **real** local model (`faster-whisper-small`) in a freshly started service running the V2.1 code (sniffing, explicit demuxer, bounded decode), and timed English lines ("…I have fever and a dry cough, and my throat is sore also…") and proposed important points came back. Synthetic text-to-speech: this shows the chain works, not accuracy |

### Browser verification

`e2e/capture.spec.ts` "states at five widths" drives the consultation workstation in Chromium at **1440×900, 1280×800, 1024×768, 412×915 and 390×844** through three states (the patient's consent needed; consent recorded but the local speech service unavailable; the microphone refused) and fails on any horizontal overflow, any capture card wider than the screen and any axe violation, and writes a screenshot of each state at each width. The layout test (`capture layout`) does the same for the recording, transcript and points states at 1440, 1280, 1024 and 390 px, and on the 412 px phone project. **Screenshots looked at by me:** consent needed at 1440 and 1280, unavailable at 1024 and 412, microphone error at 1440 and 390. **A real microphone and browsers other than Chromium were not tested.**

### Failures found during this slice, and what was done

- **A first seed fix looped forever** (it moved a slot by 15 minutes and cycled) and hung my own test run; I stopped only my own processes, restored the file and wrote the allocator that is there now. **The late-evening case (23:00) overlapped** until the new deterministic test caught it. **Seed sessions expired as idle** when the clock was held far from real time: sessions now take both timestamps from the same clock.
- **The content sniffer refused short parts** (a 4-byte test chunk) because it demanded 12 bytes for every format: per-format length guards, in both the API and the service.
- **The test suites had hard-coded the old reason texts** (four files) and the per-account sign-in rate limit stopped a capture test that signs in repeatedly: expectations updated to the egress-off reason; the test settings lift the limit.
- **Found by the browser tests:** an axe `target-size` false positive caused by the scroll position under the fixed header (the test scrolls to the top before the check); the microphone-refused flag was lost on reload (kept in `window.name`); the consent text said "that service" without saying where (it now names the destination and says the audio never goes there).
- **A shipped migration cannot be edited** (checksum guard): the pre-flight and an explicit remedy replaced the edit.

### Independent review of the V2.1 diff (before the commit)

A read-only adversarial review of the whole V2.1 diff (hosted egress, the seed, the speech service, withdrawal, migration 0025, the honesty of the documentation, the quality of the new tests) reported **no high-severity findings, three medium and six low**, plus a note that the V3 helper files then in the tree were not part of this slice (they are kept out of this commit). Each finding was checked against the code before anything was changed; all were fixed or documented:

| Finding | What was done |
| --- | --- |
| **Medium.** The speech service parsed the whole multipart body before its size check and before counting the request: an upload past the parser's memory limit would have been spooled to a temporary file (against "nothing is written to disk"), and a burst of large uploads was never refused | **Fixed.** A guard in front of the application refuses a declared length over the limit unread, cuts a body that declares none off at the limit, and counts the request before its body is read. Tested with a parser spy, a body with no declared length, and a check that nothing reaches the temporary directory |
| **Medium.** "Nothing leaves this computer" and the hosted-AI disclosure followed whether *drafting* was available, not whether a hosted client existed (photograph descriptions, Mana summaries or a hosted extractor can exist without drafting) | **Fixed.** They follow whether a hosted client exists (egress allowed and a key set), name the features that would send, and take the important-points sentence from the extractor's own status; the capture consent sentence and the administrators' page follow the same rule |
| **Medium.** An uploaded recording was checked for consent only before its body was read, not before it was stored: a withdrawal while a 25 MB upload arrived left the audio stored | **Fixed** (checked again after the body, before storing), together with the same window in the live-part step and the live-start step, closed by reading the consent **under a lock** inside the storing step so that a withdrawal and a store cannot pass each other. New tests: a real slow upload, a withdrawal during the speech service's health check, and a withdrawal made to wait for a step that holds the lock; **each was checked to fail when the check or the lock is removed** |
| Low. Live start checked consent, asked the speech service (up to 2.5 s), then inserted | **Fixed** (the check is in the inserting step, locked) |
| Low. The seed handled only the early morning: a booking 90 minutes ahead cannot be placed after "now" from about 23:15 | **Fixed.** The clock is also held at midday after 22:25; a time with no room is refused loudly (never a booking that has already started). Tests at 22:25 and 23:00 explicitly, and with the real clock faked to 22:26, 23:15, 23:30 and 23:55 |
| Low. The application's `createSession` had been changed so that the seed's held clock works: a production change made for a tool, against the rule | **Reverted.** The seed sets the start of its own sessions; the application's sign-in is as it was |
| Low. Documentation that was false or stale: a key was said to be enough for Mana summaries and drafting (README, DEMO, AI_STATUS); `encounter_insertions` for `note_insertions`; retention called "after signing" though it counts from when the audio was stored; "no network access in the service's code" although the model download script uses the network; the recorded consent wording still says "external speech-to-text" | **Fixed in the docs.** The retention label in the code and the command now say what the job does. The consent wording is **recorded as a governance decision, not changed** (ADR 0015 §4.5, CAPTURE_DATA §4) |
| Low. The screens said speech runs "on this computer" even if the clinic had pointed it at another host | **Fixed.** The status carries whether the service is local and, if not, its host; the screens say so; such a run is recorded as external |
| Low. Tests that could not fail the way their names said | **Fixed:** a limited route is used to show another user is not held up; the route table is enumerated instead of guessing URLs; exact statuses and reasons instead of `>= 400`; Mana summaries are counted at the stand-in with a control; the protocol whitelist is tested with a real concatenation list that names a file and an address (with positive controls); decoded frames are counted to show the decode stops at the bound; the phrase that detects capture words at the hosted stand-in is defined once, shared with the speech stand-in. **Not changed:** the egress-off screen test still sets the status from a forged payload, because the end-to-end server runs with egress on on purpose (the real server's behaviour is covered by the API tests) |

### What was left, and why (full list in ADR 0015 §4)

**Documented prototype limitations:** the speech service has no sign-in (a deliberate deployment assumption: it is a sidecar of one API process on one computer); unsandboxed FFmpeg decoding of hostile audio under the user's account; a lost audio part after the browser's four retries is a warning and leaves no gap marker after a reload; a live transcript abandoned by a closed tab is ended by withdrawal, by the next start and by the recorder but not by signing or discarding; very long recordings time out at 180 s per transcription call; pseudonymisation of text for hosted AI is best effort; rate limits are per process and in memory; packages are pinned by version, not by hash.

**Requires a clinical, legal or governance decision (none was made or invented):** whether hosted AI egress may ever be turned on for real consultations, and under what agreement; retention periods; erasure on request or on withdrawal (and how that reconciles with append-only clinical and audit records); encryption at rest and what backups may hold; who may read captured audio and transcripts and the facility-wide AI review list; the consent wording.

## Slice V2: live consultation capture (local speech-to-text, timed transcript, doctor-assigned speakers, important points)

**Basis:** plan item **V2** in [DOCTOR_APP_PLAN.md](DOCTOR_APP_PLAN.md); the decision record is [ADR 0014](adr/0014-local-speech-service-and-capture-pipeline.md), the model card and measurements are [safety/AI_MODELS.md](safety/AI_MODELS.md), the dataset is in [safety/DATASETS.md](safety/DATASETS.md). Nothing here is clinically validated, a medical device or production-ready; all data is synthetic. **It does not build the consultation summary (V3), full Mana (V4), the health band or stethoscope analysis (V5) or thermal ML (V6).**

**Naming:** this is the second slice of the Doctor App plan (V1 was the owner's "Slice 4A").

### What a doctor can do now, and what is real

| Step | State |
| --- | --- |
| Start the consultation, see the consent state | Real (existing consent model; the on-screen wording now says the audio stays on this computer, which **needs a legal and clinical-governance review before any real use**) |
| Start recording | **Real, in a real browser**: needs the patient's recorded consent, a click, the browser's microphone permission and a ready local speech service; each of those states has its own message |
| Pause / resume / stop; recording clock; microphone level | Real (the clock counts recorded time only) |
| Local speech-to-text | **Real**: `faster-whisper` `small` (CTranslate2, int8, CPU) in `services/speech`, on `127.0.0.1:8002`; transcribes each 20-second part after it is recorded |
| Timestamped transcript, language per line, model score | Real; times are on the recording's own timeline |
| Speaker labels | Not identified by any model: **the doctor assigns** Doctor / Patient / Nurse / Relative / Attendant / Other per line; stored as an append-only review |
| Important points (extraction) | **Real, rule-based, on this computer** (`extract-rules-v1`, English only); each point has category, source lines, rules version, time, review flags |
| Confirm / reject | Real; flagged or speaker-guessed points need an explicit tick (enforced by the server) |
| Available to a later summary | `listConfirmedPoints` returns only doctor-confirmed points (no consumer yet) |
| Consent withdrawn mid-recording | Real: the microphone stops, the part in progress is discarded, the recording ends with `consent_withdrawn`, further parts are refused |
| **Not built** | The consultation summary; speaker identification; word-by-word live text; translation; non-English extraction; retention schedule |

### Implemented

**Database (additive migration `0025_capture_v2`; applied to the development, test and e2e databases; the development database was copied first, see below).** `transcript_chunks` (one row per recorded part: offset on the recording, duration from the decoded audio, language, status), `transcript_segment_speakers` (append-only speaker review; trigger-protected like the other evidence tables), new columns on `transcript_segments` (language, model score, no-speech probability, run), `transcripts.end_reason`, `ai_runs.locality / runtime / weights_sha256`, a partial unique index allowing **one live recording per consultation**, and database checks on part offsets and status, end reasons, run locality and speaker labels.

**Local speech service (`services/speech`, Python/FastAPI).** `GET /health`, `POST /v1/transcribe` (multipart audio, optional language), loopback only (it refuses a `Host` that is not a loopback name, has no CORS, no docs routes), model loaded from a directory with the hub offline, audio decoded in memory and never written to disk, text never logged, `task = transcribe` always, voice-activity filter, replies carry the model identity and weights SHA-256. `npm run speech:setup` builds its virtualenv; `npm run speech:model` is the explicit, hash-verified model download (`models.lock.json`); `npm run dev:speech` / `npm run dev` start it. 24 Python tests (one optional test loads the real model).

**API.** `Transcriber` interface with one implementation, `LocalSpeechTranscriber` (loopback enforced, redirects refused, replies schema-checked, errors mapped to words a doctor can act on); provider `none` by default; **the hosted adapter is gone and `AI_STT_API_KEY` is ignored with a warning**; `aiStatus` is asynchronous and health-checks the service (cached 4 s); parts are stored in order with an offset checked against the recording's wall-clock age; a duplicate part is a 409; consent is re-checked on every part, upload, retry and extraction; withdrawal ends the live recording; speaker assignment (`POST /api/transcripts/:id/speakers`) validates that every segment belongs to the transcript and is audited; `GET /api/encounters/:id/capture` (can this consultation record now, and must a recording stop) carries no patient content; `POST /api/transcripts/:id/end`; the extractor defaults to the local rules and the hosted language-model extractor needs `ai.extraction.provider: llm`; confirmed points are read through `listConfirmedPoints`. New facts categories: duration, patient concern, investigation mention.

**Web.** `components/capture/` (Recorder, TranscriptView, CapturePanel): the three-tier presentation in [DESIGN.md](DESIGN.md) §4c; the AI assistant panel keeps note suggestions, recommendations and activity only; the workstation's left column leads with capture at 1400px and up, and the two-column layout at 1280px was mirrored so that capture stays on the left.

**Evaluation (synthetic only).** `data/eval/consultations-v1` (15 scripted consultations, hand-labelled; dev/test split), the extraction harness `apps/api/src/eval/{score,cli}.ts`, offline audio synthesis `synthesise-audio.ps1` (Windows voices), the speech harness `apps/api/src/eval/stt.ts` with a word-error-rate module `wer.ts`.

### Measured results (synthetic data only)

Full tables and caveats: [safety/AI_MODELS.md](safety/AI_MODELS.md); raw: `data/eval/results/stt-v1.md`, `extraction-v1.md`.

| What | Result | Read it as |
| --- | --- | --- |
| Speech model (`faster-whisper-small`), word error rate on synthetic text-to-speech speech, 302 English turns | **1.8 %** (1.7 % development files, 1.9 % test files) | A sanity check on clean, quiet, one-voice audio. **Not** an estimate for clinic audio |
| Language identification (no hint given) | English for 302 of 302 turns | Same caveat; no other language was evaluated |
| Long recordings (3 consultations, 161 to 229 s) | session word error rate 0.6 to 1.5 %; times ordered and inside the audio; median turn-start error 145 to 2,260 ms | The model joins neighbouring turns, so starts can be early |
| Speed on this CPU | 0.13 to 0.17 times real time on long audio; about 5 s per short request; a 20-second part appears about 3 to 7 s after it ends | |
| Important points, **held-out test split** (English, 4 files, 130 gold points), speakers labelled | **precision 75 %, recall 53 %** (speakers unlabelled: 69 % / 43 %) | The honest figure. The rules miss what they do not know |
| Important points, development split (the rules were tuned on it) | 83 % / 89 % (unlabelled 79 % / 69 %) | Optimistic by construction; the gap to the test split is the finding |
| Rules fed the speech model's text instead of the script (12 English files) | recall 75 % -> 63 %, precision 81 % -> 72 % | Transcription errors cost points |
| Negation / hedging / who-said-it on matched points | 99-100 % / 93-98 % / 96-100 % | |
| Hindi and Hinglish text (3 files) | nothing extracted, all lines skipped and counted | Intended for an unsupported language |

**Real model, real browser:** A real Chromium recorded synthetic speech (a WAV played as the fake microphone) and the real API sent it to the real local model (`faster-whisper-small`, new service code): 12 timed English lines ("…I have fever and a dry cough, and my throat is sore also… no, no chest pain…"), important points proposed, screenshot reviewed (`e2e/capture-real.spec.ts`, opt-in, passes in about 50 s). The audio is synthetic text-to-speech: this shows the chain works, not accuracy.

### Tests

- **API** (`npm run test:api`): 36 files: **434 passed, 10 skipped, and one suite (`hospital-seed.test.ts`, a V1 test) that cannot run between about 00:00 and 02:35 local time** because of a time-of-day limitation in the V1 seed, run at 00:55 (see the failures section). New or extended for V2: `capture.test.ts` (31: consent and the recording's lifecycle, timeline and ordering, speaker assignment and its append-only audit, extraction, confirmation and rejection, the raw/extracted/confirmed separation, authorization and facility isolation, no external call, and the security-review regressions below), `speech.test.ts` (26: the local transcriber, loopback enforcement, error mapping), `extract-rules.test.ts` (32, including the held-out test-split floors), `eval-wer.test.ts` (4), plus updated `ai.test.ts`, `ai-clinical.test.ts`, `config.test.ts`.
- **Speech service** (`npm run test:speech`): 31 Python tests (one optional test loads the real model).
- **Web unit** (`npm run test:web`): 30 (3 new: times, language names, the focus store).
- **Thermal** (`npm run test:thermal`): 32 (unchanged).
- **End to end** (`npx playwright test --workers=4`): full run at 4 workers: **160 passed, 21 skipped, 1 failed** (a load-sensitive V1 mobile history test that passes 6 of 6 times alone); the opt-in real-model spec is skipped here. New: `e2e/capture.spec.ts` (consent first and the server refusing too; record, pause, resume and stop with the browser's synthetic microphone; timed lines in order; doctor-assigned speakers that never change the words; extracted drafts; confirm and reject; "Add to note" as a separate act; reload persistence; microphone permission denied; unsupported browser; consent withdrawn mid-recording; local service unavailable; doctor-only access and signed-out access; no request to anything but the app and no transcript text in any address or page title; layout and axe at four widths). Updated: `ai-assistant.spec.ts`, `ai-clinical.spec.ts`. The browser tests use **labelled test stand-ins** (`e2e/mock-speech.mjs`: a fixed synthetic script, no model; `e2e/mock-anthropic.mjs`) so the suite needs no model and no key; the real model is covered by the evaluation and by the opt-in `e2e/capture-real.spec.ts`.
- **Evaluation harnesses** (not in the gate): `apps/api/src/eval/{cli,stt}.ts`.
- **Lint and types:** `npm run typecheck`, `npm run lint` (oxlint, ruff for both Python services): clean.

### Failures found during this slice, and what was done

- **PyAV 19 is incompatible with faster-whisper 1.2.1** (`open() got an unexpected keyword argument 'metadata_errors'`): transcription returned an internal error. Pinned `av==16.0.1` (a ~32 MB wheel) and wrote the reason in `requirements.txt`.
- **The model download script was blocked by its own offline setting** (`HF_HUB_OFFLINE=1` is set when the engine is imported): the downloader now sets the hub online for its single run before importing, and verifies against `models.lock.json`.
- **Extractor:** a negated symptom beside a chief complaint ("No breathing trouble, just the cough") was dropped, and fact text kept trailing punctuation; both fixed after unit tests failed.
- **Development API hot-reloaded new code before the development database had migration 0025**: stopped only my own watcher, took an in-server clone (`adaxai_backup_20261003_pre0025`, row counts verified), migrated the development, test and end-to-end databases (identity confirmed for each), restarted my stack.
- **Found by the browser tests:** when consent was withdrawn mid-recording the explanation vanished together with the recorder (the recorder was unmounted when consent flipped); points whose speaker nobody assigned read "Patient said" next to a guess flag (now "Speaker not assigned: guessed patient"); at 1280 px the two-column layout put the transcript on the right (mirrored so capture stays on the left); the start button stayed disabled after consent was recorded in the screen (status is refetched when consent changes).
- **`e2e/appointments.spec.ts` ("a nurse books, is told a slot is taken…") failed once** in a full run at four workers while other work was using the machine, and passes alone on both projects; it is an existing, load-sensitive test (see the V1 notes) and was not changed.
- **Migration checksum guard:** I added a clean-up statement to the applied `0025` and the migration runner refused it ("modified after it was applied"); the edit was reverted and the clean-up documented as a pre-step instead (ADR 0014).
- **`e2e/history.spec.ts` ("when the history cannot be loaded…", mobile) failed once** in the final full run (a click raced a re-render and the test timed out); it passed 6 of 6 times alone on both projects. A load-sensitive V1 test; not changed.
- **`apps/api/test/hospital-seed.test.ts` (V1) fails between about 00:00 and 02:35 local time.** The seed puts today's appointments at offsets from the clinic's time of day, down to 150 minutes ago; just after midnight those offsets clamp to the same minutes, so a doctor gets two appointments at one time (`appointments_doctor_no_overlap`) or a "no-show" that has not started. **This is V1 code that V2 did not touch** (the file is identical to its committed version); it was written and passed in the daytime. I tried a fix, found it cannot work in general (there is not enough of today left to hold the past appointments), and restored the file rather than ship a half-fix. **Verified only as far as the API gate at 00:55 local: 434 passed, 10 skipped, this one suite failing to start**; re-run it after 02:35. **Update (V2.1): fixed, with the file unchanged and passing inside that window; see slice V2.1.**
- **The ADR claimed protections the service did not have** (Host check, no spooling, log suppression): found by the security review below, now real and tested.

### Pre-commit adversarial review (slice V2)

An independent, read-only adversarial review of the whole slice (consent races, audio and transcript leakage, cross-patient and cross-facility access, external calls, key exposure, speaker manipulation, extraction treated as confirmed, timestamps, concurrent recordings, stale state, resource exhaustion, parsers and injection, the Python service, test hygiene) reported 22 findings. **Fixed, each with a regression test:**

| Finding | Fix |
| --- | --- |
| **Negation lost across part boundaries** ("I do not" / "have chest pain." gave a *positive*, unflagged chief complaint) | Recorded lines that end mid-sentence and continue in lower case from the same speaker are read together (both lines are the source); a line still cut at a boundary is flagged and needs the tick |
| Consent withdrawn *during* transcription still stored the part's text | Consent and visit state are re-checked after the model returns and before storing; the part is marked failed |
| Capture ignored the visit state (a paused visit's recorder kept filling the old record) | The visit must be with the doctor to start, send a part or transcribe; the capture status carries `closedReason` and the recorder stops on it |
| Jobs left "running" forever (refused preconditions, storage errors, restarts) | The job is failed (retryable) in every such path; interrupted jobs are failed at start-up |
| Speaker changed after a point was found: the point stayed confirmable as "patient said" | Server-enforced tick when a source line is now marked as the other side; the screen shows it, also on confirmed points |
| Re-running extraction brought back rejected points and duplicated confirmed ones | Decisions carry forward |
| Quadratic reading time on long unpunctuated text (5.8 s for 50,000 characters froze the API) | Lookbacks windowed, units and typed lines capped; timing tests |
| The service's Host check was not wired; uploads over 1 MiB were spooled to disk; tracebacks were logged by the server | Host and client-header middleware, in-memory uploads, a log filter, tests that forge the header |
| The speech launcher passed every `.env` secret (database passwords, keys) to Python and pip | Allow-listed environment; the launcher refuses a non-loopback bind |
| Consultation audio was playable by nurses | Doctor only (others: not found, audited) |
| The end reason was whatever the browser said | Derived from the consent state |
| Database errors could log the transcript being stored | Logger serializer; typed text with NUL is refused |
| A part could start before the previous one; part numbers unbounded | Ordering check; at most 1,000 parts |
| The recorder retried closed-consultation errors and lost audio, waited a fixed 300 ms before the last part, and stopped at 30 minutes silently | Terminal errors stop the microphone with the reason; the last part is awaited by its stop event; the limit is announced; consent is polled in background tabs |
| Model weights were not compared with the pinned hash at load | Checked at every load |
| Relative / attendant statements read as "Patient said" without a flag | Flagged |
| Timeouts reported as "unreachable"; segment caps silently truncated long uploads | Distinct timeout message; cap raised to 5,000 lines |

**Update (slice V2.1, above): the egress policy, audio content sniffing and the duration bound, rate limits, the migration 0025 pre-flight, ending live recordings on withdrawal and the seed clock were closed there; what remains is classified in [ADR 0015](adr/0015-hosted-ai-egress-policy-and-speech-service-hardening.md) §4.** As recorded at the time of V2 — **not fixed, recorded openly** ([ADR 0014](adr/0014-local-speech-service-and-capture-pipeline.md), [risk register](safety/RISK_REGISTER.md)): transcript text can still go to the hosted language-model service from drafting and recommendations when a key is set (disclosed on screen now; an explicit egress setting is the first item for V3); no content sniffing or decoded-duration cap before audio decode and no sign-in on the service; no rate limits beyond size limits; a lost part leaves no gap marker after a reload; a live transcript abandoned by a closed tab is not ended by signing; audio and text are not purged on withdrawal, discarded consultations keep audio, no encryption at rest (owner decisions); migration 0025 needs a clean-up pre-step on a database with several V1 `live` recordings of one consultation.

### Remaining limitations

- **Everything is measured on synthetic data**; nothing is known about real clinic audio, accents, noise, children or other languages. **English only is supported.** Hindi, Tamil and code-mixed speech were **not** evaluated.
- **Important-point recall is 53 % on held-out text**: the rules miss what is not in their lists. Points are drafts for the doctor; a missing point is not an absence.
- **The speech model identifies no speakers.** The doctor assigns them; until then every point's side is a guess and is flagged.
- **Not word by word:** a part is transcribed after it is recorded (about 3 to 7 s after a 20-second part ends on this CPU).
- **Hosted text egress** from drafting and recommendations (see the review above).
- **Consent wording** changed (audio stays on this computer; the language-model sentence only if drafting is available) and **needs a legal and clinical-governance review**; no consent policy was invented.
- **Retention, erasure and encryption** of captured audio and text are not decided or built.
- **The consultation summary is not built** (V3). `listConfirmedPoints` has no consumer yet.
- **Chromium only** was tested; Firefox, Safari and a real microphone were not.
- **Environment notes for the owner:** the running development stack was started before the service hardening, so restart `npm run dev` to load it; `.env` still holds `AI_STT_API_KEY` (now ignored) and an Anthropic key; `av` is pinned to 16.0.1; the model download is about 486 MB in `.data/models`; the earlier pg-warning task chip (verify.ts) is still open; the secondary-apps branch uses ADR numbers 0013 to 0015 and its own migration numbers, which collide with `main` and must be renumbered by whoever merges second.

### Browser verification

Checked in Chromium (Playwright) at **1440×900, 1280×800, 1024×768 and 390×844** (and the 412 px Pixel 7 project) by `e2e/capture.spec.ts` "layout": no horizontal overflow (the shared `expectNoHorizontalOverflow` check), both capture cards inside the page width, at 1440 px the note to the right of capture, axe WCAG 2.2 AA clean in the recorded, empty-consent, microphone-denied and layout states; the screenshots it writes (top of the consultation, the capture cards, the points, one point card, at each width) were looked at. **At 1440 px the left column is 20 rem wide, so point cards are tall** (flags and the confirmation tick take lines); that is deliberate. **A real microphone and browsers other than Chromium were not tested.** A real Chromium recorded synthetic speech (a WAV played as the fake microphone) and the real API sent it to the real local model (`faster-whisper-small`, new service code): 12 timed English lines ("…I have fever and a dry cough, and my throat is sore also… no, no chest pain…"), important points proposed, screenshot reviewed (`e2e/capture-real.spec.ts`, opt-in, passes in about 50 s). The audio is synthetic text-to-speech: this shows the chain works, not accuracy.

## Slice 4A (plan item V1): know the patient — history, today's patients and the consultation workstation

**Naming:** the owner's "Slice 4A" is plan item **V1** in [DOCTOR_APP_PLAN.md](DOCTOR_APP_PLAN.md). The earlier "slice 4a" in this file (authentication and application entry) is a different, already committed slice. **Basis:** [DOCTOR_APP_AUDIT.md](DOCTOR_APP_AUDIT.md) found that a doctor consulting saw names only: no conditions, no medicine list, no results, no earlier consultations. This slice adds them end to end (database, API, authorization, audit, screens), a synthetic hospital dataset that goes through the real API, and the consultation workstation described in [DESIGN.md](DESIGN.md) §4b. Decisions: [ADR 0013](adr/0013-patient-history-typed-by-staff-never-deleted.md). What is real in the AI features, with evidence: [AI_STATUS.md](AI_STATUS.md). Hazards: [safety/RISK_REGISTER.md](safety/RISK_REGISTER.md); datasets: [safety/DATASETS.md](safety/DATASETS.md).

**It adds no AI, device, thermal or booking function, and changes none.** Nothing here is clinically validated, a medical device, or production-ready; all data is synthetic.

### Implemented

**Database (two additive migrations)**

| Migration | What it changes |
| --- | --- |
| `0023_patient_history` | `patients.data_origin` (`unspecified` / `synthetic` / `clinical`; records in a facility named "(synthetic)" backfilled as synthetic); tables `patient_conditions`, `patient_medications`, `investigation_results` (who entered, when, `source`, `data_origin`, status, reason) and `patient_history_events` (append-only change log); triggers that make an entry's **content immutable and undeletable** (only status, its reason and a medicine's stop date may change; "entered in error" is final; error code `AX008` → HTTP 409 `history_entry_locked`); partial unique indexes against duplicate open conditions, current medicines and final results; `meta.append_only_tables` registration of the change log |
| `0024_history_guards` | Written after review, so 0023 (already applied to the development database) was not edited: a medicine marked as entered in error keeps the stop date it had; `TRUNCATE` of the three entry tables is refused by trigger for everyone including the superuser |

**API:** `GET /api/patients/:id/history` (one read model: active allergies, conditions, medicines current-first, results — the 30 most recent plus the newest of every test — signed consultations, latest value of each vital sign with time and source; counts of what is not returned); `POST /api/patients/:id/conditions | medications | investigations` and `…/:entryId/status`. `history:write` is a doctor's permission; doctors and nurses read; administrators are refused; another facility's patient, or an entry that is not this patient's, is "not found" and the attempt is audited with its reason. The API computes a result's flag (a number that disagrees with the result as it reads is refused), takes an entry's origin from its patient, and writes the change-log row in the same transaction. A production deployment must state `DATA_ORIGIN`. The audit log holds ids and statuses, never the clinical text.

**Synthetic hospital dataset** (`npm run demo:hospital`): 12 fictional patients, 2 extra staff, histories and today's queue and schedule in every state, all made through the real API in-process; idempotent, resumable, and it refuses to run in production, outside a synthetic deployment or facility, or beside a patient marked clinical ([DATASETS.md](safety/DATASETS.md)).

**Doctor App screens:** *Today's patients* (tabs with counts, day picker, row menu, allergies on every row); the doctor's Home with real counts and the day in time order; the **consultation workstation** (header with "Draft · in progress" and elapsed time, patient banner with allergies and severity, vital-sign tiles with time and source, **Past history** with five tabs, a rule-composed patient summary labelled "not AI-generated", the profile side sheet, and the existing AI and capture panels); doctors add, stop and correct history entries. Accessible tabs and menu components. See DESIGN.md §4b for each part.

### Tests

New or extended: API `history` (26 tests: permissions, facility isolation and audit, validation, duplicates, status changes, the result flag and number rule, newest-per-test, read model, database triggers incl. TRUNCATE and the medicine stop date), `hospital-seed` (10: dataset consistent, today's queue in every state, history read back, signed records verify, idempotent, **resumes a half-done run**, recognised by name and birth date, class-aware allergy check, refuses production / non-synthetic / clinical beside it / unmarked facility), `config` (production requires `DATA_ORIGIN`); web unit `vitals` (4: the latest reading of each kind, status, the facility's clock); end-to-end `history.spec.ts` (see the table below).

### Verified test results (slice 4A, 3 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:api` | 32 files, **352 passed**, 0 failed (before this slice: 30 files, 315). An earlier full run on the same tree had two files time out while the machine was loaded (the migrator suite's clean-up hook at 60 s and the reset-command test at 30 s; both passed alone in 27 s, and the full suite then passed in 408 s). The reset-command test also had to be told to state `DATA_ORIGIN` for a "production" install, which is now required |
| `npm run test:web` | **27 passed** (before: 23) |
| `npm run test:thermal` | **32 passed** |
| `vite build` | succeeds (the usual chunk-size notice) |
| `npx playwright test --workers=4` | **150 passed, 0 failed, 0 flaky, 14 skipped** on the final tree (7.1 min; slowest test 40.7 s of the 60 s default). Run with four workers, not the default six, see below. The skips are by design: the nine screen-width layout tests on the phone project (they set their own sizes), the desktop-only keyboard test in `auth` and two in `entry` on the phone project, and the drawer test on desktop and the table-width test on the phone project in `doctor-home`. Desktop and phone profiles both run everything else, with axe (WCAG 2.2 A and AA) on every screen the specs visit |

**About the end-to-end suite and load.** The suite (164 tests over two projects, one API process and one database) is load-sensitive on this machine. Three full runs at the default six workers during this slice each had two to four failures. Some were real and are fixed (the Home row cap and the shared-database clean-up, below); the rest were **timing failures, a different set each time**, in tests that passed alone (for example `doctor-workflow` 25 s alone, 86 s under load; an `entry` sign-out test 35 s alone; the `consent` journey; a sign-in focus check). I did not raise any timeout to hide them, except: two of this slice's own tests that wait for the data layer's retry back-off (1 s and 2 s) got an explicit 120 s budget, as `consent` and `devices` did before. Reducing the load (four workers) gave a clean full run; the cause is one single-threaded API process that every test, and every password check, goes through. **Treat the default six workers as unreliable on this machine, and a failure in a long test as a reason to re-run it alone before suspecting the product.** Real defects the runs did expose are in the table below.

### Dev-environment actions (what I did to the development stack, and what was protected)

- The development database `adaxai` was **not reset**. Before migration 0023 it was copied inside the server to `adaxai_backup_20261003_pre0023` (`CREATE DATABASE … TEMPLATE adaxai`; row counts matched: 5 patients, 4 users, 7 visits, 6 encounters of which 3 signed, 832 audit events, 23 migrations). It is kept. The last cold file backup is `backups/adaxai-2026-10-03T02-41-04` (before migration 0022); backups are not in Git.
- Migrations 0023 and 0024 were applied to `adaxai`, `adaxai_test` and `adaxai_e2e` by the migrator, which checks each database's recorded identity first. The test database was once rolled back by an identity-guarded script to apply a corrected 0023 before it reached the development database.
- `npm run demo:hospital` was run on the development database once (12 patients, 2 staff) and again after the seed was hardened (it changed nothing). The shared PostgreSQL server was never stopped. The development API and web server of this checkout were restarted once (the API had briefly run new code before the database was migrated); the second working copy `ADAXAI-MVP-secondary` (nurse, patient and admin apps, its own databases and ports) was not touched. Expect merge work with it in `apps/web/src/lib/nav.ts`, this file and the migration numbering.
- The seed's patients created on the development database before the phone range was changed keep their original numbers (`9000100001`…); new databases get numbers from a range no operator issues.

### Failures found during this slice, and what was done

| Failure | Classification | Action |
| --- | --- | --- |
| A CHECK constraint would have turned "stopped → entered in error" into a server error | **Product defect** (found by a database test) | Relaxed in 0023 before it reached the development database |
| Home hid ready patients behind a row cap; completed visits cluttered it | Product defect | Ready and in-room patients are always listed; completed and closed are in the counts and under Today's patients |
| An actions menu closed on a late scroll event, and could be clipped by its card | **Product defect** | Portal, `preventScroll`, follows its button |
| A row menu opened from the profile sheet was inert (everything outside a modal dialog is) | **Product defect** found in review, reproduced by a new test that fails without the fix | The list is drawn inside the dialog that holds its button, with the sheet's transform measured |
| Enter pressed twice saved twice | **Product defect** found in review | A synchronous single-flight latch; test fails without it |
| The e2e suite shares one database: tests that left patients "ready" pushed other specs' rows off Home; extra sign-ins hit the per-account rate limit; two assertions passed only because other tests had left someone in the room; two waits were shorter than the data layer's own retries | **Test defects** (not weakened: each test now cleans up, shares one API session per account, asserts on the patient rather than the list, and waits for the retry window it is about) | See the spec |
| Playwright's service worker hid `page.route` | Test infrastructure | Contexts with the service worker blocked |
| Home hid a booked appointment when eight or more patients were ready (it always lists those, then fills to eight rows) | **Product design gap** found by the end-to-end run | The next three other rows now always stay in view, however many are waiting; DESIGN.md updated |
| `record-lifecycle` asserted on the record's page while the list was still on screen (the address changes first; 34 "Signed …" lines matched, and a strict-mode match failure is not retried) | **Test defect** (a race in a slice 3 test, exposed by load) | Waits for the record's own heading first |
| A pg deprecation warning ("query while another is running") during the seed test, from existing verification code that runs queries concurrently on one transaction client | **Existing defect**, not from this slice | Flagged as a separate task; not changed here |

### Pre-commit adversarial review (slice 4A)

**Method:** read-only reviewers as in earlier slices: round 1 one on the API and database, one on the web screens (both asked to break authorization, isolation, audit, immutability, clinical safety of what a doctor sees, accessibility, responsive layout and test quality); round 2 one on the fixes. Their reports are theirs; I checked each finding against the code before acting. Round 2's fixes were **not re-reviewed by a further round**.

**Round 1, found and fixed:** a result's flag could disagree with the value shown (a "number" field separate from the text); the newest result of a test could fall off the list behind a long run of another; `DATA_ORIGIN` defaulted to synthetic in production and the seed's guard was weak (guards added, entries now take the patient's origin); a NUL character, a year-0000 date and reactivating a resolved condition beside an open one were server errors, now messages; an entry that was not the patient's was refused without being audited; `TRUNCATE` and a medicine stop date slipped past the triggers (0024); the seed was not transactional or resumable and recognised patients by phone; the banner could show a stale or failed allergy list as current; the three-column layout squeezed the editors at 1400–1535px (now container queries, measured at nine widths); entered-in-error dialogs did not say which entry; the UI claimed each entry names who entered it but did not show it; long names overflowed the banner; the vitals badge counted superseded readings; the allergies and the save state left the screen when scrolling (patient strip; bottom action bar below 1024px; allergies at prescribing and signing); walk-in times used the browser's clock; "Completed today" used the AI colour; duplicate element ids, dangling `aria-controls`, an ambiguous "Hide" button.

**Round 2, found and fixed:** a result the system could not compare looked the same as a normal one (now "Not compared with a range", and the summary says so); row menus inert inside the profile sheet; the bottom bar's room was a guess (now measured; capped at 45% of the screen); a NUL in a status reason; a blood-pressure tile pairing two times under one; equal-time vital signs ordered differently by the API and the screen; an offline refresh not flagged as stale; the summary listing superseded abnormal results; the audit detail carried a clinical classification (the flag); the seed's two-step entries (a status change, a stop) were not completed on a re-run and its facility guard did not cover the accounts it acts as.

**Accepted and documented:**
- A background refresh of the history (every two minutes while a consultation is open, and on window focus) is audited like any read, so those reads cannot be told from deliberate ones in the audit log.
- A seed run that fails *inside* an earlier consultation, between its visit and its signature, leaves an unsigned draft the next run does not clean up (discard it in the app first). Stated in the seed's header.
- `TodaysPatientsPage` keeps "today" until the data refreshes (stale across midnight), and the dialogs' default dates are the browser's, not the facility's.
- The tab-count assertion in the end-to-end suite is a lower bound (counts change under parallel tests).

### Remaining limitations

- **Everything in the history is typed in by staff.** No laboratory or pharmacy feed, no coded terminology, no verification against a source document, no reconciliation step, no interaction checking. Only doctors write.
- **A result is compared with a range only if it is a plain number with limits** (or has a reading); anything else says it was not compared.
- **No allergy-versus-prescription check** in the prescription editor (the allergies are shown beside it; the screen says no checking is performed).
- **Allergies are not under the same immutability rules** (existing behaviour).
- **Not built, on purpose** (each shows "not available yet" or is absent): live transcription lines, key points, waveform, live stethoscope, vital-sign sparklines, the writing pad, the AI consultation summary.
- **Not evaluated:** the screens have not been tried by clinicians; Firefox, Safari, real devices, a screen reader by hand, high-contrast mode and zoom beyond the automated checks were not covered.
- This development machine's `.env` has both hosted AI keys set (see AI_STATUS.md): a decision for the owner.

### Browser verification

Automated (Playwright, real Chromium, desktop and a 412 × 915 phone profile): the workstation at **1920, 1536, 1440, 1400, 1399, 1280, 1024, 768 and 390 px** — column count, no horizontal overflow, every diagnosis and prescription field at least 110 px wide and inside its card, axe (WCAG 2.2 A and AA) with no violations; the header and row menus (inside the screen, against their buttons, in the profile sheet), the patient strip and bottom bar, keyboard use of tabs and menus, and the error and stale states with forced failures. Looked at by eye: screenshots from the development web server at 1440 × 900, 1280 × 800 and 390 × 844 (home, today's patients, consultation top and scrolled, profile sheet).

## Slice 4a: authentication and application entry

**Why now:** the shared sign-in page failed with **"Request failed (502)"**, and there was one generic page for doctors, patients and administrators. This slice makes the front door clear and stable before the consultation workspace is redesigned. It adds no clinical, AI, device, booking, reminder or reporting function. Decisions are in [ADR 0011](adr/0011-application-entry-three-front-doors-one-authentication.md); the screens are in [DESIGN.md](DESIGN.md) §4a.

### The 502: root cause

**Where it came from:** the development proxy, not the API's authentication. The browser talks to the Vite server (port 5173), which forwards `/api` to the API (port 4000). **Nothing was listening on 4000.** Vite then answered with an empty 502, and the client, which found no error message in the body, printed "Request failed (502)". The Vite log held `ECONNREFUSED 127.0.0.1:4000` for these requests.

**Evidence:** the dev stack I had started earlier in a time-limited background task was ended at that limit, which left an orphaned Vite process (started 8:11 am) and no API. The API's last "Server listening" line was at 9:24:28; a restart at 10:22:34 produced no listener; the first logged refusal was at 3:00 pm. With the current code the API starts and listens normally (checked), and the sign-in paths were exercised afterwards (below). The account, session creation, lockout and rate limits were not involved: the request never reached the API.

**Not proven:** why the API process first ended. The logs show that it did and when it could not be restarted, not what ended it. The orphaned Vite was my own earlier launch; I did not find a defect in the API's startup.

**Fixed in the product, not only by restarting:**
- The API client treats a gateway answer with no usable body (502, 503, 504) as "service unavailable".
- The Vite proxy answers a refused connection with `503` and a JSON message that names the problem. It logs one line with the error code and target; Vite's own log line (which includes the URL and so any query string) is suppressed, in dev and in `vite preview` (smoke-tested in both on a spare port with the API absent: 503 JSON, a marker placed in the query string appeared nowhere in the server output).
- The sign-in pages say "Sign-in is temporarily unavailable" with **Try again**; the front door asks the public `GET /api/ready` and says so before anyone types.
- Operationally: the dev stack was restarted detached (API 4000, web 5173, thermal; log `.data/dev-stack.log`, git-ignored). The README's Troubleshooting covers an orphaned Vite holding the port.

### Implemented

**Front door** (`/login`): "ADAXAI / Connected Healthcare Intelligence Platform" with three application cards, each with who it is for, what it really offers (only features the product has), and its button: **Continue as Doctor / Patient / Admin**. The cards are guidance, not permissions.

**Three sign-in pages over one authentication:**

| Page | Heading | Field | Signs in |
| --- | --- | --- | --- |
| `/login/doctor` | Doctor Portal: "Secure access to your clinical workspace." | Doctor username | doctors and nurses (each lands in `/doctor` or `/nurse`) |
| `/login/patient` | Patient Portal: "Secure access to your health information." | MRN (the existing patient sign-in; first visit: `/activate`) | patients |
| `/login/admin` | Admin Portal: "Secure facility administration." | Admin username | administrators |

No page links to another application's sign-in. There is no "Forgot password" link, because the product has no self-service reset; each page says who can reset it.

**API:** `LoginRequest.application` (optional). A correct password at the wrong door is **403 `wrong_application` with no session and no cookie**; it is audited once, with the account and the application asked for. Unknown, inactive, wrongly-passworded and withdrawn-consent accounts still get the one uniform 401 whichever door is named. Everything else in sign-in is unchanged.

**Web:** role-aware landing (the role the API reports decides; the chosen application never overrides it); a "you are signed in as …" notice instead of a silent move; a plain "no access" page instead of a silent redirect (this changed an existing behaviour: a patient opening a staff address used to be sent home; `patient-portal.spec.ts` and DEMO.md were updated); `next` honoured only for the signed-in role's own pages; a session that ends in the middle of use shows "Your session ended"; sign-out clears everything cached, including a finished mutation's variables (a password among them); a failed sign-out says the person is still signed in; every tab or window re-checks who is signed in when looked at again, and a different person's sign-in rebuilds the page.

**Errors** (`describeSignInError`): invalid credentials, locked, rate limited, wrong application, forbidden, service unavailable (with Try again), network failure, server error, unexpected. No status code, no trace, nothing that tells accounts apart.

**Components:** `ApplicationCard`, `ApplicationBadge`, `AuthShell` (with `AuthHeader`, `BackToApplications`), `LoginForm`, `PasswordField`, `ErrorBanner`, `ServiceStatus`, `SignedInNotice`, `NoAccessPage`.

**Migrations:** none. No database change.

### Tests

New or extended:

| Layer | What |
| --- | --- |
| API (`auth-entry`, 6 tests, plus `auth`) | Each role at each door; the wrong door refuses with no session or cookie and one attributed audit row; failures at the wrong door still lock; a locked account stays locked at any door; a withdrawn portal is invalid credentials at any door; an unknown application is a validation error; omitting the field works as before |
| Web unit (`entry`, `session`, `focus`: 18 tests) | Every failure has plain words and a retry only for service problems; one answer for wrong password, unknown user and switched-off account; `next` accepted and refused cases (encoded dots and slashes, `/print` for non-clinical roles); the role-to-application map equals the API's; a gateway answering for a missing API is never "Request failed (502)"; who is signed in: a different person drops the last one's cache, a failed or unreadable answer changes nothing, **a check overtaken by a sign-in, sign-out or password change is dropped** (each race test fails if its guard is removed, checked by hand); a replaced session clears every mutation; the extra focus events re-check the session only |
| End-to-end (`entry.spec.ts`, 25 tests on each of desktop and phone; 2 skipped by design on the phone project) | The selector and each door; the four screen sizes (one test per size) with axe, overflow, touch targets and card layout; each role signs in and lands in the right place; wrong password, unknown user, switched-off and locked accounts; service down or failing (502, 503 with the proxy's words, lost connection, 429, 500) with retry; the front door's own status; the busy state and a single request; wrong-door refusals with no cookie and no session; signed in at another door; cross-role direct URLs with the API's 403s; doctor and nurse at each other's pages; `next` safety; session reload, sign-out, expiry in the middle of use and after a reload; another tab signing out or a different person signing in (different role, and the same role: the page is rebuilt, typed text gone); a re-check that cannot be answered keeps the person's page; edits waiting to be saved are not sent as a different person (fails if the guard is removed, checked by hand); failed sign-out on every page that signs out; a forged wrong-role answer; every notice and error state at 1280 and 390; keyboard use; activation and the withdrawn-portal notice |

### Verified test results (slice 4a, 3 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:api` | 30 files, **315 passed**, 0 failed (before this slice: 29 files, 309) |
| `npm run test:web` | **23 passed** (before: 5) |
| `npm run test:thermal` | **32 passed** |
| `npx playwright test` | **115 passed, 0 failed, 0 timed out, 5 skipped** in the final full run (6.8 min). The five skips are by design: the desktop-only keyboard tests on the phone project (`auth`, `entry`), the notice-and-error layout test on the phone project (it sets its own sizes), the drawer test on desktop and the table-width test on the phone project (`doctor-home`). Earlier full runs on this slice: 101 passed + 2 failed (the `patient-portal` expectation above), then 108 passed + 1 failed (the layout test above); each failure was fixed at its cause and the suite re-run in full. **The slowest test in the final run took 59.0 s of the 60 s default** (`consent.spec`, a long multi-role journey: 33 s alone, 30 s, 57 s and 59 s in three full runs on six workers); it now has an explicit 90 s budget, as `devices.spec` already had, and was re-run alone afterwards (passed on both projects). That change was made after the final full run and is timeout-only. |
| `vite build` | succeeds |

### Verified by hand on the development stack

One sign-in attempt per role, with the password read from `.env` by the script and never printed (no repeated attempts): `dr.meera` signed in at the Doctor App and landed in `/doctor`; `admin` at the Admin App landed in `/admin`; each session survived a reload; sign-out ended the session at the server (`/api/auth/me` returned 401 afterwards). **The patient flow was verified only in the end-to-end suite**, with a fixture patient activated through the API; no patient account in the development database was used.

### Failures found during this slice, and what was done

| Failure | Classification | Action |
| --- | --- | --- |
| The 502 | Environment (API absent) plus a **product defect**: the app could not say so | See above |
| After sign-out the page still showed "you are signed in" and `/doctor` redirected to the doctor sign-in | **Product defect** (clearing the query cache detached the page that was showing it) | The `me` entry is updated in place and every other query is removed; sign-out goes to the front door; tested |
| The "exit hint" that sends a signed-out person to the right page was consumed on first read and React's double render lost it | Product defect | The hint is read without consuming and goes stale after five seconds |
| `auth.test.ts` hit the sign-in limit (30 a minute per account) after more tests were added | Test setup | New tests moved to `auth-entry.test.ts`; no limit changed |
| Several e2e failures: labels with a required marker, `toHaveURL(/\/doctor$/)` also matching `/login/doctor`, a session-expiry test that triggered no request, lock tests sharing the demo accounts | Test defects | Matching anchored to the whole path, a request triggered, throwaway accounts; no assertion weakened |
| `patient-portal.spec.ts` (both projects) expected a patient at `/doctor/queue` to be sent to `/patient` | **Deliberate behaviour change** of this slice (a plain no-access page instead of a silent redirect) | The test now asserts the no-access page, no staff shell, and the unchanged API refusals; DEMO.md updated |
| The four-size layout test was one test and reached the 60 s budget in a fully parallel run (once; 38 s alone) | Test size, not a product fault | Split into one test per size; no timeout changed |
| A wrong-application refusal wrote a second, unattributed "access denied" audit row | **Product defect** found in review | The refusal marks itself audited; tested |

### Pre-commit adversarial review (slice 4a)

**Method:** read-only reviewers, as in slice 4: one on the API change and one on the web change (round 1), then one on the fixes (round 2), then one on those fixes (round 3). Each was asked to try to break role confusion, privilege escalation, direct URLs, session leakage, redirects, cross-door sign-in, account enumeration, credential exposure, sensitive logging, rate-limit bypass and facility isolation, and to refute its own findings; I checked each finding against the code while fixing it. The counts are the reviewers' reports; no separate skeptic agents were run. The last round found no defect in the epoch and session-switch core; its findings were fixed and **were not re-reviewed by a fourth round**.

**Round 1, found and fixed (with a regression test each):**
- The wrong-door refusal was audited twice, once unattributed (API).
- Sign-out showed the signed-out page even if the request had failed while the cookie stayed valid: only a confirmed sign-out (or "no session") counts.
- A patient who withdrew portal access was signed out in a way that left the page showing them.
- `next` accepted `/print/…` for any role and percent-encoded dots and slashes.
- The doctor-to-nurse no-access page said "cannot access the Doctor App".
- The proxy claimed "the API is not running" for any proxy error, and Vite's own log line included the request URL; the dev and preview servers sent no frame protection (now `X-Frame-Options: DENY` and `frame-ancestors 'none'`).
- A session for the wrong role, if one ever came back, was ended in the form, not where it was received (now in the sign-in mutation).
- Auth queries paused silently when the browser believed it was offline.

**Round 2, found and fixed:**
- A tab kept the previous person's data and typed text when a *different person of the same role* signed in from another tab (the guard now keys the page by the person, so it is rebuilt).
- A check of the session that was already on its way could overwrite a newer sign-in, sign-out or password change (an epoch counter now drops such an answer).
- The re-check fired only on `visibilitychange`, so switching between two visible windows did not trigger it (window focus and a restored page now do).
- `vite preview` still logged the URL-bearing proxy line; the sign-in mutation kept the typed password in memory for five minutes after a failure; a status region wrapped an alert; several test gaps (failed re-check, failed sign-out on other pages, `safeNext` shapes).

**Round 3, found and fixed:**
- Rebuilding the page for a different person ran cleanups that sent requests under the *new* person's session: the consultation's last autosave, the recorder's last audio chunk and the assistant's recorded upload. Each now checks that the person is unchanged (tested for the autosave; the other two are checked by reading and typecheck only).
- Widening the focus handling to every query would have multiplied requests and audited reads on every window focus: the extra events now re-check the session only.
- Other mutations (activation, password change, a temporary password) also kept passwords for five minutes: no mutation is kept once nothing shows it.
- An unreadable 200 or a 204 from `/auth/me` was read as "nobody is signed in": it is now a failure that changes nothing.
- The preview-server log hook disabled Vite's own "no dist folder" check: it is now one `configResolved` hook.
- Keyboard focus was lost when the page was rebuilt for a different person: it now moves to the main region. Test gaps (a "not shown" check passing before the page rendered; an optional assertion).

**Accepted and documented:**
- A request the *first* person had already sent when another person took over can finish afterwards and write its result into the cache (a mutation's `onSuccess`); the data belongs to the first person and the next read by the new person refetches, but this was not shown for every query.
- A toast naming a patient can outlive a person switch by up to four seconds.
- Existing before this slice: the failed-attempt counter for unknown usernames is in memory with a 10,000-entry limit, so enough attempts to evict entries could show, by when a lock stops, that a name did not exist; a person who knows a username can lock that account for 15 minutes with five wrong passwords.

### Remaining limitations

- **Not a second security layer.** The doors are a courtesy; the API decides on every request. Calling the API directly skips them and gets the same refusals.
- **No self-service password reset, no multi-factor authentication, no single sign-on, no TLS** (local single-machine product), no concurrent-session limits.
- **Nurses sign in at the Doctor App.** There is no nurse door; this is a decision to confirm.
- **The `application` field is optional**, so scripts and older clients keep working; only the web app always sends it.
- **No framing protection in a production host:** only the dev and preview servers send it, and this repository has no production web host.
- **The cause of the API's first exit (the 502 trigger) was not established.**
- **A disabled account is told "invalid", by design** (account enumeration), with a pointer to an administrator.
- **Not checked:** Firefox, Safari, real devices, a screen reader by hand, high-contrast mode, zoom beyond the default.

### Browser verification

**Automated:** Playwright drove real Chromium at **1440 × 900, 1280 × 800, 1024 × 768 and 390 × 844** on the selector and the three sign-in pages: card layout (one row from 768 px up, stacked below), no horizontal overflow, 44 px targets for every way in and every Sign in button, and axe (WCAG 2.2 A and AA) with no violations. Every notice and error state was checked the same way at 1280 and 390. Keyboard order (skip link, way back, fields, password toggle, Sign in), visible focus, Enter to submit and the show/hide toggle were driven by key presses.

**Looked at by eye:** screenshots of the selector at 1280 × 800 and 1024 × 768, the Doctor sign-in at 1280 and the Patient sign-in at 1024, taken from the development web server (no sign-in attempted); earlier in the slice, the selector and a sign-in page at 1440 and 390. The Admin sign-in, the activation page, the no-access page and the notice and error states were checked only by the automated layout and accessibility tests, not by eye.

## Slice 4: appointments, check-in, schedules and notifications, and the design foundation

**Basis:** the existing visit queue, roles, consent, audit and portal code. Before this slice there was no appointment of any kind and no notification mechanism. Decisions are in [ADR 0010](adr/0010-appointments-visit-linkage-and-notification-outbox.md). The UI work follows a design brief with a reference mock-up of a clinical “Doctor App”; its audit, tokens and components are in [DESIGN.md](DESIGN.md).

### Implemented

**Appointments** (staff book; check-in is the only link to a visit):
- Book, reschedule, cancel (with a reason) and mark *did not attend*, on the **facility's clock**. A time that does not exist (a daylight-saving gap) is refused, never moved.
- A doctor and a patient cannot hold overlapping slots: database exclusion constraints, not just API checks. Rescheduling books a new appointment and closes the old one as *rescheduled*; closed rows are frozen; nothing is deleted.
- Status history for every change (who, how, why), written by a database trigger.
- **Check-in** creates or joins **exactly one visit** (idempotent, safe against double clicks, a walk-in racing it, and two staff at once). It starts no consultation and does not mark the patient as with the doctor. A checked-in appointment then follows its visit: *completed* when the consultation is signed, *cancelled* or *no-show* when the visit is closed in the queue.
- Doctors' and nurses' schedules (today, upcoming, past, one date; a doctor can limit it to their own patients) and an administrator's schedule **without patient identity or free text** (administrators cannot change anything). Another facility's appointment is “not found” and the lookup is audited.
- The patient portal shows the patient's own appointments and messages. Patients cannot book or cancel.

**Notifications** (an outbox with one real channel):
- One message per appointment event (booked, moved, cancelled), queued in the same transaction as the change, then delivered. **The only channel is the patient portal. No SMS, email or push is sent or claimed.** A message to a patient without a portal account (or whose portal consent is withdrawn) is recorded as *not delivered*, with the reason, and can be retried.
- Each attempt is made exclusively (a row lock held for the whole attempt) and recorded; retries cannot deliver twice; a channel that fails cannot fail a booking and its error text is not kept; messages hold times, the department and the clinician's name, never the reason or a diagnosis.
- Only a message that still holds is retried (not “booked” for an appointment that was moved).
- Staff are told whether the patient was told: in the message after a booking, move or cancellation, and on the schedule for a cancellation or a failed message.

**Design foundation and UI** (current slice only; see [DESIGN.md](DESIGN.md)):
- Tokens: restrained blue, type scale, radii, control and row sizes, elevation, one focus ring; control edges at 3:1.
- Components: `AppShell` (sidebar, top bar with patient search for doctors and nurses, user, role and clinic; phone drawer with focus handling), `StatCard`, `PatientAvatar`, `AppointmentTable`, `SegmentedControl`, `ConfirmationDialog`, `LoadingState`, `ErrorState` (with retry, or a plain refusal), and refined `Badge`, `Card`, `EmptyState`, `Button`, `Form`, `Dialog`, `Toast`.
- Screens: the doctor's **Home** (four real counts, today's schedule, patients ready, shortcuts), the **Appointments** pages and dialogs for staff, the patient record's appointments card, the portal's appointments page, and the queue's appointment line. The doctor's OPD queue moved to `/doctor/queue`.
- Favicon, PWA icons and the theme colour follow the new brand colour.

**Migration** (additive: no existing row is changed or removed):

| Migration | Contents |
| --- | --- |
| `0022_appointments_and_notifications` | The `btree_gist` extension. `appointment_ends_at()`. Tables `appointments`, `appointment_status_events`, `notifications`, `notification_attempts` with checks and unique and exclusion constraints. Triggers: status history, state machine and freeze, facility membership of patient, department and doctor, a checked-in appointment following its visit, and a guard on what a notification may change. The two history tables are registered as append-only. |

**Migration safety:** the development database held data. A cold backup (`backups/adaxai-2026-10-03T02-41-04`, not in Git) was taken with the app stopped and **read back and verified** before 0022 was applied to it. Applying it also took the test and end-to-end databases to 0022 (each runner confirms the database's identity first). The audit chain verified intact afterwards. One unplanned event: stopping the dev services for the backup also stopped PostgreSQL uncleanly; it was restarted, crash recovery completed, and only then was the backup taken and verified.

### Not implemented, or needing a decision

- **No external delivery.** SMS, email and push are not built and nothing is claimed. A patient without portal access is not told by any other route; staff are told so, and must tell the patient.
- **No scheduling model.** No clinic hours, clinician calendars, department capacity, recurring appointments or waiting lists. Patients cannot book or cancel. No reminders (nothing schedules them). A missed appointment is marked by staff, not automatically.
- **Conservative defaults, not clinical policy:** 5-minute start marks, lengths of 10, 15, 20, 30, 45 or 60 minutes, up to 180 days ahead, check-in only on the appointment's own day. A clinical owner should confirm them.
- **Audit volume from polling.** Every read of the schedule list is audited with the patients it disclosed, and an open page refreshes it every 60 seconds while visible. A day left open on one screen adds about 60 events an hour. The chain lock under that load has not been measured.
- **Booking waits are queued on advisory locks.** Many simultaneous bookings for one doctor make later ones wait for a pooled connection each (the pool is 10). It was not load-tested.
- **Check-in racing a booking.** In theory PostgreSQL can end one of them as a deadlock; the answer is a 409 “try again”, and nothing is saved.
- **A key-reuse conflict raised while handling another error is not audited** (the initial one is not either).
- **Design.** Only the shared foundation and the current slice's screens were redesigned; every other page just inherits the tokens (see [DESIGN.md](DESIGN.md) §7). No web font is bundled. The consultation workspace is the recommended next slice. The patient-profile panel from the brief was not built (nothing needs it yet), and Reports, Settings, a Mana AI page and a notification bell were not built because the product has nothing behind them.

### Tests

New API tests (**56**):

| File | Tests | Covers |
| --- | --- | --- |
| `appointments-db` | 11 | Exclusion constraints for doctor and patient (half-open slots, release on close), the state machine in the database equals the contract's, frozen closed rows, history and the visit trigger, what a booking must look like, concurrent raw inserts |
| `appointments` | 25 | Booking validation field by field, time zones and date boundaries (including a nonexistent and a repeated clock time), the schedule by role, administrator redaction, cross-facility refusal and audit, rescheduling, cancelling, did-not-attend, check-in (one visit, idempotent, concurrent, against a walk-in, wrong day, following its visit), the patient's list |
| `appointments-concurrency` | 5 | Twin reschedules with one key, the same key for two bookings, eight bookings for one slot, swapping two back-to-back appointments (never a deadlock), a year-0000 date |
| `appointment-notifications` | 15 | Undeliverable, retry and delivery, simultaneous retries, a retry while an attempt is in flight, a half-recorded attempt rolls back whole, a failing or throwing channel (no content in logs or audit), withdrawn consent, stale messages not retried (also under the lock), message content, the patient's own view, inbox order and the hidden booking reason, a missed appointment not shown as upcoming |

New end-to-end tests (**20 runs**: 10 tests on desktop and phone):
- `appointments.spec.ts` (4 journeys): book, a taken slot, reschedule, cancel; check-in to the queue and to completion; the portal message undelivered, retried, read; the administrator's view.
- `doctor-home.spec.ts` (6 tests): Home from real data and its shortcuts; patient search from the top bar; the phone drawer; loading, failure with retry and refusal; the schedule as table or cards at 1440, 1280, 1024 and 768 px; a dialog that cannot be dismissed while its request runs. Two are skipped by design on the other device class.
- Existing specs changed: three `/doctor` to `/doctor/queue`; the thermal hover test scrolls the image into view first (see below).

### Verified test results (slice 4, 3 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:api` | 29 files, **309 passed**, 0 failed (new: 56 in 4 files) |
| `npm run test:web` | **5 passed** |
| `npm run test:thermal` | **32 passed** |
| `npx playwright test` | **67 passed, 0 failed, 0 timed out, 3 skipped**, in each of the last two full runs on the final tree (see the note on an earlier failed run) |

**Notes on the end-to-end runs:**
- The three skips are by design: the desktop-only keyboard test on the phone project (existing), the drawer test on desktop, and the table-width test on the phone project.
- The slowest test of the two clean runs took 35.4 s; an earlier run on a slightly earlier tree had one at 49.0 s in the first wave of six workers. Every test is within the 60 s budget. No timeout was changed.
- **One full run on the final tree failed: 7 failed, 60 passed.** All seven started in the same window, and each spent its 60 s waiting for the sign-in form after `page.goto('/login')` (the others in the run rendered the same page normally, and the server logs show nothing). Re-running those five specs gave 14 of 14, and two full runs after that gave 67 passed each. **The cause was not established**; I classify it as an environmental stall of the test web server (six workers start at once) and not as a product defect, but that is a judgement, not a finding. If it recurs, capture the page's console and network errors at the 60 s mark before anything else.

### Failures found during this slice, and what was done

| Failure | Classification | Action |
| --- | --- | --- |
| `thermal.spec` (desktop): the hover readout stayed empty, 3 of 3 times alone | Two causes. **Product defect:** a new page kept the old page's scroll position (906 px), found when this slice put a card above the thermal card. Then **test geometry:** the new shell puts the image's centre at y = 797, below the fold of the 1280 × 720 window | `ScrollRestoration` (a new page starts at the top, Back restores); the test scrolls the image to the top before hovering. No assertion changed |
| `appointments-db`: “two bookings for the same slot, exactly one wins” failed once in 3 runs | **Product risk:** raw concurrent inserts can be ended by the deadlock detector (`40P01`) instead of the exclusion check | The API takes per-doctor and per-patient advisory locks in a fixed order first, so its callers always get `slot_taken`; `40P01` and `40001` are answered 409 “try again”. The raw-insert DB test accepts either refusal (exactly one is refused); the API tests assert `slot_taken` exactly |
| New concurrency tests were rate-limited at sign-in | Test setup | The file was split (the limit is 30 sign-ins a minute per account); no limit changed |
| `doctor-home` Home test failed in repeated runs | Test defect: parallel runs booked the same doctor at random times (the exclusion constraint refused) | The appointment is unassigned and early in the day; repeated 8 of 8 passes |
| Phone drawer: its own close button was covered by the drawer (found in the screenshot tour) | **Product defect** | The drawer has its own close button; focus and inert handling tested |
| `appointments.spec`: portal assertion expected the booking reason; a hard-coded 17:30 could collide with another booking | Test defects after the review (the reason is no longer shown to the patient) | Assertions use the clinic-clock time and the department; the new time is outside the random range |
| First test runs of the new files: slot not on a 5-minute mark, a multi-statement admin query, wrong expected orderings | Test defects | Fixed in the tests; no assertion weakened |
| Final-tree e2e run: 7 tests stalled 60 s at the sign-in form | **Unexplained**, not reproduced in three later runs (see above) | None; recorded as a limitation |

### Pre-commit adversarial review (slice 4)

**Method:** independent read-only reviewers under distinct lenses, each asked to try to refute their own findings; I checked every finding against the code while fixing it. No separate skeptic agents were run, and the counts below are the reviewers' reports, not a count of confirmed defects. Rounds repeated until the last found nothing new.
- **Round 1** (5 reviewers): concurrency and transactions; authorization, privacy and audit; time zones, dates and SQL; notifications and the portal; web UI and regressions.
- **Round 2:** the backend fixes; the design foundation, shell and appointment screens.
- **Round 3:** the round-2 fixes, backend and web.
- **Round 4:** the round-3 fixes.
- **Round 5:** the round-4 fixes: nothing found.

| Round | Raised | Fixed | Accepted and documented |
| --- | --- | --- | --- |
| 1 | 27 (one a duplicate) | 27 | 0 |
| 2 | 25 | 23 | 2 (key-reuse refusal not audited; a check-in/booking deadlock window, answered as 409 “try again”) |
| 3 | 15 | 15 (a drawer test for Back-while-open was not added) | 0 |
| 4 | 5 (2 low defects, 3 minor) | 5 | 0 |
| 5 | 0 | n/a | 0 |

**What the rounds changed in the product** (examples):
- Retry attempts overlapped: now exclusive, in one transaction, on one connection, with the message's currency re-checked under the locks.
- A cancelled-by-queue appointment showed a false “patient not told” flag; messages that no longer hold are not retried.
- The staff-typed booking reason was shown to the patient; it is no longer.
- Same-key concurrent requests gave a 500 or a false conflict; now idempotent or a clear 409.
- A year-0000 date gave a 500; booking dialogs fetched 25 unrelated patients on opening; admins saw a dead link.
- Drawer, dialog and focus behaviour, a doctor's Home that lacked the MRN beside a one-click “Start consultation”, a table whose columns did not line up, and an invisible focusable button.

### Browser verification

**Automated:** Playwright drove real Chromium (the suite's 1280 × 720 desktop and 412 × 915 phone projects) with axe (WCAG 2.2 A and AA rules) and an overflow check on the schedule, details, the portal, the administrator's view, Home, the failed and refused states, and the drawer.

**Manual check:** a throwaway Playwright script (not committed) toured the redesigned screens on the **disposable end-to-end stack** (synthetic data; not the development database) at **1440 × 900**, **1280 × 800**, **1024 × 768** and **390 × 844**, and saved full-page screenshots. I looked at: at 1440, Home (empty and with data), appointments, details, the cancel confirmation with its validation error, booking with patient results, the queue, and the loading, failed and refused states, the administrator's schedule and the portal's appointments; at 390, Home, the open menu, appointments, details, booking and a patient record; at 1280 and 1024, the appointments page (table and cards). The other captures of that tour were produced but not individually inspected. The tour found the drawer defect above.

**Not done:** Firefox, Safari, real devices, a screen reader by hand, Windows high contrast, browser zoom beyond the default, print styles for the new pages.

## Slice 3: record lifecycle and integrity

**Basis:** a read-only map of the visit and consultation lifecycle, signing and amendments, the audit log, test-database safety and the doctor UI, made by five analysts reading code and tests. Decisions are recorded in:
- [ADR 0008](adr/0008-record-lifecycle-and-signed-record-verification.md): lifecycle, drafts, verification;
- [ADR 0009](adr/0009-audit-hash-chain-and-append-only-privileges.md): audit chain, privileges, database identity.

### Implemented

**Migrations** (all additive: no existing row is changed or removed):

| Migration | Contents |
| --- | --- |
| `0018_lifecycle_enum` | The `discarded` consultation status. On its own, because a new enum value cannot be used in the transaction that adds it. |
| `0019_record_lifecycle` | Status-history tables, with a baseline event for every existing visit and consultation. Visit and consultation guards. Discard columns and checks. One non-discarded consultation per visit (a partial unique index replaces the old unique constraint). Hash-scheme column. Amendment chain trigger. Audit chain columns, trigger and `audit.chain_start` event, with a digest of the earlier events. `meta.append_only_tables` and `meta.enforce_append_only`. |
| `0020_lifecycle_backstops` | No change of doctor or department while the patient is with the doctor (`AX005`). Stethoscope recordings added to the append-only list. |
| `0021_discard_reason_check` | A discard needs a non-blank reason, NULL included. It replaces the 0019 check, which let a NULL reason pass. |

**Applied to:** `adaxai_test`, `adaxai_e2e` and the development database (0018–0021). Before applying them to dev, read-only checks showed no data that would break the new checks: no signed rows without a fingerprint, no completed visits without a signature, no cancelled visits without a reason, and no discarded consultations at all. The dev audit chain verifies: 576 earlier events unchanged since the chain began.

**State machines** (API checks plus database triggers):
- **Visits:** the queue's manual moves only. The consultation makes the others (start or resume, sign, discard).
- **Rules:**
  - closed visits never change;
  - no cancel or no-show while a consultation is unsigned;
  - cancelling needs a reason;
  - no change of doctor or department while the patient is with the doctor, which covers editing and routing too.
- **Concurrency:** every change is compare-and-set, and the queue sends the status the user saw. Resume locks the visit row. Concurrent starts get one consultation.
- **Consultations:** `in_progress` → `signed` or `discarded`, both final. The database also refuses a consultation that is:
  - inserted already signed;
  - re-pointed to another patient or visit;
  - signed without naming a scheme;
  - deleted;
  - given AI text after it was signed;
  - amended before it was signed, or with a backdated amendment.
- **Status history:** every check-in and change records the acting user (required for the application role, `AX002`), the source, the reason and the time. Readable from the consultation page, and append-only.
- **Paused drafts:** data from before slice 3 can hold a draft on a visit that is back in the queue. Such a draft cannot be edited or signed until its author continues it; continuing returns the visit to the doctor.

**Unsigned drafts and discarding:**
- `GET /api/encounters/mine` and the **My consultations** page show the doctor's own unsigned drafts from any day, with visit, progress and last save. A second tab shows records signed in the last 30 days.
- The queue warns about drafts from earlier days, without naming patients.
- **Discard** needs the author, a reason and the current version. The draft is kept read-only, leaves the timeline and portal, and the visit returns to the queue.

**Signed-record verification** (`GET /api/encounters/:id/verification`, audited):
- **Fingerprints:**
  - v2 for new signatures: scheme, facility, visit and attestation included; strict serialisation;
  - v1 for earlier records.
- **Checks:**
  - the scheme, cross-checked against the signed content and the audit entry;
  - content against the fingerprint;
  - the record's rows against what was signed, including the signing time;
  - the audit log's copy of the fingerprint;
  - the amendment chain;
  - amendments against their audit entries, both ways.
- **Results:** `valid`, `invalid`, `unsupported_version` or `unverifiable`. Results are shown only after a check runs, always with the statement of what a match does not prove.
- **Amendments** are numbered, timestamped and hash-linked by the database.

**Audit log integrity:**
- The database chains every new event: SHA-256, commit order, transaction-scoped advisory lock, and READ COMMITTED only.
- `audit/chain.ts` verifies it independently of the trigger. The check is available on the admin **Audit log** page (with copy head and compare anchor) and as `npm run audit:verify`.
- The application role has no UPDATE, DELETE or TRUNCATE on any append-only table. The migrator and `db:provision` re-apply this after granting.

**Test database safety:**
- **Names:** `DB_NAME`, `DB_TEST_NAME` and `DB_E2E_NAME` must be distinct, and the test and e2e names must carry their suffixes.
- **Identity marker:** each database carries one (`meta.database_identity`), claimed by `db:migrate --target`. An unmarked database holding data is not claimed as disposable without `--claim-existing`.
- **Refusals** unless the database identifies as expected:
  - the test helpers' reset and raw SQL, which also require the test runner;
  - `db.mjs reset`;
  - `storage-orphans --delete`.
- **Playwright:** the configuration resolves names like the scripts do and stops before starting servers if they are ambiguous.
- **`db:migrate`** refuses unexpected options. The root script now passes its options through; before, `--target` was silently dropped and the development database was used.

**UI:**
- **My consultations** worklist, and the discard dialog with explanation and reason.
- Paused, closed-visit and discarded states in the consultation view.
- The editor stops retrying, and says why, when a save is refused for good. It opens from the server's current version, never from a cached copy.
- **Record verification** and **Status history** cards.
- Admin **Audit log integrity** card.
- Results are announced to screen readers.

### Not implemented, or needing a decision

- **Fingerprints are unkeyed.** Someone with the database superuser password (in the local `.env`) can rewrite content and recompute hashes. Only a head recorded outside the system reveals that, or the removal of the newest events. No HMAC key, external timestamping or anchoring service exists yet.
- **Not covered by the record fingerprint:** vitals, allergies, attached images and recordings.
- **The chain lock serialises audited writes.** It has not been measured under load.
- **Discarded drafts keep their consultation audio.** Retention still applies only to signed consultations; changing that is a product decision.
- **Only a draft's author can continue, sign or discard it.** Supervised reassignment (for example when a doctor leaves) is not built.
- **Past-day open visits.** Starting a consultation on an open visit from an earlier day is still allowed. There is no end-of-day closure.
- **Retention deletes remain hard deletes** by policy (invariant 17 now covers tests and scripts).
- **No cold backup before the dev migration.** None was taken before applying 0018–0021 to the development database, because `npm run backup` needs the running dev servers stopped and they were in use. The migrations only add and run in one transaction each. For a future destructive change, stop the app and run `npm run backup` first.

### Tests

**New API test files (49 tests):**
- `lifecycle.test.ts` (14):
  - the drafts worklist and its scope;
  - concurrent starts;
  - paused drafts and resume;
  - open consultations block cancel and no-show;
  - stale screens;
  - a database transition matrix against the contract;
  - no reassignment during a consultation;
  - other facilities' visit lookups refused and audited, also through routing;
  - status history and its protection;
  - discard;
  - a concurrent sign and discard;
  - consultation guards in the database.
- `integrity.test.ts` (24):
  - canonical serialisation;
  - verification: valid, tampered content, rows or hash, unsupported version, missing hash, legacy v1, scheme downgrade, visit, facility and signing-time changes, notes;
  - amendments: chain, database-assigned values, changed, removed, reordered and unlinked, removal of the newest, legacy;
  - AI provenance through signing and amendment;
  - concurrent checks during new amendments never report a false alarm;
  - audit chain: independent rebuild incl. unusual characters, concurrent writes and rollbacks, altered, deleted, reordered and unlinked events, anchors, the earlier-events digest (with more than ten events), unknown versions and the problem cap, isolation level;
  - the admin API and the command line;
  - app-role privileges.
- `db-safety.test.ts` (11):
  - name rules;
  - the identity marker;
  - refusals by the test helpers, `db.mjs reset`, `db:migrate` (including misspelt options), the e2e configuration and `storage-orphans`. All of these run against throwaway databases or a closed port.

**Updated:** `visits.test.ts`, because refused transitions are now audited as failures and the test asserts both.

**E2E:** `e2e/record-lifecycle.spec.ts` has three tests, on desktop and mobile, each with axe and phone-width checks:
- worklist and discard;
- signed-record verification and status history;
- the admin chain check with an anchor.

### Verified test results (slice 3, 3 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:api` | 25 files, **253 passed**, 0 failed (new: `lifecycle` 14, `integrity` 24, `db-safety` 11; updated: `visits`) |
| `npm run test:web` | **5 passed** |
| `npm run test:thermal` | **32 passed** |
| `npx playwright test` | **49 passed, 0 failed, 0 timed out, 1 skipped** |

**Notes on the end-to-end run:**
- The skip is the existing desktop-only keyboard test, skipped on mobile by design.
- `record-lifecycle.spec.ts` has 3 tests, each run on desktop and mobile.
- The longest test took 44.6 s: `doctor-workflow` on desktop, in the first wave of six parallel workers while the dev servers warmed up. The same test took 29.0 s on mobile later in the run, and 13.0 s and 11.1 s when run alone.
- All runs were within the 60 s budget. No timeout was changed.

### Failures found during this slice, and what was done

| Failure | Classification | Action |
| --- | --- | --- |
| Concurrent record checks during new amendments reported false "invalid" (found by review round 2) | **Product defect**: reads in separate snapshots | One read-only, repeatable-read snapshot per check. The concurrency test fails 6 of 6 times without the fix (first attempt at that experiment was invalid: a botched temporary edit crashed the route, which was noticed and redone). |
| Concurrent consultation starts: some requests got 409 instead of opening the new consultation | **Product defect**: a request read the visit before another committed the start, then took the resume path with a stale status | Resume decides on the locked, current visit row; repeated runs pass |
| `ai-clinical` e2e (desktop): axe `target-size` on an AI recommendation's *Defer* button | **Product defect** introduced by this slice: "Discard draft…" in the sticky footer sat under partly hidden targets | The destructive action moved from the always-visible footer to the visit card. The test passes repeatedly. The axe check is unchanged. |
| The dev audit chain reported "earlier events changed" right after migration | **Product defect** in the verifier: `order by id` bound to the text alias of `id`, so earlier events were digested in text order and re-read | Order by the column. A regression test with more than ten earlier events fails without the fix (39 vs 24) and passes with it. |
| First runs of the new tests: hard-coded sequence numbers, a non-deferrable unique index, `LOCK TABLE` outside a transaction, an actor-less insert | Test defects | Fixed in the tests; no assertion weakened |
| `visits.test.ts`: audit list grew | Intended change | Refused transitions are now audited; the test asserts the successes and the refusals separately |

### Pre-commit adversarial review (slice 3)

**Method:**
- Five rounds, until a round found nothing new. Each round used independent read-only reviewers under distinct lenses, then a skeptic who tried to refute every finding.
- **Round 1:** lifecycle and concurrency, integrity and the audit chain, security and privacy, test-database safety, UI, migration safety.
- **Round 2:** checked the round-1 fixes and hunted for regressions.
- **Round 3:** SQL semantics, cross-role flows, and claims in the docs against the code.
- **Round 4:** checked the round-3 fixes, plus a final sweep of every changed file.
- **Round 5:** checked the round-4 fixes, plus a last look.

**Results:**

| Round | Raised | Confirmed | Refuted | Fixed |
| --- | --- | --- | --- | --- |
| 1 | 22 | 18 (16 distinct) | 4 | all 16 |
| 2 | 10 | 7 | 3 | all 7 |
| 3 | 14 | 7 | 7 | all 7 |
| 4 | 5 | 2 | 3 | both |
| 5 | 0 | 0 | 0 | none needed |

**What was fixed:**
- Routing could reassign a visit's doctor or department during a consultation. It is now refused by the API and by a database trigger (migration 0020).
- **The record verifier trusted the editable scheme column.** Downgrading it, or writing an unknown version, hid tampering. The scheme is now cross-checked against the signed content and the audit entry, and an absent marker counts as version 1.
- **The verifier also missed:**
  - removal of the newest amendments;
  - amendments without a link on records signed after linking began;
  - a changed signing time;
  - a changed visit or facility on records whose column said version 1.
- **Verification read in separate snapshots,** so an amendment committed during a check produced a false "invalid". A test reproduced this 6 of 6 times without the fix and passes 5 of 5 with it. Checks now run in one read-only, repeatable-read snapshot.
- **The audit-chain verifier:**
  - skipped gap, link and hash checks for events with another chain version;
  - misreported the status beyond 20 problems.
- **`auscultation_recordings`** was missing from the append-only privilege list. A test now checks every trigger-protected table.
- **`npm run db:migrate -- --target test` silently migrated the development database,** because npm swallowed the option. The root script now passes options through, and the command refuses unexpected ones.
- **The e2e name-guard test** ran a TypeScript file with plain Node (Node 22.12–22.17 cannot do that); it now uses tsx.
- **Web:**
  - the editor could open from a stale cached copy, giving false conflicts;
  - one record's verification result showed on another record;
  - an AI insertion cleared the "cannot be saved" state;
  - the worklist was not refreshed after saves and signing;
  - the discard dialog closed silently when the draft left the list;
  - the anchor form put errors on the wrong field and could not take a pasted head;
  - results were not announced to screen readers.
- **Routing visit lookups** of other facilities were not audited.
- **Docs:** STATUS.md had not yet been updated, and the upgrade step for installations made before the guard was undocumented.
- **Round 3:**
  - The discard check let a NULL reason pass, because NULL in a CHECK counts as a pass. Migration 0021 fixes this.
  - A verification result stayed on screen after an amendment.
  - A queue action right after recording vitals sent the status from before the vitals, and was refused as "changed by someone else".
  - `audit:verify` silently ignored an `--anchor` that npm had swallowed and still reported VALID. Both command-line tools now refuse such options and name the variable.
  - The docs said every lifecycle refusal is audited; only refused manual status changes are.
  - A broken code fence in README and a split table in PRODUCT_SPEC.
- **Round 4:**
  - STATUS did not list migration 0021.
  - A request that lost a concurrent start received the record without an audited read.

**Refuted, with reasons recorded:**
- The cross-facility admin chain report: documented, and it carries counts and hashes only.
- Discard reasons in the visit history: intended, and tested.
- Cancel and no-show buttons on paused drafts: the server refuses them, with a reason.
- The worklist cap of 200: not reachable in practice.
- A newer version picked up by background refetches: the discard is still checked against the server's current version.
- The clipboard fallback: the app is served from localhost.
- A stale verification result after an amendment: the result is timestamped, and **Check again** is shown. Round 3 later confirmed a narrower form of this, which was fixed.
- **Round 3:**
  - "Closed visits never change" is a claim about status, and the docs say so.
  - Signing is not tied to the visit state in the database; no doc claims that, and the API checks it.
  - The verification statement's wording, which the per-check details qualify.
  - Anchors cover events up to the anchor, as documented.
  - The `--target=` form without `--`.
  - The placeholders in this file before the final run.
  - Printing database names.
- **Round 4:**
  - Refusing `npm_config_*` variables inherited from a developer's environment is fail-closed by design. The message now names the variable.
  - A resume racing a discard is serialised by the foreign-key lock on the visit.

### Browser verification

**Automated:** Playwright drove real Chromium on desktop and Pixel 7 for the new flows, with axe WCAG 2.2 AA and phone-width checks.

**Manual check:** a read-only script signed in to the **dev server** (synthetic dev data) as `dr.meera` and `admin`. It screenshotted, at 1440 and 390 px:
- the queue with the earlier-drafts warning;
- **My consultations**: three real drafts from 2 Oct;
- **Signed recently**;
- a signed v1 record after **Check now** (*Matches its fingerprint*) with its status history;
- the admin **Audit log integrity** check (*Chain intact*).

No page overflowed (scrollWidth equalled the viewport). Nothing was discarded, signed or edited. The demo password was read from `.env` inside the script and never printed.

## Slice 2: consent and access control

The basis was a read-only scope audit of every API route (154 route records; 68 gaps confirmed by adversarial verification). Decisions are recorded in [ADR 0006](adr/0006-consent-lifecycle-and-enforcement.md) (consent) and [ADR 0007](adr/0007-default-deny-routes-facility-scope-and-denial-audit.md) (access).

### Implemented

**Consent model** (migration `0017`, additive)
- **States:** granted (current wording), granted under an earlier wording (renew), withdrawn, not recorded. Computed in one place and shown in every app.
- **Withdrawal record:** reason (optional, kept on the record, not in the audit log), who, and the channel (staff or patient portal).
- **Renewal:** supersedes the earlier-wording grant atomically.
- **Database rules:**
  - rows are never deleted or rewritten, and end once (trigger);
  - one active ongoing grant per purpose (unique index);
  - deterministic lookup, current wording first.

**Enforcement at the API boundary**, refusals audited as `consent.blocked`:
- recording and AI assistance;
- Mana AI summaries, including retries;
- photographs and their AI description;
- thermal images;
- device assignment, recordings and ingestion;
- portal activation, reset, sign-in and every portal request;
- research dataset download and evaluation.

The rule-based safety check reads the transcript only while recording consent is in place.

**Withdrawal takes effect at once**, ending every grant of the purpose, including consultation-only ones:
- **portal access:** the account is switched off, sessions end, codes are revoked;
- **device consent:** assignments end;
- **research consent:** datasets that include the patient are blocked;
- **recording:** the browser recorder stops, sends nothing more and closes the live transcript.

Patients can withdraw their own consents in the portal. Granting stays with staff, who read the wording. The portal shows the wording the patient actually agreed to.

**Device readings** are filed to the patient the device was assigned to when they were measured, and only if consent was in place at that time. A renewal under newer wording counts as continuous consent. Readings outside an assignment or before consent are refused and audited.

**Portal accounts**
- Staff can issue a reset code (new password; switches the account back on; requires portal consent).
- Staff can switch an account off at once.
- Activation and reset re-check consent and record who issued the code.

**Default deny**
- Every `/api` route must declare `public`, a permission or `anySession`, or the API does not start.
- A route-inventory test checks the public set (5 routes) and the any-session set (3 routes).
- 401 is checked for every private route.
- A 403 is checked for every role and route the role lacks permission for (over 150 pairs, each audited).

**Facility scope**
- Admin user list, edit and password reset; staff directory; overview counts; audit search.
- Audit rows carry their facility.
- A patient or consultation of another facility is "not found", and the attempt is audited with the reason.

**Minimum necessary**
- Admins see that a device is in use, not by whom.
- Nurses see only reviewed AI photo descriptions.
- Only the signing doctor amends a signed consultation (conservative default).
- AI audit details carry counts only, never model text.

**Every refusal leaves a trace**, without double entries:
- in-route 403s;
- cross-facility 404s;
- portal record probes;
- device rejections;
- the patients disclosed by bulk reads;
- CSRF refusals, throttled per address.

**Sign-in**
- Attempt slots are reserved before the password check, so there is no lockout race.
- The same lockout rules apply to every username, so no account discovery.
- Unknown usernames are never stored.
- Wrong current passwords at a password change count towards the lockout.
- Rate limits per address, account, user and device token (429 with `Retry-After`).

**Logs:** request logs record paths only, never search terms.

**De-identified thermal export:** staff-typed region names become neutral codes (case-insensitive, pairs preserved); the free-text body region is left out.

**UI**
- **Consents card:**
  - the state of each purpose;
  - renewal;
  - withdrawal dialog with the effect and an optional reason;
  - consultation-only grants;
  - full history.
- **Patient portal card:** activation, reset code, switch off.
- **Portal consents page:** withdrawal in the patient's own words and effect; earlier-wording label.
- **Sign-in notice** after a patient withdraws portal access.
- **Admin device registry:** without patient identity.

### Not implemented, or needing a decision

- **"Care records" (`data_processing`) consent** is recorded and shown but not enforced. The withdrawal texts say so. What it means for care is a legal decision.
- **Unauthenticated 401s** are not audited. This avoids noise from expired sessions; every other refusal is audited.
- **Rate limits** are per process and in memory; a restart clears them.
- **Amendment rights** (only the signing doctor) are a conservative default for the clinical owner to confirm.
- **Unchanged areas:**
  - the visit/encounter lifecycle;
  - signed-content verification;
  - the audit hash chain and app-role grants;
  - the test-DB name guard.

  These were done in slice 3 (above).

### Tests

**Updated** where the behaviour intentionally changed:
- search audit now lists the patients returned;
- an activation code for an existing account is now a reset code;
- portal probes are audited;
- `outside_assignment` replaces `device_unassigned`, and withdrawing device consent ends assignments;
- ROI codes in the export;
- consent message wording.

**New in `consents.test.ts` (13):**
- lifecycle;
- database guards;
- enforcement: absent, granted, withdrawn;
- consultation-only grants;
- device timing and renewal chain;
- buffered-reading attribution;
- portal withdrawal and reset;
- portal consent defence in depth;
- patient self-withdrawal;
- earlier wording;
- switching an account off;
- withdrawal texts.

**New in `access.test.ts` (14):**
- route inventory;
- start-up refusal of an undeclared route;
- 401 sweep;
- role matrix;
- in-route refusals;
- facility isolation;
- lockout under concurrency (incl. the one-correct-guess burst);
- parity for inactive and unknown usernames;
- password-change lockout;
- rate limits;
- CSRF audit volume;
- log redaction.

**Added to existing suites:**
- `devices.test.ts`: admin view and list audit;
- `images.test.ts`: nurse view;
- `thermal-data.test.ts`: research withdrawal;
- `mana.test.ts`: withdrawn consent and retry audit.

**E2E:** `e2e/consent.spec.ts` covers portal withdrawal, staff withdrawal, reset code and portal self-withdrawal, on desktop and mobile.

### Verified test results (slice 2, 3 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:api` | 22 files, **204 passed**, 0 failed |
| `npm run test:web` | **5 passed** |
| `npm run test:thermal` | **32 passed** |
| `npx playwright test` | **43 passed, 0 failed, 0 timed out, 1 skipped**. The skip is the existing desktop-only keyboard test on mobile. The longest test took 30.9 s, within the 60 s budget. |

**Browser check** (dev server, synthetic data): a read-only script signed in as `nurse.anil` and screenshotted the consents card with its history, the patient portal card and the withdraw dialog (opened and cancelled; no data changed). At 390 px there is no horizontal overflow (scrollWidth 390). Migration 0017 was applied to the dev database; it is additive, and there were no duplicate active grants beforehand.

### Pre-commit adversarial review (slice 2)

**Method:**
- Five lenses: authorization bypass, consent logic, integrity and audit, regressions, UI.
- A skeptic then tried to refute each finding.
- 26 findings were raised: 22 confirmed, 4 refuted.

**What was fixed:**
- a sign-in lockout race that singled out the correct password;
- enumeration through inactive accounts and through the reset window of unknown usernames;
- missing facility on audit rows from public routes;
- withdrawal texts that over-promised (incl. "Care records") or used staff wording for patients;
- buffered device readings refused after a consent renewal;
- consultation-only grants hiding withdrawals, and no way to withdraw them;
- a renewal racing a withdrawal;
- Mana's legacy consent path;
- portal code issuance rejecting an earlier wording;
- double audit rows;
- the CSRF audit flood;
- a failed Mana retry audited as a success;
- case-sensitive ROI codes breaking pairs;
- the live recorder after a consent refusal (it uploaded leftover audio, left the transcript "live", and kept showing stale consent);
- "Add amendment" shown to doctors who may not amend;
- the device gateway contract not documented.

## Slice 1: Mana AI patient-context Q&A, and AI text in notes with provenance

### Implemented

#### Mana record retrieval (`apps/api/src/mana/record.ts`)

Access:
- Doctors only (`ai:use`).
- The patient must be in the caller's facility; another facility's patient is indistinguishable from a missing one (404).
- A consultation id passed as context must belong to the same patient.

What it reads, for one patient only, from bounded windows (`config/adaxai.yaml` → `mana`):
- allergies, and the recorded allergy status;
- signed consultations: every note field, diagnoses, prescriptions and amendments;
- today's draft, labelled as a draft;
- reasons for visit;
- vital signs, with their source and validation status;
- approved thermal measurements.

What each item carries:
- a reference, record type, consultation id, date, field, status and provenance;
- an excerpt with identifiers replaced.

#### Mana record answers (`apps/api/src/mana/answers.ts`, rules `mana-record-v1`)

No AI key is needed. Intents:
- briefing;
- history summary;
- last prescription;
- vital signs compared with the previous reading;
- changes since the previous visit;
- allergies;
- diagnoses;
- free-text record search.

Every statement cites record items. The rules also state:
- what is absent;
- conflicts: allergy vs. prescribed medicine in a configured illustrative group; "no known allergies" vs. active allergies; disagreeing readings at one visit;
- possibly outdated records;
- amended consultations.

#### Mana AI summary (`mana-qa-v1`)

Runs only when both hold:
- `ANTHROPIC_API_KEY` is set;
- the patient has a current consent of the new type `ai_record_assistant`.

What is sent:
- Only items relevant to the question, within the character budget.
- The references sent are stored on the job.
- Name, MRN and phone are replaced before sending.

What is checked and recorded:
- The server verifies citations; uncited statements are kept and marked "Not supported by the record".
- Job, run, provider, model, prompt version and tokens are recorded.

Failure handling:
- A failure is recorded as such, and retry is possible.
- Without a key the answer says "AI summary unavailable" and why.
- Without consent it says "consent needed", and nothing is sent.

#### Persistence and audit

- **Storage:** `mana_questions` (migration `0015`). A trigger allows only the AI part to be completed, and only while it is pending or failed.
- **Review and insertion:** reviews and insertions are appended to `ai_review_actions` and `note_insertions`.
- **Idempotency:** requests carry idempotency keys.
- **Audit events:** `mana.ask`, `mana.read`, `mana.review`, `ai.job_create`, `ai.patient_qa`, `encounter.ai_insert`.

#### AI text in notes (invariant 1, [ADR 0002](adr/0002-ai-text-into-notes-via-recorded-insertions.md))

How text gets in:
- `POST /api/encounters/:id/insertions` is now the only UI path for AI or rule output into a note.
- Only the authoring doctor can use it, before signing, at the current version.
- Reviewed output only. A Mana answer is inserted directly; the insertion itself is the explicit action.
- The same text from the same source goes into a section once.

What is recorded:
- The note keeps the source reference: provider, model, prompt or rules version.
- The signed snapshot lists every insertion, with `retained` (whether the text is still unchanged).

Where it shows:
- under the note section;
- in the sign dialog;
- on the signed record.

The earlier browser-only "Add to …" path is gone.

#### UI

- **Placement:** a Mana panel on the doctor's patient record and in the consultation workspace.
- **Asking:** suggested questions and free text.
- **Answers:**
  - statements grouped by section, with kind badges;
  - expandable sources: field, date, status, provenance, and a link to the consultation;
  - the AI summary labelled separately.
- **Actions:** Mark reviewed; Insert into note; retry.
- **Consultation workspace:** three panels at 1536px and wider (visit and timeline | note | Mana and the assistant), two panels at 1280px, stacked on phones.

#### Documentation

- [AUDIT.md](AUDIT.md) (Phase 0);
- [PRODUCT_SPEC.md](PRODUCT_SPEC.md) (Phase 1);
- [ADRs 0001–0005](adr/);
- README and [DEMO.md](DEMO.md) updated.

### Not implemented or not validated in this slice

- **AI summary:** no *successful* real-provider response has been obtained or evaluated (two real speech-to-text attempts from the dev app were both rate-limited, see the test-isolation note below). It is tested only with a test double and the local test-only mock of the Anthropic API. Answer quality with a real model is unknown.
- **Record rules:** cover the listed intents only. Other questions fall back to a word search with no paraphrase. The question classifier is pattern-based.
- **Thresholds:** the "possibly outdated" threshold (180 days) and the allergy groups are display aids, not clinical guidance.
- **Languages:** English UI. No Tamil, Hindi or code-mixed evaluation.
- **Workspace layout:** the three-panel layout is not tested at every width. It was checked by screenshot at 1920, 1366 and 390px.

### Verified test results (2 Oct 2026)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run test:api` | 20 files, **175 passed**, 0 failed (`mana.test.ts`: 19 new tests; `config.test.ts`: 1 new isolation guard) |
| `npm run test:web` | **5 passed** |
| `npm run test:thermal` | **32 passed** |
| `npx playwright test` | **41 passed, 0 failed, 0 timed out, 1 skipped**. The skip is the existing desktop-only keyboard test, skipped on mobile by design. `e2e/mana.spec.ts` has 2 tests × desktop and mobile. The longest test took 32.4 s. |

New tests, `apps/api/test/mana.test.ts`:
- classifies questions into intents;
- answers the last prescription with source, date, field and status, flags outdated and conflicting records, and never invents an AI answer;
- compares today's vitals with the previous reading and flags disagreeing readings at the same visit;
- states what is absent: no signed consultation, nothing to compare, no matching record item;
- summarizes history and changes since the previous visit from this patient's record only;
- flags an amended consultation as possibly corrected and marks its items as amended;
- is for doctors only, within their facility; answers are immutable and reviews are recorded;
- AI summary: needs the patient's consent, sends only this patient's pseudonymised items, verifies citations and records provenance;
- a failed summary keeps the record answer, is marked retryable and can be retried;
- asking without an AI summary sends nothing to the provider;
- inserting AI output into the note: only by explicit insertion of reviewed output, keeping a reference to the AI artifact through signing. Includes: the same text goes in once, stale versions are refused, other doctors are refused, other patients' artifacts are refused, text must match the reviewed text, section length limits hold, references are in the signed snapshot, the trail is append-only.
- does not report medicines as stopped when the latest signed consultation simply has no prescription;
- searches whole words and keeps the documented "no known allergies" status;
- finds the previous reading even after a burst of newer readings;
- a long record keeps the allergy record and the cited items in the AI context budget;
- keeps AI-reported conflicts even when the model returns many statements;
- a retry re-checks consent: after withdrawal nothing is sent, through either retry route;
- non-retryable failures cannot be retried; a summary left in progress by a stopped server can be;
- sends dates as the facility's local day.

New tests, `e2e/mana.spec.ts` (desktop and mobile):
- Mana answers from the record with sources, labels the AI summary, and inserted text keeps its provenance through signing;
- without the patient's consent Mana still answers from the record but sends nothing for an AI summary.

### Failures found during this slice, and what was done

| Failure | Classification | Action |
| --- | --- | --- |
| At audit time, 3 e2e tests timed out (30 s), and later 2 others: the long multi-role workflows | Environment / resource. The tests failed at their final steps. In passing runs `doctor-workflow` takes 26.6–27.7 s, and the longest test in the final run took 32.4 s, so the 30 s default was too short. | Per-test budget set to 60 s in `playwright.config.ts`, with the measurements in a comment. Per-assertion timeouts are unchanged (5 s). Re-run: 41 passed. |
| Mana mobile: page 2 px wider than a 412 px phone | **Product defect**, clock-dependent: the non-wrapping "Reviewed by … · date, 11:28 pm" badge overflowed when the time had two hour digits | `Badge` got a `wrap` option, used for long labels; the overflow check now names the offending elements. 16 of 16 repeated runs pass. |
| Mana e2e: chip clicked before AI status loaded, so the request went out with no AI summary | **Product defect**: a UI race | The client always sends the doctor's choice; the server decides and states why a summary is unavailable. |
| "Any mention of fever?" classified as a vital-sign comparison | **Product defect**: rule order | Search phrasing is matched first; unit test added. |
| Duplicate "Sources: M1" lines in the prescription answer | UX defect (browser check) | The prescription date and doctor moved into the section title. |

### Pre-commit adversarial review

**Method:**
- Four independent reviewers covered security, correctness, data integrity and UI.
- A skeptic then tried to refute each finding.
- 23 findings were raised and 22 confirmed. The refuted one described documented ADR 0002 behaviour.

**What was fixed**, each one with a regression test where testable:

**Security**
- A Mana AI retry, through either retry route, did not check consent again, so after withdrawal the record could still be sent. Every run now re-checks consent; a blocked attempt is audited as `mana.ai_blocked`.
- A non-retryable failure could be retried.
- The insertion endpoint accepted any text under an AI artifact's provenance. Now only the reviewed text can be inserted (`text_mismatch`). Mana answers stay editable by design, and are labelled "text chosen and edited by the doctor".

**Integrity**
- An insertion could push a note section past its length limit, which made every later autosave fail. It now returns 400.
- An answer could stay "AI summary in progress" forever. It is now always resolved, and a stale pending answer can be retried.

**Correctness**
- Absence statements ignored the 10-consultation window. They now say what was read.
- A burst of readings could hide the previous one (the old 200-reading cap). Readings are now bounded per kind and visit.
- "What changed" reported medicines as stopped when the latest signed consultation had no prescription.
- Search matched inside words, and hid "no known allergies".
- The AI context budget dropped old allergy records.
- AI conflicts could be cut off by the statement cap.
- Dates sent to the AI were UTC days, not facility days.

**UI**
- Overlapping insertions and autosave could race. They now run on the same serial chain.
- The save indicator could claim "Saved" while edits made during an insertion were unsaved.
- An accepted note suggestion whose automatic insertion failed could not be inserted later. It now has a fallback "Add to …".
- The live region read whole answers aloud. Only a short notice is announced now.
- At 1280px a gap opened above Mana.
- The assistant's two-column block was squeezed into the side panel (now a container query).

**Test isolation**

At 23:47, during this work, real `ANTHROPIC_API_KEY` and `AI_STT_API_KEY` values were added to `.env`. The values were not displayed. The API test helper builds its config from `.env`, so the "no keys" test app picked up a real provider.

| Item | Detail |
| --- | --- |
| Fix | The test configuration now never carries provider keys. Guard test: `config.test.ts` › "the test configuration never carries provider keys, whatever .env contains". |
| E2E | Was already isolated: the API server gets a placeholder key pointed at the local mock, and an empty speech-to-text key. Verified that Node keeps preset variables over `.env`. |
| Checked | The test database shows no external-provider runs. |
| Dev database | It shows two speech-to-text attempts from the dev app at 23:48, both failed with `rate_limited`. They were not made by tests. |

### Browser verification

- **Automated:** Playwright drove real Chromium for the full Mana workflow, on desktop and Pixel 7, with axe WCAG 2.2 AA and phone-width checks.
- **Manual check:** a local script signed in to the **dev server** (synthetic dev data) as `dr.meera` and screenshotted:
  - the patient-record briefing, with no AI key, showing the unavailable reason;
  - the consultation at 1920px (three panels, with the allergy vs. Amoxicillin conflict);
  - the consultation at 1366px (two panels);
  - the consultation at 390px: no horizontal overflow, scrollWidth 390.

The demo password was read from `.env` inside the script and never printed.

## Next planned work

The Doctor App is the hero product; work is organised as vertical slices through every layer ([DOCTOR_APP_PLAN.md](DOCTOR_APP_PLAN.md)):

1. ~~**V1: know the patient.**~~ Done (slice 4A above): dashboard and *Today's patients*, the consultation workstation, a longitudinal history model with the *Past History* panel and a profile sheet, a synthetic hospital dataset.
2. ~~**V2: capture the consultation.**~~ Done (slice V2 above): local speech-to-text, timed transcript, doctor-assigned speakers, important points, evaluation on synthetic data. ~~**V2.1: hardening.**~~ Done (slice V2.1 above): "a key alone enables nothing" for the hosted language-model steps (an explicit server setting, off by default), speech-service limits, withdrawal ends live recordings. **Carried forward:** retention/erasure/encryption decisions, the consent-wording review, whether hosted egress may ever be used for real data.
3. ~~**V3: local AI consultation intelligence.**~~ Done (slice V3 above): a pinned open-weight model on this computer behind a provider abstraction (local by default, hosted only behind the egress policy, none; never a fallback), a sourced consultation draft built only from the authorised record, the doctor's notes and doctor-confirmed points, checked by code, reviewed statement by statement, added to the note only by a separate act, versioned and audited. **Not done and carried forward:** Mana on the local model (V4), the patient's view of the signed record, retention and consent decisions for drafts.
4. ~~**V4: Mana AI.**~~ Done (slice V4 above): a doctor-facing, read-only assistant over the clinic's records on the local model: the model plans, registered tools read after authorisation, the model writes from what they returned, code checks every statement ([ADR 0017](adr/0017-mana-ai-doctor-assistant.md)).
5. ~~**V5: devices.**~~ Done (slice V5 above): reading states (live, stale, disconnected, no data, unavailable) decided on the server's clock, "simulated" as a mark kept apart by the database, a gate on which kinds a device may send (never blood pressure), batches stored once, a gateway contract, recording in the browser ([ADR 0018](adr/0018-device-readings-states-gateway-and-simulator.md)). **No device has been connected or tested. Carried forward:** a real device and gateway, validation of readings, a quota per device, token rotation, retention of readings; **the end-to-end suite on this machine** (see V5, Tests).
6. ~~**D1: the consultation as one workspace.**~~ Done (D1 above, [ADR 0019](adr/0019-d1-integrated-consultation-workspace.md)): V1 to V5 on one screen for one patient and one encounter; no new engine. **Carried forward:** the end-to-end suite on this machine (see V5 and D1, Tests).
7. ~~**V6: thermal imaging in the consultation.**~~ Done (V6 above, [ADR 0020](adr/0020-v6-thermal-capture-in-the-consultation.md)); **not verified on a camera or a tablet**. **Carried forward:** compiling and running the native bridge with the FLIR SDK on a tablet and a FLIR ONE (the 15 steps in [THERMAL_CAMERA.md](THERMAL_CAMERA.md)); a thermal model only with a dataset, an evaluation and a model card.
8. ~~**D2: the multimodal consultation.**~~ Done (D2 above, [ADR 0021](adr/0021-d2-multimodal-consultation-context.md)): one context of the consultation read from the records, the overview, disagreements and a summary by fixed rules, Mana's consultation questions. **Carried forward:** the V3 time-zone defect (00:00 to 05:30 IST), thresholds chosen by a clinical owner, a usability test with doctors.
9. ~~**Doctor HERO "complete redesign"**~~ Done as the **Doctor HERO final** application (see its section above, ADR 0023); **carried forward:** updating the 12 outdated end-to-end specs, a re-run on the real local models, a visual review by eye, hardware (FLIR ONE, a band, a stethoscope), a real laboratory. Previously listed as NOT built (see the Doctor HERO Step 3 section): the Today/Week/Month home without the sidebar, the patient profile with tabs, the digital pen, one band-and-stethoscope input, recording on Start, a prescription document page, a persistent Mana button, no development banner.
10. Then: prescription and documents, the consultation audit trail, handwriting.

## External needs (not blocking the MVP build)

- **A provider key and a data-processing agreement**, needed before any real AI summary can be evaluated. Use synthetic data only.
- **A qualified clinical owner**, needed for:
  - alert thresholds;
  - allergy groups;
  - the "outdated" threshold;
  - consent wording.
- **Legal / privacy review** of:
  - consent purposes;
  - what "Care records" (`data_processing`) consent means for care;
  - cross-border AI processing.

  Nothing here claims compliance.
- **The clinical owner's confirmation** of amendment rights (currently only the signing doctor).
- **Product decisions from slice 3:**
  - who may take over or close another doctor's unsigned draft (today only its author can);
  - whether retention should delete the audio of discarded drafts;
  - where facilities record the audit-chain head outside the system, and how often.
- **Labelled, de-identified data**, needed before any model evaluation or training.
