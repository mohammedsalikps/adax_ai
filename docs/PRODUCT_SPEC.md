# ADAXAI Connected Clinical Platform: product specification

This is the specification for an MVP. Everything shown or seeded is synthetic. ADAXAI is not a medical device, is not production-ready, and none of its AI output, rules or measurements are clinically validated. This document makes no claim of legal compliance, clinical safety certification or regulatory approval.

## 1. What ADAXAI is

ADAXAI is a connected outpatient platform. It links four applications through one PostgreSQL record:
- the patient app (installable PWA);
- the nurse app;
- the doctor app;
- the admin console.

The doctor works with **Mana AI**, the doctor's clinical assistant over the clinic's own records: a doctor-facing AI assistant whose outputs require clinician review ([ADR 0017](adr/0017-mana-ai-doctor-assistant.md)). Mana's design rules:

1. **Read-only.** Mana cannot prescribe, sign, change, add, delete, book or cancel anything. No tool writes; a request to is refused in fixed words and nothing is read. Nothing reaches a note or a prescription from Mana.
2. **Authorised before retrieved.** Every question is planned as calls to registered tools; each tool checks the doctor's permissions first and reads only the doctor's own clinic. The language model never queries the database and never sees a patient's name, MRN or telephone number from a record (it works with handles such as P1).
3. **Record first, tied to sources.** Every statement shown rests on records the tools returned and the doctor can open: record type, date, status and the record's own words, with a link. A statement the checks cannot tie to its sources is not shown.
4. **Absence, conflict and age are stated by rules, not by the model.** What is not recorded, records that disagree and records that are possibly outdated come from the fixed rules (`mana-record-v1`) and are shown whatever the model wrote. A name that fits several patients is asked about, never guessed.
5. **A local model writes, code checks.** Plans and answers are written by the language model on this computer; explicit rules remove what they cannot verify and empty an answer that was steered (a link, a claimed action, an identifier nobody gave).
6. **Unavailable, never fake.** With the model not running Mana says **"Mana is currently unavailable."** and nothing else; nothing falls back to a hosted model.
7. **No clinical claim.** Mana gives no advice and no general medical knowledge (no governed source exists), and nothing about it is clinically validated.

## 2. Users and applications

Everyone enters through one front door (`/login`) that offers three applications. The choice only
selects a sign-in page; sign-in, sessions, roles, facility scope and consent are the one existing
system, enforced by the API ([ADR 0011](adr/0011-application-entry-three-front-doors-one-authentication.md)).

| Application | Door | Admits |
| --- | --- | --- |
| Doctor App | `/login/doctor` | doctors and nurses (clinical staff), each landing in their own workspace |
| Patient App | `/login/patient` | patients, by MRN and password (first time: activation at `/activate`) |
| Admin App | `/login/admin` | administrators |

| User | Application | Core jobs |
| --- | --- | --- |
| Patient | PWA (`/patient`) | Activate and sign in; **see their appointments and the in-app messages about them** (booking by the patient is not built); read signed records, prescriptions, vitals, released reports and follow-ups; manage consents. |
| Nurse | `/nurse` | **Appointments** (book, reschedule, cancel, did-not-attend, check-in, message status) and queue; registration with duplicate warning and MRN; consent capture; check-in and intake; vitals with units and source; routing suggestion apply/override; device assignment; portal activation; alert escalation. |
| Doctor | `/doctor` | **Home** (today's queue counts, today's schedule, patients ready, shortcuts); **Appointments** (own schedule or whole clinic, today / upcoming / past); **OPD queue** (`/doctor/queue`); patient search in the top bar; alerts and follow-ups due *(planned)*; patient list and profile; **Mana AI**; three-panel consultation workspace; notes and prescriptions with immutable signed versions and amendments; **My consultations** (unsigned drafts from any day, records signed in the last 30 days); discarding a draft with a reason; record verification and status history. |
| Admin | `/admin` | Staff and roles; facility and departments; routing and alert configuration viewers with versions; device registry; AI job and provider status; review metrics; audit search, filter and export; operational health. |

## 3. Domain entities (PostgreSQL)

Implemented tables are listed in `apps/api/src/db/schema.ts`. Planned items are marked *(planned)*.

| Area | Entities |
| --- | --- |
| Identity | facilities, departments, users (roles: admin, doctor, nurse, patient), sessions, audit_events (append-only, SHA-256 hash chain since migration 0019) |
| Patient | patients (MRN sequence; `data_origin`), allergies, consents (typed, versioned, withdrawable), patient_activation_codes |
| History | **patient_conditions**, **patient_medications**, **investigation_results** (typed in by staff, never deleted or edited, mistakes marked *entered in error* with a reason; database-enforced) and **patient_history_events** (append-only). Read as one model by `GET /api/patients/:id/history`; see [ADR 0013](adr/0013-patient-history-typed-by-staff-never-deleted.md) |
| Flow | visits (daily tokens), **visit_status_events**, **appointments**, **appointment_status_events**, **notifications**, **notification_attempts**, observations (vitals; `source`, `validation_status`, device) |
| Record | encounters (signed snapshot + versioned content hash, or discarded with who/when/why), **encounter_status_events**, diagnoses, prescription_items, encounter_amendments (numbered, hash-linked), **note_insertions** |
| AI | ai_jobs, ai_runs, ai_prompt_versions, ai_settings_snapshots, ai_models, transcripts, **transcript_chunks**, transcript_segments, **transcript_segment_speakers**, clinical_facts, ai_recommendations, ai_evidence, ai_review_actions, **mana_questions**, *(planned)* transcript_corrections (text corrections; speaker review is built) |
| Imaging and devices | clinical_images, image_analyses, thermal_* tables, devices (a record may be a **simulator**, for good), device_assignments (patient, visit, consultation, optional end time), **device_batches** (one accepted gateway request, stored once), auscultation_recordings (how each arrived; simulated or not), *(planned)* alert_rules, alerts, alert_events |
| ML | evaluation_runs, dataset_memberships, *(planned)* model cards and evaluation datasets for text and speech |

### Patient history (slice V1)

A doctor consulting sees the patient's past history from the record, never from the screen's own data: the active allergies with severity and reaction, known conditions with their start, the medicine list (current first, stopped ones with the date and reason), the latest investigation results with the API's flag against their range, earlier **signed** consultations (never drafts, never discarded drafts) with what was prescribed in them, and the latest value of each vital sign with its time and source. Doctors and nurses read it; **only doctors write** (`history:write`); administrators are refused; another facility's patient is "not found" and the attempt is audited. Entries say who entered them and whether they are synthetic. A mistake is **marked as entered in error** with a reason (final, kept, hidden from the history); nothing is deleted and content never changes (a database trigger enforces it). The medicine list is not the prescriptions: earlier prescriptions are shown separately and labelled. There is no laboratory or pharmacy feed; everything is typed in.

### Live consultation capture (slice V2)

A consultation can be captured as it happens, and what is captured stays in three visibly separate states (raw transcript → extracted draft → doctor confirmed). Behaviour, as built:

- **Consent first.** Recording is offered only when the patient's recording consent is on record (for this consultation, or ongoing). The consent is re-checked on every part that arrives, every audio upload and every retry. If it is withdrawn the recording is ended with the reason `consent_withdrawn`, the browser stops the microphone and discards the part in progress, and the server refuses everything further. Missing consent: nothing starts, the screen says what is needed.
- **Local speech-to-text only.** Audio goes from the browser to the API and from the API to a speech model that runs on this computer ([ADR 0014](adr/0014-local-speech-service-and-capture-pipeline.md)). There is no hosted speech provider in the product. With no local service the screen says **Local transcription unavailable** and nothing is sent anywhere instead.
- **Recording.** The doctor starts, pauses, resumes and stops; the browser's own microphone permission applies; the recorder reports a refused or missing microphone, an unsupported browser, a part that could not be sent, and the length recorded. Audio is stored with the consultation under the existing file, access and audit rules.
- **Transcript.** Each segment has its id, start and end on the recording's timeline, text as heard (never translated), language (with how it was decided), a model score where the model gave one (labelled as a model score, not a probability of being right), and the model, runtime and run that produced it. Segments are append-only. A part that could not be transcribed is shown as that, with Retry, and is never filled with guessed text.
- **Speakers.** The speech model identifies no speakers. The doctor assigns Doctor, Patient, Nurse, Relative, Attendant or Other line by line; each assignment is recorded as a review (who, when) and the latest is shown. Nothing is called "diarised".
- **Important points.** Fixed rules on this computer propose points in these categories: chief complaint, symptoms, duration, relevant history (past, medication, family, social), medication mentions, allergy mentions, investigation mentions, patient concerns, doctor observations, assessment, plan and follow-up, with negation and hedging kept, in the speaker's own words, each tied to its source lines, with the rules version and time. English only; other-language lines are skipped and counted on screen.
- **Confirmation.** Each point is *Extracted draft*, *Doctor confirmed* or *Doctor rejected*; only the doctor moves it. A point whose speaker was guessed (no one assigned the line), or that conflicts with the record, needs an explicit tick. Confirmed points are available to later steps (`listConfirmedPoints`); confirming does not write to the note: **Add to note** is a separate recorded insertion.
- **Not built here:** the consultation summary (built in V3, below), speaker identification, live word-by-word text, translation, non-English extraction, retention schedules, any clinical validation.

### Local AI consultation intelligence (slice V3)

A doctor can ask for an **AI-generated consultation draft** while the consultation is open. It is a draft to read, made by a language model that runs on this computer ([ADR 0016](adr/0016-local-ai-consultation-intelligence.md)). Behaviour, as built:

- **Who and when.** Only the doctor who started the consultation, before signing, in their own facility (`ai:use`). The patient's recording-and-AI consent (`ai_recording`, current wording) must be on record; withdrawn, outdated or missing consent stops it, and the refusal is audited. All of this is decided **before** anything is read for the model, and consent (and that the consultation is still open) is read again **after the wait for the model's one slot and when the answer is about to be stored**: a patient who withdraws while a draft waits or while the model is writing gets no draft kept. Another doctor of the facility, a nurse, someone outside the facility and a signed or discarded consultation each get a refusal, not a draft.
- **What the model is given:** the authorised patient record (allergies, conditions, medicines, results, signed consultations, vital signs, the reason for the visit, typed-in history), the doctor's own draft of today's note, diagnoses and prescription, and **only the points the doctor confirmed** during capture. **Never:** the transcript, the audio, unreviewed or rejected points, another patient, another facility. Name, MRN and telephone number are replaced **on a best-effort basis** (the parts of the name, the MRN and the number as recorded, in the ways they are commonly written; a name or number written some other way in free text can get through). If the record is long, items that do not fit are left out (older and less central ones first, never beyond the model's fixed context) and the draft says how many.
- **What comes back:** a clinical summary, the current problem, symptoms, observations, relevant history, allergies, medicines, **potential considerations, potential investigations, potential medication considerations** (suggestions to weigh: never orders and never a dose or regimen; a medication consideration that names a medicine that is not in the record is removed, any other suggestion that does is marked), **missing information** and **uncertainties**. Each statement lists the record items it rests on, why the AI listed it and what is uncertain, in the AI's own words (the checks hold those words to the same rules as a suggestion: a reason that carries a dose, a link, a diagnosis worded as a fact or a figure that is not in the record is dropped and the drop is counted). The system marks each as **supported by record, inferred, not found, conflicting or outdated**; **that decision is made by code from the cited items and fixed rules, never by the model**, and statements the checks cannot verify are removed (and counted) or marked.
- **Conflicts** (for example a drafted medicine against a recorded allergy) are found by **fixed rules**, shown with or without a model and labelled as such. A draft may say **insufficient information**; with too little recorded the model is not asked.
- **Review.** The doctor accepts, edits or rejects each statement; a marked statement needs an explicit tick (enforced by the server). **None of this changes the note, the diagnoses or the prescription.** "Add to note" is a separate recorded insertion of the reviewed text, appended to a note section (an uncertainty is a comment on the record and cannot be added; an older draft cannot be decided or added). Only the doctor who made a draft sees how its statements were reviewed.
- **Time and state.** It takes minutes on this CPU. The screen shows NOT RUN, GENERATING (with the time elapsed and a Cancel), READY FOR REVIEW, PARTIALLY AVAILABLE, INSUFFICIENT INFORMATION, FAILED, CANCELLED, UNAVAILABLE and STALE (the record, the note or the confirmed points changed after the draft). One draft per consultation is made at a time; a new draft is the next version and older ones are kept.
- **No model, no draft.** With the local model not running the screen says **"Local AI unavailable."**, makes no draft and invents nothing; the record check still works. **Nothing falls back to a hosted model.**
- **Audit.** Every draft stores the prompt, schema and rules versions, the model, runtime, weights SHA-256 and whether it ran locally, a hash and manifest of what it was made from, the validation counts, who asked and when; each decision records who and when; the finished draft reaching the doctor's screen is recorded once per doctor and draft (ids and counts, never the words).
- **Not built here:** streaming text, automatic regeneration, other languages, a hosted run of this feature, any route from a draft to the diagnoses, the prescription or an order, patient-facing output, clinical validation, retention or erasure rules for drafts.

### Mana AI, the doctor's assistant (slice V4)

A doctor opens **MANA AI — Doctor's Clinical Assistant** in the consultation workspace or on a patient's record and asks in their own words ([ADR 0017](adr/0017-mana-ai-doctor-assistant.md)). Behaviour, as built:

- **Who and where.** Doctors only (`ai:use`); a conversation belongs to the doctor who opened it and to their clinic. It is opened for a consultation, a patient's record or the clinic in general; "this patient" means the patient of the consultation or record. The panel is **closed until opened** and asks the server nothing before that.
- **Per question.** (1) The local model **plans** what to look up: it sees the doctor's words, the date, patient handles and the last three questions, never a record. (2) The server **validates the plan** and runs **registered read-only tools** (the patient's record by topic, visits, a signed consultation, finding a patient, today's queue, recent check-ins, appointments, the doctor's own consultations, the clinic) after checking the doctor's permissions, scoped to the clinic, and (for a patient) the patient's consent to AI help. (3) The model **writes the answer** from the facts the tools returned. (4) **Code checks** every statement against the facts it cites and removes what it cannot tie to them. (5) The server shows the findings of the fixed rules whatever the model wrote.
- **What a doctor can ask.** About the patient of the open consultation or a named patient: briefing, history, allergies, medicines and the last prescription, vital signs compared with earlier readings, diagnoses, investigations, what changed, a word search, visits, a signed consultation. About the clinic: today's queue (waiting, in triage, ready, with a doctor, done), who checked in in a window, appointments (today, the next hour, tomorrow, a date), the doctor's own consultations, the clinic and its departments. Follow-ups ("and her medicines?") and switching patients work; each handle means one patient in one conversation.
- **Names.** A name that fits several patients is never guessed: up to five candidates are shown with name, MRN, age and sex and the last visit, and the doctor chooses. If the doctor's words name a patient (every word of the name, as written: Rahul Sharma is not Rahul Verma) and the plan is about another, nothing is read and the doctor is asked which they mean. Patients of other clinics are "not found", and the attempt is audited.
- **Sources and uncertainty.** Statements carry source chips in words that open to the record, its status and its words, with a link to the consultation or patient. Findings are labelled *Records disagree*, *Possibly outdated*, *Not in the records* or *Unusual text, not used*; a statement resting on disagreeing or only old records is marked; a statement whose wording goes beyond its sources is marked; statements that could not be verified are counted and not shown. "That information is not established in the available records." when nothing answers the question; **"Mana could not safely verify that response."** when what the model wrote could not be kept.
- **Refusals, in fixed words.** A request to write (read-only); a general medical question (no governed source); a request for more than a doctor's work needs (every patient, other clinics, the audit log, passwords).
- **Time and state.** 78 seconds at the median on this CPU, up to about three minutes in the evaluation (suggested-question buttons skip the planning call). The panel shows the phase in words, **Stop** ends a question, one answer is made at a time per conversation, **New conversation** starts clean, a failed answer says why and can be asked again, and the same idempotency key never makes two answers.
- **No model, no answer.** **"Mana is currently unavailable."**; the question is not stored; the panel looks for the model again by itself.
- **Audit and storage.** Conversations, messages, tool calls and the records an answer rests on are stored append-only; the audit log holds ids, tool names, outcomes and counts, never a question, an answer or a record; the model, prompts, tools and checks versions are stored with each answer. **No retention period is set for conversations** (decision needed).
- **Not built here:** any tool that writes, chaining, clinical search across all patients, streaming text, general medical knowledge, insertion into the note, other languages, a hosted run, a retention schedule, clinical validation.

## 4. State machines

**Appointment** (implemented, [ADR 0010](adr/0010-appointments-visit-linkage-and-notification-outbox.md)): `booked → checked_in → completed`.
- **From `booked`:** also `cancelled` (with a reason), `rescheduled` (a new appointment linked to the old one; the old row is kept) or `no_show` (only after the start time).
- **From `checked_in`:** the appointment follows its visit: `completed` when the consultation is signed, `cancelled` or `no_show` when the visit is closed in the queue. It is never changed by hand.
- **Check-in:**
  - only on the appointment's own day;
  - it creates or joins exactly one visit and starts no consultation;
  - repeating it, or doing it twice at once, makes no second visit.
- **Enforcement:** the API and the database both enforce the transitions. Closed appointments are frozen and rows are never deleted.
- **Time:** an instant, shown on the facility's clock.
- **Slots:** a doctor, and a patient, cannot hold overlapping slots (database constraint).
- **History:** every change is appended to `appointment_status_events` with actor, source, reason and time.

**Notification** (implemented): `queued → delivered | undeliverable | failed`, with every attempt recorded; a delivered message stays delivered and can be read once.
- The only channel is the patient portal. No SMS, email or push is sent.
- Undeliverable and failed messages are retried by staff, and never delivered twice.

**Visit** (implemented, [ADR 0008](adr/0008-record-lifecycle-and-signed-record-verification.md)): `waiting → in_triage → ready → in_consultation → completed`.
- **Manual moves** (queue, `VISIT_TRANSITIONS`):
  - `waiting` → `in_triage`, `ready`, `cancelled` or `no_show`;
  - `in_triage` → `ready`, `waiting` or `cancelled`;
  - `ready` → `in_triage`, `cancelled` or `no_show`.
- **The consultation's moves:**
  - starting it (or its author continuing a paused draft) moves an open visit to `in_consultation`;
  - signing moves `in_consultation` to `completed`;
  - discarding the draft moves `in_consultation` back to `ready`.
- **Rules:**
  - closed visits (`completed`, `cancelled`, `no_show`) never change;
  - while the patient is with the doctor, the visit's doctor and department do not change (editing, routing, database);
  - a visit with an unsigned consultation cannot be cancelled or marked as a no-show;
  - cancelling needs a reason.
- **Enforcement:** the API checks first and the database enforces the same rules (trigger). Every change is compare-and-set.
- **History:** every check-in and change is appended to `visit_status_events`, with the acting user, the source, the reason and the time.

**Encounter (consultation):** `in_progress → signed` or `in_progress → discarded`.
- At most one consultation per visit is not discarded.
- **Signing** is a separate doctor action with an attestation. It needs the visit to be with the doctor.
- **Discarding** is done by the author, with a reason. The draft is kept read-only and leaves the patient's record.
- **Immutability:** signed and discarded encounters are frozen by triggers. Corrections to signed ones are appended as amendments.
- **History:** every change is appended to `encounter_status_events`.
- **Paused drafts:** a draft whose visit is back in the queue (only data from before migration 0019) is paused until its author continues it.

**AI review item** (facts, recommendations, draft items, image analyses): `pending → accepted | edited | rejected | deferred`.
- `superseded` applies when a newer run replaces the item.
- Flagged items need explicit confirmation before they can be accepted.

**Mana question and answer (slice V4):**
- A question stores two rows: what the doctor asked (always `ready`) and the answer, which starts `pending` with a phase (`queued` → `planning` → `retrieving` → `writing` → `verifying`).
- The answer ends exactly once, as `ready` (answered, not established, a choice of patient, or a question back), `refused` (read-only, no knowledge source, beyond a doctor's work, or consent), `unverified` (nothing the model wrote could be kept), `failed` (retryable or not), `unavailable` (the model is not there) or `cancelled` (the doctor stopped it, or consent changed while it was made).
- One answer can be `pending` per conversation. Answers `pending` when the server stopped become `failed` (`interrupted`).
- A finished answer, its sources and its tool calls cannot be changed or deleted (database triggers).

**Mana answer (slice 1, API only since V4):**
- The record answer is written once and never changes.
- The AI part moves from `pending` to `succeeded` or `failed`. Only `failed` can be retried.
- `unavailable`, `consent_required` and `not_requested` are final.
- Marking an answer reviewed, and inserting it into a note, are appended actions.

**Note insertion:** append-only.
- At signing each insertion is recorded in the signed snapshot, with `retained: true/false`, meaning whether the inserted text is still present unchanged.

**Consent** (implemented, [ADR 0006](adr/0006-consent-lifecycle-and-enforcement.md)): `granted → withdrawn`, or `granted → superseded` by a renewal under the current wording.
- A row ends once (database trigger). At most one ongoing grant per purpose is active.
- Computed states: granted, outdated (earlier wording), withdrawn, not recorded.
- Withdrawal ends every grant of the purpose and applies its effects at once:
  - portal account switched off, sessions ended, codes revoked;
  - device assignments ended;
  - research datasets blocked.
- Patients withdraw in the portal; staff grant after reading the wording to the patient.

**Portal account:** `none → active` (activation code). `active → deactivated` when portal consent is withdrawn or staff switch it off. `deactivated → active` with a reset code, after new consent.

**Device assignment:** `active → ended`, and it can end only once.

**Alert** *(planned)*: `open → acknowledged → resolved`, with `escalated` possible from `open` or `acknowledged`.
- Every change is an appended `alert_event`.
- Rules are versioned. Thresholds are **synthetic demo values only**, until a qualified clinical owner supplies approved values.

## 5. Mana AI: the record layer (slice 1) and the screen (V4)

The retrieval layer, the record answers and the rules below were built in slice 1 and are **reused by the V4 assistant's tools** (the assistant calls the same loader and the same rules, and shows their findings). The slice-1 questions API and its stored answers remain; **its screen was replaced** by the assistant's panel in V4.

### Retrieval layer

`apps/api/src/mana/record.ts`:
- Authorization is checked first. Only doctors may call it (`ai:use`), and the patient must belong to the caller's facility; another facility's patient is indistinguishable from a missing one (404). A consultation id must belong to the same patient.
- It reads one patient only, from bounded windows set in `config/adaxai.yaml` → `mana`:
  - the 10 most recent signed consultations;
  - 365 days of vital signs;
  - recent visits;
  - approved thermal measurements;
  - the open consultation draft, labelled as a draft.
- Every item has a stable reference: A allergy, N note field, D diagnosis, M medicine, X amendment, C today's draft, P today's draft prescription, V vital sign, R reason for visit, T thermal.
- Each item also carries its record type, consultation id, date, field, status (signed / amended / draft / active / inactive / recorded), provenance, and an excerpt with identifiers replaced.

### Record answers

`apps/api/src/mana/answers.ts`, rules `mana-record-v2` (`-v1` until slice V5).

Intents:
- briefing;
- history summary;
- last prescription;
- vital signs compared with the previous reading;
- changes since the previous visit;
- allergies;
- diagnoses;
- free-text record search.

The rules flag:
- recorded allergy vs. prescribed medicine (configured, illustrative groups);
- "no known allergies" vs. active allergies;
- disagreeing readings at one visit (configured tolerance);
- records older than `outdatedDays`;
- amended consultations.

### AI summary

- **Gates:** it runs only with a configured provider and a current `ai_record_assistant` consent.
- **What is sent:** only the items relevant to the intent, within `maxContextChars`; the references sent are stored on the job. Age band and sex are sent; name, MRN and phone never are.
- **What is recorded:** job, run, provider, model, prompt version and token counts.
- **Failure:** recorded as failed, retryable where appropriate. The record answer stays.

### Persistence and audit

- **Storage:** `mana_questions` holds the question, intent, record answer and source snapshot. A trigger allows only the AI part to be completed, while it is pending or failed.
- **Review:** the reviewed flag and note insertions are appended to `ai_review_actions` and `note_insertions`.
- **Audit:** `mana.ask`, `mana.read`, `mana.review`, `ai.job_create`, `ai.patient_qa`, `encounter.ai_insert`.

### User interface (V4)

- **Placement:** the right-hand column of the consultation workspace (from 1400 px; stacked below the left column at 1280 px; stacked below that on narrow screens) and on the doctor's patient record. Header **MANA AI — Doctor's Clinical Assistant**; closed until opened.
- **Open:** whom it is about (name, MRN, age and sex) or that it is about the clinic; the conversation; suggested-question buttons (brief me on this patient, allergies, last prescription and medicines, vital signs compared, what changed, visits, my queue, my appointments, my consultations today); the input ("Ask Mana about this patient, today's queue, or hospital records..."); **Send** / **Stop**; **New conversation**; and a footer saying it is a doctor-facing AI assistant whose outputs require clinician review and that it cannot prescribe, sign or change anything.
- **An answer:** statements (patients shown by name), source chips that open to the record, findings with labels, how many statements were removed, "Records read for this answer" (including what was read and not used) and "How this was made" (model, whether it runs on this computer, prompt and tool versions, what was looked up).
- **States:** closed, open, working (the phase in words and **Stop**), answer, source opened, a choice of patient, a question back, refusal, failed (with **Ask again**), "could not safely verify", and **"Mana is currently unavailable."** (disabled input, looks again every few seconds).
- **Not there:** insertion into the note, marking an answer reviewed (the slice-1 actions remain in the API only).

## 6. Acceptance criteria and their tests

| Criterion | Test |
| --- | --- |
| Record answers cite source, consultation, date, field and status; outdated and conflicting records are flagged; no provider gives an explicit unavailable state and no AI job | `apps/api/test/mana.test.ts` › "answers the last prescription with source, date, field and status…" |
| Vital signs compared with the previous reading; disagreeing readings flagged | `mana.test.ts` › "compares today's vitals…" |
| Absence stated | `mana.test.ts` › "states what is absent…" |
| No cross-patient leakage; another patient's consultation refused | `mana.test.ts` › "summarizes history and changes… from this patient's record only" |
| Amendments flagged | `mana.test.ts` › "flags an amended consultation…" |
| Doctors only; facility-scoped; immutable answers; reviews and idempotency | `mana.test.ts` › "is for doctors only…" |
| AI summary is consent-gated, pseudonymised, citation-verified and provenance-recorded | `mana.test.ts` › "needs the patient's consent, sends only this patient's pseudonymised items…" |
| Failure keeps the record answer; retry works | `mana.test.ts` › "a failed summary keeps the record answer…" |
| AI text enters the note only by recorded insertion of reviewed output; duplicates, stale versions and other doctors are refused; signed snapshot keeps references; append-only | `mana.test.ts` › "only by explicit insertion of reviewed output…" |
| Browser (slice 1; **replaced in V4**: the panel it tested no longer exists, see the V4 rows below) | the slice-1 `e2e/mana.spec.ts` is gone; `e2e/mana.spec.ts` now tests the V4 assistant |
| Unsigned drafts from any day listed for their author only, in their facility; list reads audited with patient ids | `lifecycle.test.ts` › "lists only the doctor’s own drafts…", "is for doctors only…" |
| Concurrent starts create one consultation; a paused draft is not editable or signable until its author continues it | `lifecycle.test.ts` › "concurrent starts…", "a draft whose visit is back in the queue is paused…" |
| The database allows exactly the contract's visit transitions; open consultations block cancel and no-show; refused manual status changes audited | `lifecycle.test.ts` › "the database allows exactly the transitions…", "cannot cancel or mark as no-show…" |
| Status history with actor, source and reason; append-only; no anonymous app changes | `lifecycle.test.ts` › "every change records who, how and why…" |
| Discard: reason, author, version; read-only afterwards; visit back to the queue; new start possible; concurrent sign and discard | `lifecycle.test.ts` › "discarding an unsigned draft" |
| Signed-record verification: valid, tampered content, rows or hash, unsupported version, missing hash, legacy v1, notes | `integrity.test.ts` › "signed-record verification" |
| Amendments numbered, timed and hash-linked by the database; changed, removed or reordered ones detected; provenance of AI text preserved | `integrity.test.ts` › "amendments" |
| Audit hash chain: concurrent writes, rollback, altered/deleted/reordered/unlinked events, pre-chain digest, anchors, isolation level, admin API, CLI | `integrity.test.ts` › "audit log hash chain" |
| Application role has no UPDATE/DELETE/TRUNCATE on append-only tables | `integrity.test.ts` › "privileges of the application role" |
| Tests and scripts cannot empty, reseed or migrate the development database | `db-safety.test.ts` |
| Browser: worklist and discard, signed record verification and history, admin chain check with anchor, axe and mobile layout | `e2e/record-lifecycle.spec.ts` (desktop and mobile) |

| A booking is validated field by field (past, horizon, slot, length, department, doctor, patient, facility) and its time is on the facility's clock | `appointments.test.ts` › "booking" |
| A doctor and a patient cannot hold overlapping slots (database); simultaneous bookings: one wins; retries and twins make one appointment | `appointments-db.test.ts` › "no double booking"; `appointments.test.ts` › "two bookings cannot hold…", "a retried request returns…" |
| Time zones and date boundaries: local day vs UTC, nonexistent and repeated clock times, day-boundary listing | `appointments.test.ts` › "time zones and dates" |
| The schedule by day with counts and filters; per-role views; administrators see no identity or free text; no cross-facility access, probes audited | `appointments.test.ts` › "the schedule" |
| Rescheduling keeps both appointments in the history; conflicts, stale screens and closed appointments change nothing; concurrent changes: one wins | `appointments.test.ts` › "rescheduling", "cancelling and not attending" |
| The appointment state machine in the database equals the contract's; closed appointments are frozen; status history is written and append-only | `appointments-db.test.ts` › "appointment state machine in the database", "status history and the visit" |
| Check-in creates or joins exactly one visit, starts no consultation, is idempotent and race-safe (also against a walk-in), and the appointment follows its visit | `appointments.test.ts` › "check-in and the visit" |
| Notifications: one per event, attempts recorded, retry without double delivery, a failing channel does not fail the booking or leak content, consent respected, no clinical content | `appointment-notifications.test.ts` |
| The patient portal shows only the patient's own appointments and messages | `appointment-notifications.test.ts` › "the patient’s own view" |
| Browser: book, conflict, reschedule, cancel; check-in to the queue and completion; portal message delivery and reading; administrator view; axe and mobile layout | `e2e/appointments.spec.ts` (desktop and mobile) |

| **V3** A draft is made in the background from authorised inputs; statements carry sources and a support state that the server decides | `consult.test.ts` › "making a draft" |
| V3 The run, job and audit trail record model, prompt, weights and locality, with counts and ids and never the words | `consult.test.ts` › "records the run (model, prompt, weights, locality)…" |
| V3 Only the doctor's own open consultation, with consent; a nurse, another doctor, another facility, a signed or discarded consultation get nothing and the model is never asked | `consult.test.ts` › "who may ask, and what is refused before anything is read for the model" |
| V3 Only the record, today's notes and confirmed points reach the model; never a rejected or unreviewed point, the transcript or another patient | `consult.test.ts` › "shows only what the doctor may use…" |
| V3 "Local AI unavailable."; no model configured; hosted refused; a wrong-shaped answer, a timeout: each failure is said in words and no draft is made up | `consult.test.ts` › "no model, no draft" |
| V3 One draft at a time, the same request once, cancel, a refused burst, drafts interrupted by a restart | `consult.test.ts` › "one draft at a time, once per request, and a way to stop" |
| V3 Too little to draft from: the model is not asked | `consult.test.ts` › "too little to draft from" |
| V3 Answers that invent or obey an instruction hidden in the record lose everything dangerous | `consult.test.ts` › "what the checks after the model let through"; `consult-validate.test.ts` (all) |
| V3 The draft goes stale when the record moves and says what changed | `consult.test.ts` › "when the record moves, the draft says so" |
| V3 Accept, edit, reject, confirm a flagged statement, and add to the note as a separate recorded act; only the doctor; older drafts cannot be decided | `consult.test.ts` › "the doctor decides" |
| V3 The local client: loopback only, the secret, health, every failure in words, no redirects, schema-checked answers, timeouts and cancellation | `llm-local.test.ts` |
| V3 The model and runtime are pinned; the launcher is closed in and the only thing that downloads | `llm-lock.test.ts` |
| V3 Local by default; hosted only with egress and a key and only when set; none; a down local model is never replaced by a hosted one; no hosted request is made | `egress.test.ts` › "consultation drafts (V3)…" |
| V3 The evaluation harness and its case file | `consult-eval.test.ts` |
| V3 Browser: consent, generating, cancel, ready, review, add to note, stale, unavailable, failed, five widths and axe, against a labelled stand-in server | `e2e/consult.spec.ts` (desktop) |

| **V4** A doctor opens Mana in the consultation, asks about the patient of the open consultation, and gets statements with sources that open to the record, under an "About <name> · MRN" line written by the server; the model is given the patient as a handle, not a name, an MRN or a telephone number | `mana-assistant.test.ts` › "answers about the patient of the open consultation from the record…", "tells the planner the situation in handles…"; `e2e/mana.spec.ts` › "Mana is closed until the doctor opens it…" |
| V4 Questions about the clinic's day are answered from the queue and the schedule; follow-ups keep the patient; switching patients leaves the first behind | `mana-assistant.test.ts` › "answers a question about the clinic’s day…", "answers about appointments…", "follows a follow-up…" |
| V4 A name that fits several patients is asked about, then the chosen one is used without asking the model again; a question that names another patient than the plan is about reads nothing | `mana-assistant.test.ts` › "does not guess between patients who share a name…", "stops a question that names another patient…"; `e2e/mana.spec.ts` › "questions about the clinic’s day…" |
| V4 Missing is not a fact; conflicts, old records and instruction-like record text are shown by rule, whatever the model wrote | `mana-assistant.test.ts` › "does not say "no allergies" when nothing is recorded…", "shows records that disagree and records that are old…", "keeps an instruction written into a signed note away from the model…" |
| V4 Doctors only; a conversation belongs to its doctor; another clinic's consultation, patient, MRN and data are unreachable and the attempt is audited; a handle means one patient in one conversation; at most two patients per question | `mana-assistant.test.ts` › "who may ask, and about whom" (6 tests); `mana-tools.test.ts` (19: permissions before retrieval, clinic scope, consent, ambiguity, malformed calls) |
| V4 Read-only: a request to write is refused in fixed words, nothing is read and nothing changes, even when the planner and the writer go along; no general medical advice; nothing beyond a doctor's work | `mana-assistant.test.ts` › "what Mana will not do" (9 tests); `e2e/mana.spec.ts` › "Mana does not write…" |
| V4 Steered answers are not shown: a link, a claimed action, a handle or identifier nobody gave empty the answer; unsupported statements are removed and counted; source ids cannot be forged | `mana-assistant.test.ts` › "text in a record or in a question that tries to give orders" (5 tests); `mana-answer.test.ts` (34: every check as a rule) |
| V4 "Mana is currently unavailable." and nothing stored when the model is not there (also with none configured or hosted refused); a model that goes away, or is too slow, mid-answer; stop; one answer at a time; one question per idempotency key; restarts | `mana-assistant.test.ts` › "when the model is not there" (6 tests), "restarts"; `e2e/mana.spec.ts` › "when the model is not there…" |
| V4 What is kept: conversation, tool calls, sources, model, prompts; finished rows immutable; audit holds ids and counts only; the server log holds no question, answer or record text; no key, address or secret reaches the browser | `mana-assistant.test.ts` › "what is kept, and what is not shown anywhere else" (4 tests) |
| V4 The plan and its checks as rules | `mana-answer.test.ts` › "the plan the model wrote is made safe to run" |
| V4 The evaluation (through the real local model, opt-in) and its scoring | `mana-eval.real.test.ts` (opt-in, `MANA_EVAL=1`), `apps/api/src/eval/mana.ts`; results in `data/eval/results/mana-v1.md` |
| V4 Browser: closed, open, generating, answer, a source opened, a choice of patient, refusal, error, unavailable, "could not verify", five widths and axe, against a labelled stand-in server; and (opt-in) against the real local model | `e2e/mana.spec.ts` (desktop), `e2e/mana-real.spec.ts` (opt-in) |

Acceptance criteria for the planned slices are written in [AUDIT.md](AUDIT.md) §7 and will move here as each slice lands.

## 7. Languages

- **Now:** the UI is English only.
- **Transcripts:** stored as given, never translated. Every segment carries the language the speech model detected (or the operator's hint) and how that was decided; the original text is always kept.
- **Speech-to-text:** the installed model (`faster-whisper-small`) is multilingual in principle, but **the product supports English only**: English is the only language whose transcription and extraction were measured, on synthetic speech ([safety/AI_MODELS.md](safety/AI_MODELS.md)). Other languages are transcribed if spoken, labelled with the detected language, and the extractor skips them and says so. No accuracy is claimed for any language, English included, on real consultations.
- **Planned:** Tamil, Hindi and code-mixed evaluation on audio, which needs a voice or recordings that do not exist in this repository; code-mixed extraction.
- **Claims:** no accuracy claim is made for any language.

## 8. Architecture decisions

See [adr/](adr/).
