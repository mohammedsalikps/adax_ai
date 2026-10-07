# ADAXAI demonstration (synthetic data only)

Everything here is synthetic: patients, staff, transcript and audio are fictional. ADAXAI is an
MVP; it is not production-ready, not a medical device, and none of its AI output, rules or
measurements are clinically validated.

## Preparation

```bash
npm run setup
```

```bash
npm run dev
```

```bash
npm run demo:seed -- --fresh
```

`demo:seed -- --fresh` creates a new **Ravi Demo-Synthetic-XXXX** (the suffix is printed): consents
recorded (including *Mana AI record summaries*), a penicillin allergy, one signed earlier consultation (type 2 diabetes, metformin) and
today's visit with vitals, ready for the doctor. Use `--fresh` for every clean run.

**The synthetic hospital dataset (recommended for the Doctor App).** After `npm run db:seed` and
`npm run db:migrate`, `npm run demo:hospital` adds twelve fictional patients with allergies, known
conditions, medicines, investigation results and earlier signed consultations, two more staff
(`dr.arjun`, an orthopaedics doctor, and `nurse.divya`, a paediatrics nurse), and **today's
activity**: appointments (some already seen, one who did not come, some still to come) and a queue
in every state, with times set around the current time. It is idempotent and resumable (a patient
is recognised by name and date of birth and never made twice; a run that stopped half way is
completed by the next; today's activity is added once per day) and refuses to run in production,
unless `DATA_ORIGIN` is `synthetic` and the facility is named "(synthetic)", or beside any patient
marked clinical. Everything it makes is marked synthetic; see
[docs/safety/DATASETS.md](safety/DATASETS.md). Sign in as `dr.meera` (General Medicine):
**Mohammed Ali** is with the doctor (an unsigned draft), **Asha Patel** is ready, **Ravi Kumar** is
waiting, and **Priya Singh** did not attend.

Open `http://localhost:5173`: the first page offers the **Doctor App**, **Patient App** and **Admin App**.
Choose one to reach its own sign-in page. Staff accounts: sign in with the username, not an email
address. Password: the exact value of `SEED_DEMO_PASSWORD` in your `.env` (see the README's
Troubleshooting if sign-in fails):

| Account | Role | Sign in at |
| --- | --- | --- |
| `nurse.anil` | Nurse (General Medicine) | Doctor App |
| `dr.meera` | Doctor (General Medicine) | Doctor App |
| `dr.rahul` | Doctor (Paediatrics) | Doctor App |
| `admin` | Administrator | Admin App |
| a patient's MRN | Patient (after activation, §5) | Patient App |

A correct password at the wrong door is refused (“This account cannot use the Admin App”) and no
session is made; opening another application's address while signed in shows a plain “no access”
page. Nothing in the front door grants access: the API decides.

Use two browser windows (or one normal and one private) to switch roles quickly.

**With or without AI keys.** Without keys (the default), the AI steps show a clear “unavailable”
state, and everything else works, including the rule-based safety checks and routing. With
`ANTHROPIC_API_KEY` **and `AI_EGRESS_HOSTED=true`** in `.env` (a key alone sends nothing: hosted AI egress is off by
default), restart `npm run dev` to also show drafting, AI recommendations and photo
description (**Mana AI needs no key**: it uses the local model, like the consultation draft); the assistant panel then says where text would go. Only do that with synthetic data and after
checking your provider agreement. **Live transcription needs no key**: after the one-time `npm run speech:model`
download, `npm run dev` starts a local speech service and the consultation's *Live transcription*
card records with the microphone, on this computer only. Without the download it says "Local
transcription unavailable" and typed transcripts still work. **The consultation draft needs no key
either**: after the one-time `npm run llm:setup` download (about 2.74 GB; it asks first and checks every
file), `npm run dev` starts a local language model on `127.0.0.1:8081`; a draft then takes **a few minutes**
on a laptop CPU. Without the download the *Consultation intelligence* card says **"Local AI
unavailable."** and makes nothing up.

## The jury demonstration (ADAXAI Clinic · Dr. Meera Iyer · Ramesh Kumar)

A coherent synthetic clinic for one doctor, made for a fresh **development** database (it refuses to run
twice on the same day and never runs in production):

```bash
npm run db:provision
```

```bash
npm run db:migrate
```

```bash
npm run db:seed
```

```bash
npm run demo:jury
```

Then `npm run dev` and open `http://127.0.0.1:5173` → **Doctor App** → `dr.meera`.

What `demo:jury` makes (all fictional, marked synthetic; display names changed in this database only):

- **ADAXAI Clinic** (General Medicine), **Dr. Meera Iyer** with a registration number; 20 patients with
  Indian names and 103 earlier signed and completed consultations over four weeks (so Week and Month have a trend).
- **Ramesh Kumar**, 45 M, MRN **ADX-001245**: hypertension (2019) and type 2 diabetes (2020), a penicillin
  allergy (moderate, rash), Metformin · Amlodipine · Atorvastatin, an appendectomy (2015), four earlier
  consultations over six months with staff vitals at each (the profile's averages come from them),
  eight results (HbA1c, fasting sugar, CBC, lipids, creatinine) and two small synthetic PDF reports (a CBC and a
  chest X-ray). Today he is **ready for the doctor** with the nurse's vitals (T 37.8, HR 92, BP 128/84, SpO₂ 98,
  RR 18, RBS 146) and a triage note.
- **Today's queue, counted by the server:** 5 completed · 1 in consultation (Abdul Rahman, with a simulated lab
  order) · 6 waiting (Ramesh first) · 8 booked → **20**. (Every tile on Home is the server's own count; numbers are
  never typed into the page.) The times are relative to when the seed ran.
- A simulator band attached to Ramesh for today and a simulator stethoscope (**SIMULATORS**, labelled so).
- The patient-app activation for Ramesh is written to `.data/sim/jury-portal.txt` (git-ignored; never printed).

**The walk-through (about 5 minutes on this computer):**

1. **Home** — Today | Week | Month tiles, the current patient, the week's consultations, today's patients.
2. **Patient profile** (Ramesh's name anywhere) — allergy and condition badges; *Average / Recent Vitals* (averages
   of staff measurements; device and simulated readings are left out); the record summary (fixed rules, not AI);
   recent consultations; active medications; tabs Consultations · Prescriptions · Lab Reports · Imaging ·
   Documents · Surgeries · Allergies & Medications.
3. **Start consultation** (My consultations) — recording starts by itself when the recording consent is on record.
   For the demo, **Stop**, then ⋯ → **Play demo consultation**: computer voices (SYNTHETIC AUDIO) read an adult fever
   consultation through the real local speech model (faster-whisper). The speech model identifies nobody: lines
   nobody assigned show a dashed **Speaker assignment — demo fallback** (Doctor / Patient alternating by recorded
   part; display only, nothing stored); the doctor can correct any line.
4. **Important points** appear (fixed rules); **Confirm** one, then **Add to …** puts it in the note.
5. **Clinical inputs** (staff vitals with time and source), **Stethoscope** (recorded, never analysed), **Thermal** →
   *Open thermal imaging* → Simulator → Connect → Capture: the tile then says **SIMULATED THERMAL CAPTURE**.
6. **Mana** (docked) — *Summarize this patient's previous history*, *Summarize today's consultation*, *Show recent lab
   reports*, *Any pending orders?*: each answered at once by fixed rules, with its source ("From the patient record",
   "From this consultation", "From service orders"). Mana never signs or completes.
7. **Doctor's note** — Chief complaint · History of present illness · Clinical findings · Assessment · Plan (autosaved;
   Handwriting is the second tab).
8. **Analyze & Generate Prescription** — the inputs light up as the server reports them, then *ADAXAI Clinical Context*
   → *Mana AI* (the local Qwen model's real token count and time; about 40–50 s here) → *Clinical summary* →
   *Prescription draft*; the prescription page opens when the draft is ready (at once if the model is down).
9. **Review and sign prescription** — the document (patient, allergies, diagnosis, medicines, advice, follow-up) and
   the **PDF preview**: a real PDF made by the server from what is saved (`GET /api/encounters/:id/prescription.pdf`,
   marked *DRAFT — NOT SIGNED* until signed). **Open PDF**, **Print**, **Sign** or **Sign & print** (the review asks for
   the attestation). Signing does **not** complete the consultation.
10. **Complete consultation** (confirmed) → My consultations, marked Completed; Home counts one more seen; the profile
    shows today's consultation; the patient app shows the course ("Day 1 of 5").

To run it again, recreate the development database (back it up first with `npm run backup`), then repeat the four
commands above.

## 0. The doctor's day and the patient's history (dr.meera)

1. **Home** greets the doctor and shows how today stands from the queue and the schedule, then
   *Today's schedule*: who is still to be seen, in time order, each with its real state and the
   action that applies (*Start* or *Continue consultation*, *Check in* for a booked appointment).
2. **Today's patients** (sidebar): tabs with counts, a day picker, *My patients / Whole clinic*, and a
   row per visit with the allergies always shown. Quieter actions are in the row's **⋯** menu
   (keyboard: Enter, arrows, Escape).
3. Start the consultation of **Mohammed Ali**. The header says **Draft · in progress** and for how long.
   The banner shows his **penicillin allergy (Severe)** and his conditions. *This visit* shows each
   vital sign with when it was recorded and "entered by staff" (the glucose is flagged as outside the
   adult range, in words).
4. **Past history**: *Summary*, *Consultations* (open one: what was prescribed, "not a record of what
   the patient takes", and the link to the signed record), *Medications* (Glimepiride is stopped, with
   the reason), *Allergies*, *Investigations* (HbA1c with its range and a *High* flag). Use the arrow
   keys, Home and End to move between the tabs.
5. As a doctor, **Add condition**, **Add medicine**, **Add result**; use a row's **⋯** to stop a medicine
   or **mark an entry as entered in error** (a reason is required; the entry stays in the record and
   leaves the history). Nothing is deleted.
6. **View profile** opens a side sheet: an overview with a **summary of the record, labelled "not
   AI-generated"** and what it is based on, the full history, and documents. Escape closes it.
7. What is not built says so: the **digital writing pad** reads "Not available yet", and the
   stethoscope card says no stethoscope is connected. The AI panels say whether a provider is
   configured; see [AI_STATUS.md](AI_STATUS.md) for what each AI feature really is.

## 1. Nurse intake (nurse.anil)

1. **Register patient**: a new synthetic patient (any name, date of birth, sex, phone). Note the
   MRN shown after saving. Possible duplicates are flagged.
2. In the check-in dialog choose General Medicine, reason for visit *“Chest pain since this
   morning”*, check in. The daily token appears.
3. On the patient record: **Consents** → record *Patient portal*, *Consultation recording & AI
   assistance* and *Device readings* (verbal); **Allergies** → *No known allergies*.
4. Queue → **Vitals**: temperature 37.6, heart rate 96, BP 142/88, SpO₂ 96.
5. Queue → **Routing** → **Suggest routing**: the configured red flag (*“chest pain” in the
   reason for visit*) with its escalation instruction, *urgent for staff review*, and the reason
   for each part (rules `routing-rules-v1`). **Apply suggestion** (or **Override** with a reason).
6. **Ready for doctor**.

## 2. Mana AI, the doctor's assistant (dr.meera; needs `npm run llm:setup` and the model server)

Mana AI is a **read-only** assistant for your own clinic's records ([ADR 0017](adr/0017-mana-ai-doctor-assistant.md)). It runs on the same local model as the consultation draft: with the model not running the panel says **"Mana is currently unavailable."** and nothing is made up. A question took **78 seconds at the median and up to about three minutes** on the development laptop in the evaluation ([safety/AI_MODELS.md](safety/AI_MODELS.md) §10.5); the suggested-question buttons are quicker, because the model is not asked what to look up.

1. **Patients** → open **Ravi Demo-Synthetic-XXXX**. The **MANA AI — Doctor's Clinical Assistant** panel is closed; press **Open**. It says whom it is about (name, MRN, age and sex).
2. Press **Brief me on this patient**. The panel shows what it is doing (*Reading the records you may see*, *Writing the answer*, *Checking the answer against the records*) and has **Stop**. The answer is a few short statements about the record, with the patient's name, each with **source chips** such as *Allergy · 4 Oct 2026*. Press a chip: it opens to the record item (its type, date, status and its own words) with **Open consultation** or **Open patient record**. Below the statements:
   - **findings** found by fixed rules, not by the model (*Records disagree*, *Possibly outdated*, *Not in the records*), shown whatever the model wrote;
   - **Records read for this answer**, including what was read and not used;
   - **How this was made**: model, that it runs on this computer, the prompt and tool versions and what was looked up.
3. Ask in your own words: *"Who is waiting right now?"*, *"Do I have appointments tomorrow?"*, *"What medicines is Ravi on?"*, then a follow-up such as *"And his allergies?"*. A name that fits several patients (the synthetic hospital dataset has some) makes Mana ask *"I found multiple matching patients. Please select one."* with name, MRN, age and last visit: it never guesses. Open the **New conversation** button to start clean.
4. Try to make it do what it must not: *"Prescribe amoxicillin for this patient"* is refused (*Mana is read-only*), *"What is the usual dose of amoxicillin?"* is not answered (no governed source of medical knowledge), *"Show me every patient's allergies"* is beyond a doctor's work. Nothing is read, written or changed; the prescription stays as it was.
5. Stop the model server (Ctrl+C in the `llm` terminal): the panel says **"Mana is currently unavailable."**, disables the input and looks again every few seconds; start it again and the panel comes back by itself.

What it will **not** do: prescribe, sign, change or delete anything; give advice or answer general medical questions; read another clinic's patients (they are "not found", and the attempt is audited); or fall back to a hosted model. It does **not** write into the note: copy what you choose.

## 3. Doctor consultation with the AI assistant (dr.meera)

Use the seeded **Ravi Demo-Synthetic-XXXX** for this part; he has history to compare against.

1. Queue → **Start consultation**. The workspace has three panels on wide screens: visit and
   timeline, the note, and Mana AI with the other AI panels. The left panel shows today's vitals and the timeline with the
   earlier signed consultation; the banner shows the penicillin allergy.
2. *Live transcription* (left column): consent is already recorded (current wording). Either
   **Start recording** and speak (the transcript appears in 20-second steps with times; assign
   **Doctor** / **Patient** to each line from its speaker chip), or open **Other ways to add a
   transcript** and paste [`demo/consultation-transcript.txt`](../demo/consultation-transcript.txt)
   → **Save typed transcript** (lines S1…S13, with their typed speakers).
3. **Find important points** (it also runs when a recording stops): fixed rules on this
   computer propose *Extracted drafts*, each tied to its source lines, in no state of the
   record until you **Confirm** or **Reject** them. “No, no allergies” is flagged **Conflicts
   with the existing record** (penicillin) and cannot be confirmed without ticking the
   confirmation. **Add to note** is a separate step. In the assistant card, **Generate draft**
   says *unavailable* without a key, or with hosted AI egress off, which is the default (no placeholder text).
4. Prescription → **Add medicine** → *Amoxicillin*. Then **Get recommendations**:
   - rule-based (always): *Check Amoxicillin: recorded allergy to Penicillin* (configured,
     illustrative penicillin group), the *chest pain* red flag with its instruction (the negated
     *“no shortness of breath”* is not flagged), the raised temperature;
   - with a key and hosted AI egress turned on: AI suggestions with *Why*, cited record items and transcript lines, *Not found in
     the data*, and model + prompt version; uncited ones are marked unsupported.
5. Review each item: **Accept**, **Edit**, **Reject** or **Defer**. Accepting changes nothing in
   the note or prescription; use **Add to …** to copy text into the note yourself.
6. Remove Amoxicillin (accepting the safety check), write the note, add diagnosis and a
   suitable prescription, then **Review and sign**. Only what is in the note is signed.
7. **Activity** tab: every job with provider, model, prompt or rules version, data origin
   (*Synthetic data*), retries for failures, every review decision and the audit trail.
8. Optional: **Clinical photographs** → add a synthetic image (JPEG/PNG/WebP); **Stethoscope
   recordings** → upload a synthetic audio file and play it back.

### Mana in the consultation

Open **MANA AI — Doctor's Clinical Assistant** in the right-hand column and press **Allergies on record** (or **Last prescription and medicines**). With Amoxicillin in today's draft prescription, the findings under the answer say **Records disagree**: the draft's Amoxicillin and the recorded penicillin allergy (illustrative configured group), found by the fixed rules whatever the model wrote. Mana does not insert text into the note and does not touch the prescription; use the note's own controls.

### Consultation intelligence: a local AI draft (needs `npm run llm:setup`)

At the top of the right-hand column. Everything it shows is a draft marked **AI DRAFT · AI-GENERATED ·
REQUIRES DOCTOR REVIEW**. Try it on Ravi (penicillin allergy, an earlier signed consultation) after
confirming a few points from step 3 and, for a conflict to show, adding **Amoxicillin** to the prescription.

1. With the model not running, the card says **"Local AI unavailable."** and shows the **record check**
   (fixed rules, not AI): the Amoxicillin–penicillin conflict is there without any model. **Check again**
   re-asks the model server.
2. With the model running, **Generate draft**. The badge reads **GENERATING** with the time elapsed
   ("it can take a few minutes on this computer": about one to four on the development laptop);
   **Cancel** stops it. Do not expect seconds.
3. **READY FOR REVIEW**: the draft is grouped (summary; current problem; relevant history; considerations;
   investigations; medication considerations; missing information; conflicts and uncertainties). Each
   statement has a **support badge** that the server chose (*supported by record*, *inferred*, *not found*,
   *conflicting*, *outdated*), **Checks to make** where the system could not verify something, and
   **Sources** that open to the exact record items it rests on. The Amoxicillin statements read
   **CONFLICTING**, with the rule's own sentence under them.
4. A marked statement shows **I have checked this against the record**; **Accept** stays disabled until
   it is ticked. **Accept**, **Edit** and **Reject** change nothing in the note; **Add to note**, after
   accepting, is a separate click that appends the reviewed text and shows **In the note**.
5. Edit the note (or confirm another point) and the card shows **STALE** with what changed; **Generate a
   new draft** makes version 2 and keeps version 1.
6. Look at *How this draft was made*: model, runtime and weights hash, prompt and rules versions, how many
   record items the model was shown and how many statements the checks removed.
7. If a later attempt fails or you cancel it, the draft you already have **stays on screen** under a note,
   **"The newest attempt did not finish"**; with no earlier draft the badge reads **FAILED** or **CANCELLED**
   and offers **Try again**.

What it will **not** do: diagnose, order, prescribe, write to the diagnoses or the prescription, use the
transcript or anything you rejected, or fall back to a hosted model. If a model answer is made of
statements the record does not support, they are removed and the draft says **PARTIALLY AVAILABLE**.

### Device readings with the simulator (no hardware exists)

No device is connected to this build. To see the device layer, use the **simulator**, a program that generates values:

1. Once: `npm run demo:devices` (registers two simulator records, attaches "Simulator band 1" to the demo patient and writes their tokens to `.data/sim/`).
2. With the application running, in another terminal: `npm run devices:simulate` (steady values every five seconds; `-- --scenario dropout` goes silent for a while; `-- --scenario rising_heart_rate` climbs).
3. Open the demo patient's consultation. The **Device readings** card shows the band with a dashed frame and **SIMULATED**, each value LIVE with its time. Stop the simulator: within 30 seconds the values turn STALE, and after two minutes the device is DISCONNECTED ("the last one received").
4. Look at "This visit" and the banner: they still show what the nurse measured. The simulator's values are not in the visit's vital signs, the patient portal, or anything Mana or the consultation draft reads.
5. "Attach a device" in the card attaches any free registered record; an administrator registers them under Admin > Devices (a simulator can only be registered as one, and stays one).
6. Under **Stethoscope recordings**, "Record" records from this computer's microphone or any other audio input and stores it as "Recorded in the browser". `npm run devices:simulate -- --recording` sends generated tones through "Simulator stethoscope 1" once that record is attached to the patient; they appear as SIMULATED AUDIO.

Say plainly when demonstrating: these are generated numbers on a labelled simulator; no band or stethoscope has been integrated or validated.

### The Doctor HERO demo: a synthetic consultation through the real local models

Needs the local speech model (`npm run speech:model`) and the local language model (`npm run llm:setup`); everything stays on this computer.

1. `npm run demo:hero`: seeds **Anaya Demo-Synthetic** (a fictional child of 6: amoxicillin allergy, a signed consultation two months ago, salbutamol on the medicine list), a new visit ready for Dr. Meera on each run, and the simulator band SIM-BAND-HERO-1 (its token in `.data/sim/`, never printed). Optional: `npm run devices:simulate -- --token-file .data/sim/SIM-BAND-HERO-1.token --scenario fever` (generated values, SIMULATED; never read by the draft).
2. Sign in as dr.meera. **Home** shows Today | Week | Month from the server's counts and today's patients; **My consultations** lists them in time order. Start Anaya's consultation. If her recording consent is on record and the speech service runs, **recording starts by itself** (the header says "Recording 00:05"); otherwise the transcription panel says why not.
3. The workstation: live transcription (main), clinical inputs (staff vitals; a SIMULATED band where simulators are allowed) and the stethoscope, the patient history from the record with orders, the doctor's notes (Pen or Keyboard) and thermal. For the scripted demo, stop the live recording and use the transcription panel's ⋯ → **Play demo consultation**: eight short WAV files (two Windows computer voices, about 30 seconds; `node scripts/demo-audio.mjs --check` verifies them) go through the speech model on this computer, marked **SYNTHETIC AUDIO**; important points appear by themselves for review.
4. Write with the pen (it saves by itself), confirm a point, open **Mana** (bottom right) and ask "Who is my next patient?" or "What did the nurse note?" (fixed rules, no model), or "add amoxicillin 500 mg three times a day for 5 days" (a proposal you approve or cancel; Anaya's amoxicillin allergy is warned about).
5. **Generate prescription** (Ctrl+Enter): "Preparing the consultation" ticks each real step and shows the model's real token count; on this machine's GPU a draft takes about 30–45 seconds. The prescription page opens: add statements to the note, a diagnosis, medicines with their duration in days, advice and follow-up; **Order service** (a SIMULATED laboratory). **Sign & print** signs and opens the print page; printing does not complete anything. **Complete consultation** → confirm → back to My consultations, now Completed. In the patient app, **Today's prescription** shows each medicine's day count.

Say plainly: the audio is synthetic, the draft is a local model's draft for the doctor's review, and the measured time is far from a 10-second target.

## 4. Signed record, drafts and integrity

1. On the patient record, the visit links to the signed consultation.
   - The signed view shows the content hash and **Print prescription**, labelled not valid in this build.
   - Signed records cannot be edited. Corrections are added with **Add amendment**; each is numbered and linked to the record's fingerprint.
2. **Record verification** → **Check now**. It shows the real result of re-checking the stored content, the record rows, the audit copy and the amendment chain against their fingerprints, with what that does and does not mean.
3. **Status history** → **Show**: who moved the visit and the consultation, when, how and why.
4. **My consultations** (doctor menu) lists your unsigned drafts from any day.
   - Drafts from earlier days are flagged; the queue shows today only and warns about them too.
   - **Continue** a draft, or **Discard…** it with a reason. The draft is kept read-only, leaves the patient's history, and the visit goes back to the queue as *Ready for doctor*.
   - **Signed recently** lists the last 30 days.
5. A visit with an unsigned consultation cannot be cancelled or marked as a no-show; the queue explains why.

## 5. Patient access

1. As nurse: patient record → **Patient portal** → issue an activation code (consent required).
2. In a private window open `/activate`: MRN, activation code, a new password → the patient lands
   on their home page: follow-up advice, latest visit.
3. **Records**: the signed consultation with its prescription; **Visits**, **Vital signs**,
   **Consents**, **My details**. Drafts, transcripts, AI output and photographs are not shown.
4. Isolation: opening another patient's record address shows *Record not found*; staff pages
   show a plain "This account cannot access the Doctor App" page with a way back to their own
   workspace; the API answers 403/404 (all audited).
5. On a phone or with the browser's device mode, the portal is responsive and installable
   (browser menu → *Install app*). Only the app shell is cached, never records.
6. **Consents** in the portal: the patient can **Withdraw…** a consent. The dialog says what
   changes at once (e.g. research datasets that include them are blocked); the reason is
   optional. A consent given under an earlier wording is labelled *Earlier wording*.
7. As nurse: the patient record's **Consents** card shows each purpose's state, who withdrew it
   (staff, or the patient in the portal), the reason, and the full **Consent history**.
   **Withdraw…** on *Patient portal* switches the account off at once: the patient's next page
   load goes to sign-in.
8. To restore access: **Record consent** again, then **Issue reset code** on the *Patient portal*
   card; the patient sets a new password at `/activate`. If the patient withdraws portal access
   in the portal themselves, they are signed out with an explanation.

## 6. Appointments (nurse, doctor, patient, admin)

Synthetic data only. Times are on the clinic's clock (shown on every page).

1. **Book** (nurse): **Appointments** → **Book appointment**.
   - Find the patient, choose the department and optionally a doctor, then a date, a time and a length.
   - From a patient's record, the **Appointments** card books for that patient.
2. **Conflicts are refused, not moved.**
   - Book the same doctor at an overlapping time: the dialog says the clinician is taken and keeps your entries.
   - Back-to-back is fine.
   - The same patient cannot be booked twice at overlapping times, with any doctor.
3. Each row shows its time, the patient, the clinician, its status and, when the server allows it, **Check in**. Open **Details** for everything else:
   - **Reschedule…** books the new time and closes the old appointment as *rescheduled*.
   - **Cancel…** asks for confirmation and a reason, and frees the slot.
   - The history and the messages to the patient are there too.
   - The list can be filtered by status (with counts) and by patient name or MRN; the search runs on this device and sends nothing.
4. **Check in** (on the day of the appointment).
   - It creates the patient's visit in **OPD queue** with a token, or joins the visit they already have today. It never makes a second one.
   - The queue row shows the appointment time. No consultation is started.
   - Checking in again does nothing new.
5. **The doctor** (`dr.meera`) lands on **Home**: four numbers (in the queue, with a doctor, completed today, appointments to come), **Today's schedule**, the patients **Ready for you** with *Start consultation*, and shortcuts.
   - The same appointment is in **Appointments → My schedule** (assigned to them, or unassigned in their department), with the visit's state.
   - **OPD queue** (in the menu) is the full queue; start the consultation from there or from Home.
   - **Search patients** in the top bar opens the Patients page with the search filled in (the term is not put in the address).
   - When the consultation is signed, the appointment becomes *Completed* by itself.
   - Cancelling or marking the visit as no-show in the queue closes the appointment the same way.
6. **Messages to the patient.** The appointment's **Details** show each message and its delivery status.
   - Delivery is to the **patient portal only**. No SMS or email is sent.
   - Without a portal account the status is *Not delivered* with the reason.
   - After a booking, move or cancellation a message says whether the patient was told; if not, it says so and that nothing is sent by SMS or email.
   - After the patient activates the portal (see §5 above), **Try again** delivers the messages that still hold. A message about a time that no longer stands (for example “booked” for an appointment that was moved) is not retried.
   - The patient then sees it under **Appointments** in the portal, and **Mark as read** shows staff that it was seen. The booking reason (staff free text) is not shown to the patient, and a booked appointment whose time passed shows as “time has passed”, not upcoming.
7. **Administrator** (`admin`): **Appointments** shows the facility's schedule without patient names or reasons, and cannot change anything. There is no patient search in the top bar for administrators.
8. **On a phone** the menu is a drawer: it takes the focus, Escape or its close button shuts it, and the page behind it cannot be reached while it is open. Below 1280 px the schedule is a list of cards instead of a table.
9. A booked appointment whose time has passed is flagged *Awaiting an outcome*. Mark it **Did not attend…**, reschedule it, or cancel it; nothing does this automatically.

## 7. Oversight (admin)

- **AI operations**: provider status, job counts, failures, review outcomes per model and prompt
  version (*Includes synthetic*), **Store snapshot**. Counts only, no patient data.
- **Audit log**: sign-ins, record reads, AI review decisions, routing, portal reads, denials.
  - **Audit log integrity → Check the chain** recomputes every hash link and shows the current head.
  - Copy the head and keep it outside the system. Later, **Compare** it to detect removal of the newest events or a rewrite.
  - The same check runs from the command line: `npm run audit:verify`.
- **Devices**: registry and gateway tokens. No physical device is integrated
  ([DEVICES.md](DEVICES.md)).
- **Thermal data**: dataset counts, de-identified export and evaluation (labelled non-clinical).

## What the automated tests prove

`npm test` runs the API tests (real PostgreSQL), the service-worker policy tests, the Python
tests and the Playwright suite (desktop and mobile, axe WCAG 2.2 AA, phone-overflow checks). For
this demonstration see `apps/api/test/appointments.test.ts`, `appointments-db.test.ts`,
`appointment-notifications.test.ts`, `e2e/appointments.spec.ts`, `apps/api/test/lifecycle.test.ts`, `integrity.test.ts`, `db-safety.test.ts`,
`e2e/record-lifecycle.spec.ts`, `apps/api/test/mana.test.ts`, `e2e/mana.spec.ts`, `apps/api/test/ai-clinical.test.ts`, `portal.test.ts`, `routing.test.ts`,
`images.test.ts`, `devices.test.ts`, `hardening.test.ts` and `e2e/*.spec.ts`. AI output in tests
comes from test doubles or the test-only mock `e2e/mock-anthropic.mjs`.
