# Doctor App: vertical-slice plan

**Date:** 3 Oct 2026. Companion to [DOCTOR_APP_AUDIT.md](DOCTOR_APP_AUDIT.md), which says what exists today. This plan says what is built next, in what order, and how each step is proven. It is a plan, not a status: [STATUS.md](STATUS.md) records what is actually implemented and tested.

ADAXAI is an interconnected ecosystem, and the **Doctor App is the hero product**. The nurse, patient and admin applications exist to make the ecosystem work around it, on one backend, one authentication, one consent model and one audit trail. From here on the unit of work is a **vertical slice** that runs a real workflow through every layer, not a screen.

## 1. Rules for every slice

1. **No fake functionality.** A control either does something real or is absent. If a part cannot yet be connected to a real implementation it shows an explicit *unavailable* state that says why and what is required, and the requirement is written down here.
2. **Three kinds of content are always visibly different:**
   - consultation text: **raw transcript** → **extracted draft** → **doctor-confirmed**. Nothing extracted becomes a signed fact without a doctor's action;
   - device and image data: **measured data** → **model output** → **clinician interpretation**;
   - provenance of any AI text: which model, which version, **where it ran** (this machine or an external service).
3. **Source and uncertainty are visible.** An AI statement shows what it was based on, or says the record does not establish it.
4. **Authorization is the API's.** Facility scope, roles, consent and default-deny are enforced server-side; a screen is explanation, never protection.
5. **A feature is "complete" only when demonstrated** in a real browser (named widths) and covered by tests at the layers it touches. Reports say plainly what was tested against a mock and what against the real thing.
6. **No claim** of production readiness, clinical validation, regulatory compliance or diagnostic accuracy. Healthcare-software practices (IEC 62304 lifecycle, ISO 14971 risk management, IEC 62366 usability, privacy and security by design) are followed as engineering practice; following them is not compliance.

## 2. Two-chat operating model

| | Chat A: Doctor App | Chat B: ecosystem apps |
| --- | --- | --- |
| Owns | Doctor and nurse clinical workflow pages, the consultation workstation, AI (transcription, extraction, summary, Mana), devices in the consultation, thermal, prescriptions and printing | Nurse queue/registration pages, the patient portal, the admin application, appointments and notifications |
| Backend | Shares it. Additive changes only to shared tables and contracts | Same |

- **This session works as Chat A.** It touches the other applications only where the doctor workflow requires it (for example the patient portal showing a record the doctor signed), and says so in the commit.
- **Never two sessions in one working directory.** Parallel work uses separate branches and Git worktrees (`git worktree add ../adaxai-chat-b -b chat-b/...`).
- **Migrations:** additive only, never edit a committed migration, take the next number after merging `main`, back up the development database first (`npm run backup`, `npm run backup:verify`). Two branches that both add the next number must be reconciled by whoever merges second.
- **Contracts** (`packages/contracts`): additive; a breaking change is agreed first and recorded as an ADR.
- **`doctor-app` (the separate prototype repository) is never touched.**

## 3. AI architecture decision

Recorded in [ADR 0012](adr/0012-local-first-ai-hosted-providers-opt-in.md). Summary:

- **Default: nothing leaves this machine.** The core AI runs on **self-hosted, open-weight models** behind a provider boundary. A hosted provider (Anthropic, a hosted speech service) is an **explicit, documented opt-in** with a visible warning, off by default; setting an API key alone no longer enables it.
- **We do not train a foundation language model.** The layers are: (A) a self-hosted foundation model for language and (separately) speech recognition; (B) **ADAXAI's own intelligence layer**: prompts and instructions, structured-output schemas, patient-context assembly, authorization-aware retrieval, source attribution, safety rules, evaluation sets, regression tests, and model/version tracking; (C) **ADAXAI-owned ML models** only for narrow tasks where data is available, each with dataset provenance, patient-level splits, metrics, failure cases, limitations and reproducible configuration.
- **Local runtime reality on the development machine:** an RTX 2050 with 4 GB of video memory, 15.7 GB of RAM, a 12-thread i5. No speech or language runtime is installed. That points to a **small multilingual speech model (a "small" Whisper-class model, run on CPU or GPU) and a 3-to-4-billion-parameter instruction-tuned language model, 4-bit quantised**. Quality at that size on clinical extraction is limited and **will be measured on a synthetic gold set and reported, not assumed**. Larger models need other hardware.
- **Installing runtimes and model weights is a download and needs the owner's approval** (name, source, size). Until then the AI steps show *unavailable: no local model is running*, and automated tests exercise the real adapters against **clearly labelled test stand-ins** for the model servers (as `e2e/mock-anthropic.mjs` does today). Real-model behaviour is verified only after approval, and is reported separately.
- **No external dataset is downloaded or used** until its licence, permitted use, source, preprocessing and de-identification are verified and written in `docs/safety/DATASETS.md`.

## 4. The vertical slices

The first target is one complete consultation:

> doctor sign-in → dashboard → today's patients → start consultation → patient profile → past history → live transcription → important-point extraction → doctor notes → AI summary → doctor review → signed record → patient sees it.

It is built as three increments, each demonstrable on its own and committed on its own.

### V1. Know the patient: dashboard, queue and the consultation workstation with real history

*A doctor signs in, sees today, starts a consultation and has the patient's real history in front of them.*

**Backend and data**
- Migration (additive): `patient_conditions` (known conditions with a since-date and status), `patient_medications` (current and previous: name, strength, dose, frequency, start, stop, reason), `investigation_results` (test, value, unit, reference range, collected and resulted dates, abnormal flag). Each row records who entered it, when, and **where it came from** (entered by a clinician, or carried from a signed consultation); each has a status including *entered in error* and a history of changes; **nothing is deleted**. A `data_origin` marker on patients and the new tables, so synthetic data is marked in the data and not just in names.
- `GET /api/patients/:id/history`: one read model for the workstation (conditions, current and previous medicines, allergies with severity and reaction, recent investigations, previous consultations with date, doctor, complaint, diagnoses and prescription lines). Doctors and nurses read; doctors write; admin is refused. Every read and write is audited.
- Vitals carry time and source in the read model.
- **Synthetic hospital dataset v1** (`npm run demo:seed -- --hospital`, idempotent, never touches non-synthetic rows): about twelve patients across three departments with realistic, internally consistent histories, three doctors and two nurses, today's appointments, a queue in every state, earlier signed consultations, medications, allergies, investigations and vitals. Every row marked synthetic. (Device readings, thermal studies, transcripts and AI outputs follow with the slices that use them.)

**UI (the reference direction)**
- Dashboard: greeting, date, department chip, four stat cards, today's schedule with *Start*, quick actions that go somewhere real.
- *Today's patients*: tabs (All, Waiting, In room, Completed) with real counts, date picker, table with avatar, age and sex, reason, status chip, *Start consultation* and an overflow menu.
- Consultation workstation shell: back arrow, title, **Live badge and elapsed timer** (from the consultation's start time), patient banner with allergy and condition chips, appointment time and department, Print, Save and Complete; three columns from a wide laptop screen, two on tablet, one on a phone.
- **Past History** panel with tabs Summary, Consultations, Medications, Allergies, Investigations, all from real data, each with loading, empty, error-with-retry and refused states.
- **Patient profile slide-over** (overview, full history, documents) opened from the banner.
- Shared components added: Tabs, Drawer, overflow Menu, photo-or-initials Avatar, Sparkline.
- Vitals tiles that show **time, source and state** (recorded manually, device-unverified, how long ago). No live-device claim yet.
- Things in the reference with nothing behind them stay out or are labelled: the *Stethoscope (Live)* card and the *Digital Writing Pad* show an explicit *not available yet* state naming what is required; Reports and Settings are not added.

**Done when:** every item above works against real data, the existing consultation e2e specs still pass unchanged in intent, new API, DB and e2e tests cover the history model (including refusals and the audit), screens are checked in Chromium at 1440, 1280, 1024 and 390 pixels wide, and the adversarial review rounds find nothing new.

### V2. Capture the consultation: local transcription and important points

*The doctor records, sees a timestamped transcript and the important points the AI found, each marked as a draft.*

> **Status (4 Oct 2026): built, with these differences from the plan below** ([STATUS.md](STATUS.md), [ADR 0014](adr/0014-local-speech-service-and-capture-pipeline.md), [safety/AI_MODELS.md](safety/AI_MODELS.md)). (1) Speech is a **dedicated local service** (`services/speech`, `faster-whisper` `small`, CPU), not an OpenAI-compatible adapter, and **there is no hosted speech provider at all**; the provider setting is `none` / `local`. (2) The **language-model provider registry and a local chat model were not built**: extraction is **local fixed rules** (`extract-rules-v1`), so no language model was needed for V2; the registry (ADR 0012 items 1, 3 and 6) moves to V3. (3) The **waveform** is a real microphone **level bar**, not a drawn waveform. (4) The "Key Points" box is the **Important points** card, with raw transcript / extracted draft / doctor confirmed / rejected shown differently. (5) Measured on **synthetic** speech and scripts only; held-out extraction recall is 53 %, and Hindi, Tamil and code-mixed speech were not evaluated. (6) Open items: hosted transcript egress from the drafting and recommendation steps (needs an explicit setting), retention/erasure/encryption decisions, the consent-wording review.

- **Provider registry and local-first AI** (ADR 0012): a registry for language and speech providers; an OpenAI-compatible **local** adapter (chat completions with JSON-schema output; audio transcription with segment timestamps and language); the setting `ai.provider` = `none` (default) | `local` | `hosted`; the hosted adapter stays but must be selected on purpose, and the consent wording and screens say when text leaves the machine. The output schemas move out of the Anthropic adapter so every provider shares them. Each AI run records provider, model identifier, **local or external**, runtime and (where available) a weights digest.
- **Transcript v2:** segments with start and end time, confidence, detected **language** (shown as a chip), and speaker. Speaker comes from a typed label, from the provider if it supplies one, or **from the doctor assigning it in the transcript** (a visible per-line control); nothing is labelled "diarised" unless a diariser produced it.
- **Waveform** from the microphone's real signal (Web Audio level analysis), never an animation.
- **Extraction v2:** *patient concerns*, *duration*, *investigations mentioned* become first-class categories alongside the existing chief complaint, symptoms, history, allergies, medications, observations and follow-up. Each fact keeps its source excerpt and timestamp.
- **Key Points (AI)** box on the workstation: pending facts, each visibly a draft, with *confirm / edit / dismiss*.
- **Evaluation:** a synthetic gold set (scripted consultations with labelled facts), a harness that reports per-category precision and recall, a model card and regression thresholds. Numbers are reported only for models actually run.
- When no local model is running the panel says so and offers the typed-transcript path, which already works.

**Done when:** the adapters pass contract tests against labelled local stand-ins for both model servers; the full capture flow passes e2e against those stand-ins; the harness runs; and, **if the owner approves installing a speech runtime and a language model**, the same flow is run against the real local models and the measured quality and latency are reported separately from the stand-in results.

### V3. Summarise, review, approve

> **Status (4 Oct 2026): built as the owner's brief "V3: local AI consultation intelligence", with these differences from the plan below** ([STATUS.md](STATUS.md), [ADR 0016](adr/0016-local-ai-consultation-intelligence.md), [safety/AI_MODELS.md](safety/AI_MODELS.md)). (1) The model is a **local open-weight language model** (llama.cpp, Qwen3.5-4B Q4_K_M, owner-approved downloads, pinned and hash-checked) behind a **provider abstraction** (`local` / `hosted` behind the egress policy / `none`, no fallback). (2) The draft is **structured** (summary, problem, symptoms, observations, history, allergies, medicines, considerations, investigations, medication considerations, missing information, uncertainties), each statement with its sources and a **support state decided by code**, with **fixed-rule conflict detection**; it uses **confirmed points, the record and the doctor's notes, never the raw transcript**. (3) The right-hand panel is one **Consultation intelligence** card, not tabs; "Approve & add to note" is the existing two-step *Accept* then *Add to note*. (4) Not built: the full sign-in-to-patient-portal end-to-end test of this slice, and any clinical validation. (5) Measured with the real model on **12 synthetic cases** only. (6) A draft takes **minutes** on this CPU.

*The doctor gets a sourced draft summary, edits or rejects it, approves it into the note, signs, and the patient sees the record.*

- **Consultation summary capability** (structured output): patient context, current visit, an assessment draft and a suggested-plan draft (advice, tests to consider, medication *considerations*). Each statement cites transcript segments or record items; anything the evidence does not support is omitted or marked "not established". The deterministic allergy and interaction rules remain in front of it. **The AI never creates a diagnosis or a prescription row**; the doctor does.
- **Right panel** as in the reference: tabs *AI summary*, *Recommendations*, *Mana AI*; the draft notice; *Edit*, *Reject*, **Approve & add to note**, which inserts the reviewed text into the note through the existing recorded insertion with provenance. The summary says which transcript version it used and can be regenerated.
- Doctor review is audited; sign, amend, verify and print are unchanged.
- End-to-end e2e from the sign-in to the patient portal.

**Done when:** the full chain passes e2e on desktop and phone, the audit trail shows every step, and the safety review confirms the AI cannot sign, prescribe or diagnose.

### After the first workflow (each its own vertical slice)

| Slice | Content |
| --- | --- |
| V4 Mana workstation | **Built (4 Oct 2026) as the owner's brief "V4: Mana AI, the doctor-facing hospital intelligence assistant", with these differences from the row as first written** ([STATUS.md](STATUS.md), [ADR 0017](adr/0017-mana-ai-doctor-assistant.md), [safety/AI_MODELS.md](safety/AI_MODELS.md) §10): (1) there is **no separate Mana page**: it is a panel on the right of the consultation workspace and on the patient record, closed until opened (a page would have no patient and no consultation to be about); (2) intent detection by patterns was replaced by **a plan written by the local model and validated by code**, run through **ten registered read-only tools** with the doctor's permissions checked first; (3) retrieval is cross-patient only in the sense of the clinic's day (the queue, check-ins, appointments, the doctor's own consultations) and of finding a named patient: **there is no clinical search across all patients**; (4) "previous medicines as taken" is not built (the record holds prescriptions, not what the patient took); (5) the answer is written by the local model and **checked by code**, with structured sources and findings from the fixed rules; refusals are fixed words; (6) it is **read-only**: no tool writes and nothing is inserted into the note. Original row: a Mana page and cross-patient, authorization-aware retrieval (who visited, who is waiting, previous consultation, previous medicines as taken), intent detection beyond patterns, structured evidence and sources; refusal when the record does not establish an answer |
| V5 Devices | **Built (5 Oct 2026), with these differences from the row as first written** ([STATUS.md](STATUS.md), [ADR 0018](adr/0018-device-readings-states-gateway-and-simulator.md), [DEVICES.md](DEVICES.md)): (1) the states are live, stale, disconnected, **no data** and unavailable, and **simulated is not a state but a mark** on the record and on every value (a simulated value is also live or stale); (2) simulated values are kept out of the visit's vital signs, the patient portal and everything a model or the record rules read, not merely labelled there; (3) "readings that reach the consultation" is a card that is re-read every five seconds (no push channel), and in visit summaries **what staff measured stands** over a device's stream; (4) the stethoscope boundary is a gateway upload route plus recording in the browser from an audio input; the stethoscope simulator sends generated tones; (5) batches are stored once (idempotency), and an assignment can carry a consultation and an end time; (6) **no device, SDK or gateway program exists**, and no reading is anything but unverified. Original row: a reading-state model (live, stale, disconnected, simulated, unavailable) across schema, API and UI; a **labelled simulator**; a stethoscope integration boundary and a simulator that is never presented as a real device; readings that reach the consultation; a gate on which kinds a device may send (no blood-pressure claim without a validated pipeline) |
| V6 Thermal in the consultation | Thermal panel in the workstation; measured data, model output and clinician interpretation separated; image quality and uncertainty; **any trained model with dataset provenance, patient-level splits, metrics, failure cases and a model card**, or none |
| V7 Prescription and documents | Prescription and document generation, print audit event, completion of the printed record |
| V8 Consultation audit trail | The doctor sees the full trail for a consultation; an entity filter in the admin audit log |
| V9 Digital writing pad | Handwritten notes: ink model, storage, retention, display in the signed record |

## 5. Safety documentation (grown with the slices)

| Document | Content | When |
| --- | --- | --- |
| [safety/INTENDED_USE.md](safety/INTENDED_USE.md) | Intended use, users, system boundary, what the software does not do | with this plan |
| [safety/RISK_REGISTER.md](safety/RISK_REGISTER.md) | Hazards, causes, controls in the product, residual risk, verification | started with this plan; updated every slice |
| `safety/AI_MODELS.md` | Each model and version, where it runs, what it is used for, limitations, evaluation results | V2 |
| `safety/DATASETS.md` | Provenance of every dataset (synthetic generators, any external set with licence), splits, de-identification | V2 |
| `safety/USABILITY.md` | Intended users, use scenarios, formative checks, known use errors | V3 |
| Data retention and access control | Extended from the existing audio retention setting and role matrix | V1 onward |

## 6. Open decisions for the owner

1. **Install a local speech runtime and a local language model?** *Speech: answered and done in V2* (owner chose `faster-whisper` `small`: about 70 MB of packages and 486 MB of weights, both pinned and checksummed). *Language model: answered and done in V3* (owner approved `Qwen3.5-4B` Q4_K_M, 2.74 GB, and `llama.cpp` b11379, 19 MB, both pinned and checksummed). Each item is listed with its source and size before anything is downloaded.
2. **Hosted keys in this machine's `.env`.** Hosted providers are off unless selected on purpose (V2.1; the local reasoning model since V3 never falls back to them); remove the keys if hosted use is not wanted.
3. **Nurses use the Doctor App's sign-in** (decision carried from slice 4a).
