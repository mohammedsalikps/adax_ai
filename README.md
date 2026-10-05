# ADAXAI MVP

ADAXAI Connected Clinical Platform: a role-based clinical web platform (Doctor, Nurse, Admin and
Patient portals) with **Mana AI**, the doctor's clinical assistant over the clinic's own records; a Fastify API on
PostgreSQL; and a Python service for thermal imaging, image validation and dataset evaluation.

Product specification: [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) · design system: [docs/DESIGN.md](docs/DESIGN.md) · audit of the current state:
[docs/AUDIT.md](docs/AUDIT.md) · progress and test results: [docs/STATUS.md](docs/STATUS.md) ·
decisions: [docs/adr/](docs/adr/) · what the Doctor App actually does today:
[docs/DOCTOR_APP_AUDIT.md](docs/DOCTOR_APP_AUDIT.md) and the plan for its first complete consultation workflow:
[docs/DOCTOR_APP_PLAN.md](docs/DOCTOR_APP_PLAN.md) · safety records (prototype): [docs/safety/](docs/safety/).

> **Status: MVP in development.** Use synthetic data only. This software is not a medical
> device, is not clinically validated and is **not production-ready** (see
> [Known limitations](#known-limitations)).

## What is implemented

| Area | What is real today |
| --- | --- |
| Foundation | PostgreSQL 17.10 (UTF-8), checksummed migrations, API, web app, Python service, YAML settings validated at start-up |
| Sign-in and access | Session sign-in, roles (admin, doctor, nurse, patient), server-side default-deny permissions, forced temporary-password change, lockout, append-only audit log linked by a SHA-256 hash chain (check from the admin portal or `npm run audit:verify`) |
| Admin portal | Users, departments, audit log viewer, operational overview, system status, devices registry, thermal data, AI operations (counts only) |
| Patients | Registration (auto MRN, duplicate warning), search by name/MRN/phone (incl. non-Latin scripts), profile, allergies with explicit “no known allergies”, consents (grant/withdraw, versioned wording, history kept), patient-portal activation codes |
| OPD queue and nurse workflow | Check-in with atomic daily tokens, one open visit per patient per day, priority, department/doctor assignment, server-enforced status transitions, vitals with plausibility checks and adult reference-range flags (not applied under 18; display aid only), entered-in-error corrections, auto-refresh |
| Routing assistance | Deterministic rules in `config/routing.yaml` (department, red flags with escalation instructions, urgent-for-review priority, missing intake, least-busy clinician); staff apply or override with a reason; rules version stored |
| Doctor consultation | Structured note, diagnoses (ICD-10 format check only), prescription editor, autosave with conflict detection, review-and-sign with attestation, signed records frozen in the database with a SHA-256 content hash, append-only amendments, printable prescription (labelled not valid), patient timeline |
| Mana AI (the doctor's clinical assistant, V4) | A **read-only conversation with the clinic's own records**, in a panel on the right of the consultation workspace and on the patient record (closed until opened). Ask about a patient (briefing, history, allergies, medicines, vital signs, results, a signed consultation) or about the clinic's day (who is waiting, who checked in, appointments, your consultations). A **model on this computer plans** what to look up (it never sees a record, a name, an MRN or a telephone number from one), the **server runs only registered read-only tools** after checking your permissions, scoped to your clinic and the patient's consent, the model **writes the answer from what they returned**, and **code removes whatever it cannot tie to the records**; conflicts, old records and what is not recorded come from fixed rules and are shown whatever the model wrote. A name that fits several patients is asked about, never guessed; every answer about a patient starts with "About <name> · MRN", written by the server. Every statement has source chips that open to the record. It **cannot prescribe, sign, change or delete anything**, answers **no general medical question**, and says **"Mana is currently unavailable."** when the model is not running (needs the one-time `npm run llm:setup`; 78 seconds at the median per question on a laptop CPU, up to about three minutes). Conversations are stored append-only; the audit log holds ids and counts, never question or answer text. [ADR 0017](docs/adr/0017-mana-ai-doctor-assistant.md) |
| AI text in notes | AI or rule output enters a note only through a server-recorded insertion of reviewed output, which keeps a reference to the AI artifact (provider, model, prompt or rules version); shown under the note section, in the sign dialog and on the signed record; listed in the signed snapshot |
| Live consultation capture (V2) | Consent check, browser microphone recording (start, pause, resume, stop), **local speech-to-text** in 20-second parts (a speech model that runs on this computer; no hosted speech service exists in the product), a timestamped transcript with language, doctor-assigned speakers, **important points** proposed by fixed rules and confirmed or rejected by the doctor (raw transcript, extracted draft and doctor-confirmed are kept visibly apart). Needs the one-time `npm run speech:model` download; without it the screen says "Local transcription unavailable" |
| Local AI consultation intelligence (V3) | A **language model that runs on this computer** (llama.cpp with Qwen3.5-4B; no key, nothing leaves it) reads the authorised record, the doctor's notes and **only the confirmed points** and writes an **AI-generated draft** for the doctor: summary, symptoms, observations, history, allergies, medicines, **potential considerations, investigations and medication considerations** (never orders or doses), **missing information** and **uncertainties**. Every statement cites the record items it rests on; **code, not the model, decides each statement's support state** (supported by record / inferred / not found / conflicting / outdated) and removes or marks what it cannot verify; conflicts come from fixed rules. The doctor accepts, edits or rejects each one; nothing reaches the note, diagnoses or prescription without a separate "Add to note". It takes **minutes** on a laptop CPU, can be cancelled, is versioned and audited, and goes **stale** when the record changes. Without the model the screen says **"Local AI unavailable."**; there is **no fallback to a hosted model**. Needs the one-time `npm run llm:setup` download (about 2.74 GB). Measured on 12 synthetic cases only: [docs/safety/AI_MODELS.md](docs/safety/AI_MODELS.md); [ADR 0016](docs/adr/0016-local-ai-consultation-intelligence.md) |
| AI consultation assistant | Consent, note drafting, deterministic comparison with the record, evidence-backed fact review, (the transcript and important points are in the capture cards), deterministic comparison with the record, rule-based safety checks (no AI needed), history-aware recommendations citing record items, accept/edit/reject/defer for every AI output with confirmation gates, jobs with retry and idempotency, activity and audit trail. See [AI: what is and is not real](#ai-what-is-and-is-not-real) |
| Clinical photographs | Consent-gated JPEG/PNG/WebP upload validated by the Python service (DICOM rejected), original kept unchanged, metadata-free preview, optional AI description marked unverified and reviewed before use |
| FLIR thermal imaging | Consent-gated radiometric JPEG upload with capture protocol, per-pixel °C matrix via `flyr`, viewer, regions with statistics and paired differences, doctor approval (then frozen) |
| Thermal data workflow | Clinician labels (versioned taxonomy, withdraw-only), data origin per image, experimental rule-based flags (not validated), de-identified dataset export (research consent only), evaluation pipeline that refuses to train without enough labelled data |
| AI oversight | Admin AI operations (counts only), doctor review list of rejected/edited AI output, review-outcome snapshots as evaluation runs, checksummed prompt versions, model registry, settings snapshots |
| Patient portal (PWA) | Activation with MRN + one-time code; the patient's own signed records with prescriptions and amendments, visits, vital signs, consents, profile and allergies, approved thermal measurements; installable (manifest, icons, service worker that caches only the app shell, never `/api/`) |
| Devices (V5) | **Integration boundary with reading states and a labelled simulator; no hardware integrated.** Registry, assignment to a consenting patient (for a visit and a consultation, optionally until a time), a token-authenticated gateway that stores a batch **once**, accepts only the kinds a device may send (**never blood pressure**) and stores readings as *device, unverified*. In the consultation a **Device readings** card shows each value with its time and a **state** decided on the server's clock (live, stale, disconnected, no data, unavailable), re-read every 5 seconds; it is not a monitor and raises no alarm. Where staff and a device both supplied a value, **the staff measurement stands**. A **simulator** (`npm run demo:devices`, `npm run devices:simulate`) generates values to exercise all of this without hardware: what it sends is stored and shown as **SIMULATED**, and is never in a visit's vital signs, the patient portal, or anything a model or the record rules read. Stethoscope: upload, **recording in the browser** from an audio input, playback; no analysis. See [docs/DEVICES.md](docs/DEVICES.md), [ADR 0018](docs/adr/0018-device-readings-states-gateway-and-simulator.md) |
| Record lifecycle | Visit and consultation state machines enforced by the API and the database, with status history (who, when, how, why); **My consultations** worklist of unsigned drafts from any day and recent signed records; discarding a draft with a reason (kept read-only); versioned signed-record verification including the amendment chain; see [ADR 0008](docs/adr/0008-record-lifecycle-and-signed-record-verification.md) |
| Appointments and notifications | Booking and rescheduling by staff on the facility's clock, with no double booking for a doctor or a patient (database constraints), cancel and did-not-attend with reasons, status history, **check-in that creates or joins exactly one visit** (idempotent, race-safe) and starts no consultation, schedule pages for doctors, nurses and administrators (administrators see no patient identity or free text), the patient's own appointments in the portal. Messages go through an outbox with recorded attempts and safe retries; **the only channel is the patient portal: no SMS, email or push is sent**. See [ADR 0010](docs/adr/0010-appointments-visit-linkage-and-notification-outbox.md) |
| Doctor workstation (slice V1) | **Today's patients** (tabs, day picker, row menu); a dashboard greeting the doctor with real counts and the day's patients in time order; a consultation workstation with a header (draft, elapsed time), a banner (allergies with severity, conditions, vital-sign status), vital signs with time and source, a **Past history** panel (summary, consultations, medications, allergies, investigations: typed in by staff, never deleted, mistakes marked *entered in error*), a rule-composed patient summary (not AI) and a profile side sheet. A synthetic hospital dataset: `npm run demo:hospital`. See [ADR 0013](docs/adr/0013-patient-history-typed-by-staff-never-deleted.md), [docs/AI_STATUS.md](docs/AI_STATUS.md) |
| Application entry | A front door at `/login` with the **Doctor App**, **Patient App** and **Admin App**, each with its own sign-in page (`/login/doctor`, `/login/patient`, `/login/admin`) over the one existing authentication: the API refuses an account at the wrong door before any session exists, a page says plainly when an account has no access to another application, and sign-in failures (invalid, locked, rate-limited, service down) say what to do. See [ADR 0011](docs/adr/0011-application-entry-three-front-doors-one-authentication.md) |
| Operations | Cold backup / verify / restore, audio retention, orphan-file check, synthetic demo seed, audit-chain verification, database identity guard for test tooling |

## Accounts and security model

- **Where to sign in:** open `http://localhost:5173` and choose the application. Doctors and
  nurses use the **Doctor App** (`/login/doctor`; each lands in their own workspace),
  administrators the **Admin App** (`/login/admin`), patients the **Patient App**
  (`/login/patient`, with their MRN). The choice is a front door, not a permission: the API decides
  from the account, and an account at the wrong door is refused.
- **Demo staff accounts** (synthetic): `admin`, `dr.meera`, `dr.rahul`, `nurse.anil`. Sign in
  with the **username** (not an email address; not case-sensitive). The password for all four is
  the value of `SEED_DEMO_PASSWORD` in your local `.env` (a random 32-character value generated by
  `npm run setup`; copy it exactly, without spaces). Seeded accounts are not asked to change it.
  To see it in PowerShell: `Select-String -Path .env -Pattern '^SEED_DEMO_PASSWORD='`.
- **Demo patient account**: none is pre-created. A nurse records portal consent and issues an
  activation code on the patient's record; the patient activates at `/activate` with their MRN,
  the code and a password of their choice (see [docs/DEMO.md](docs/DEMO.md)).
- **Passwords** are hashed with Argon2id. Staff created by an administrator get a temporary
  password and must change it at first sign-in.
  Five failed attempts lock an account for 15 minutes:
  - the lockout is atomic, so concurrent guesses count;
  - unknown usernames get the same locked answer;
  - wrong current passwords at a password change count too.
  Sign-in, activation, password change and device ingestion are also rate limited per address,
  account, user or token (`config/adaxai.yaml` → `security.rateLimits`; kept in memory).
  Unknown usernames are never written to the audit log.
- **Sessions** are server-side: an `httpOnly`, `SameSite=Lax` cookie with a random token; the
  database stores only its SHA-256 hash. 60 minutes idle / 12 hours absolute.
- **Authorization is enforced by the API on every route** (default deny;
  `apps/api/src/auth/permissions.ts`).
  - Every `/api` route must declare `public`, a permission or `anySession`, or the API refuses to
    start. A test checks the full route-by-role matrix.
  - Staff and admin data are limited to the caller's facility; a patient or consultation of
    another facility is "not found", and the attempt is audited.
  - The web app hides controls too, but that is convenience only.
  - Denied requests are audited, including refusals inside routes.
  - Administrators cannot read clinical records. They see that a device is in use, not by whom.
  - Only the doctor who signed a consultation can amend it.
  See [ADR 0007](docs/adr/0007-default-deny-routes-facility-scope-and-denial-audit.md).
- **Patient isolation:** portal routes take the patient from the session and never accept a
  patient id; patients cannot reach any staff, file, AI, image, thermal or device endpoint.
  Tests probe every route family as patient A with patient B's ids.
- **Consent** is enforced by the API for every purpose:
  - recording and AI;
  - Mana AI (a patient who withdrew `ai_record_assistant` is not read, even by the local model; with a model that is not local it must be granted);
  - photographs and their AI description;
  - thermal images;
  - device readings;
  - portal access;
  - research datasets.
  States are granted, granted under an earlier wording (renew), withdrawn, and not recorded.
  Withdrawal takes effect at once:
  - portal access: the account is switched off and the patient signed out;
  - device consent: device assignments end;
  - research consent: datasets that include the patient are blocked.
  Patients can withdraw their own consents in the portal. Refusals are audited. See
  [ADR 0006](docs/adr/0006-consent-lifecycle-and-enforcement.md).
- **CSRF:** state-changing requests must carry `x-adaxai-csrf: 1`.
- **Responses:** every API response is `Cache-Control: no-store` with `nosniff`, `no-referrer`
  and `X-Frame-Options: DENY`.
- **Audit log:**
  - sign-ins and permission denials;
  - every read of a patient's record, files, AI artifacts, images, thermal data and portal pages;
  - the patients each list or search disclosed;
  - every change and every AI review decision;
  - consent grants, renewals, withdrawals and refusals.
  Each row carries its facility. Database triggers make the log append-only, and the API's
  database role has no UPDATE or DELETE on it (or on any other append-only table).
  Since migration 0019 every event is linked into a SHA-256 hash chain by the database. Events
  from before that are summarised by a digest in the chain's first event.
  - Changed, removed, reordered or unlinked events are reported by the check.
  - Removal of the newest events, or a full rewrite by someone with database superuser access,
    is detected only against a head recorded outside the system. It is tamper evidence, not
    tamper proofing. See [ADR 0009](docs/adr/0009-audit-hash-chain-and-append-only-privileges.md).

  Request logs record paths only (never search terms).
- **Signed records** carry a versioned SHA-256 fingerprint (`adaxai.encounter.v2`; older records
  `v1`); amendments are hash-linked to it. **Record verification** re-checks them on request.
  A match is not a digital signature and says nothing about clinical correctness.

## Requirements

- **Node.js 22.12+** (developed on Node 24.13) and npm
- **Python 3.11+** (developed on 3.12; on Windows found through the `py` launcher, or set `PYTHON`)
- No Docker, no PostgreSQL install, no admin rights. PostgreSQL binaries come from the
  `embedded-postgres` npm package.
- Verified on Windows 11 (x64) only. macOS/Linux binaries exist in the same package but these
  scripts are **not verified** there.
- Optional: `ANTHROPIC_API_KEY` (drafting, recommendations, Mana summaries, image description), **and only if you also allow hosted AI
  on purpose**: a key alone sends nothing (`AI_EGRESS_HOSTED=true`, below). Speech-to-text needs **no key**: it is a local model.
  Everything else works without them.
- Optional, one-time **download** for live transcription (about 70 MB of Python packages and a
  486 MB model, from PyPI and Hugging Face; MIT-licensed): `npm run speech:setup` (done by
  `npm run setup`) then `npm run speech:model`. `npm run dev` starts the local speech service on
  `127.0.0.1:8002` and the API uses it when `SPEECH_PROVIDER=local` is in `.env`.
- Optional, one-time **download** for the local consultation draft (a 19 MB llama.cpp runtime and a
  2.74 GB Qwen3.5-4B model, from GitHub and Hugging Face; MIT and Apache-2.0; each file is checked
  against the SHA-256 pinned in `services/llm/*.lock.json` and a mismatch is deleted): `npm run llm:setup`
  (asks first). `npm run dev` then starts the model server on `127.0.0.1:8081` with a per-install secret
  (`.data/llm/api-key`, never shown); without it the screen says "Local AI unavailable." and everything
  else works. It runs on the CPU and needs about 4.5 GB of free memory while it answers (measured on the development
  laptop: 2.2 GB committed and 4.2 to 4.5 GB resident at most, flat over many requests because the launcher
  switches prompt caching off, so it keeps no copy of earlier prompts); a draft takes minutes (68 to 214 seconds
  for the twelve evaluation cases on that laptop).

## Quick start

```bash
npm install
```

```bash
npm run setup
```

```bash
npm run dev
```

Then open <http://127.0.0.1:5173>. For a demonstration patient with history:

```bash
npm run demo:seed
```

`npm run setup` is safe to re-run. It creates `.env` from `.env.example` with generated local
passwords, initialises and starts PostgreSQL, creates the app role and the dev/test/e2e
databases, runs migrations, seeds synthetic staff, creates the Python virtualenv, fetches the
public thermal sample files and installs Playwright's Chromium (`-- --skip-browsers` skips it).

PostgreSQL keeps running after `npm run dev` exits; stop it with `npm run db:stop`.

## AI: what is and is not real

| Capability | Status |
| --- | --- |
| Transcript (typed, pasted), audio storage and playback, consent | Works without credentials |
| Rule-based safety checks (allergy vs prescription incl. an illustrative group list, vital-sign flags, missing information, red-flag phrases, record conflicts) | Works without credentials; deterministic, versioned (`safety-rules-v1`, `record-compare-v1`) |
| Routing suggestions | Works without credentials; deterministic |
| Mana AI, the assistant (V4) | **Needs the local model** (`npm run llm:setup` once, then `npm run dev:llm`); no key. With the model not running it says "Mana is currently unavailable." and nothing else. A hosted model for it exists only behind the egress policy and a key and was never run |
| Mana record rules (briefing, history, last prescription, vitals comparison, changes, allergies, diagnoses, search; slice 1) | Work without credentials; deterministic, versioned (`mana-record-v2` since V5: what staff measured stands over a device's readings, and a simulator's values are not read); the assistant's tools reuse them, and the slice-1 questions API remains (no screen) |
| Slice-1 Mana AI summaries (API only) | **Need `ANTHROPIC_API_KEY` AND hosted AI egress turned on (`AI_EGRESS_HOSTED=true`)**, and the patient's `ai_record_assistant` consent; otherwise the answer says why and shows the record answer only |
| Note drafting, AI recommendations, Mana summaries, image description | **Need `ANTHROPIC_API_KEY` AND `AI_EGRESS_HOSTED=true`** (or `ai.egress.hostedProviders: true` in `config/adaxai.yaml`). **Hosted AI egress is off by default and a key alone enables nothing**: with it off the UI says "Hosted AI processing is switched off on this server, so no consultation text leaves this computer" and never shows placeholder output. With it on, pseudonymised transcript text (never audio) goes to the hosted provider after the patient's consent and the doctor's click; the screen says where |
| Transcription of recorded or uploaded audio, live in 20-second parts | **Local speech service** (`faster-whisper` small, CPU) after `npm run speech:model`; no key, **no audio leaves this computer** (unless the clinic points `SPEECH_URL` at its own service on another computer on purpose, which the screens then say); finished text per part, no interim text; English is the supported language |
| Important points | **Fixed rules on this computer** (`extract-rules-v1`, English only); no key. A hosted language-model extractor exists only if `ai.extraction.provider: llm` is set on purpose |
| Speaker identification | **Not done by any model.** The doctor assigns Doctor / Patient / … line by line (kept as a review); typed “Doctor:” / “Patient:” labels are the typed text's own |
| Consultation draft (summary, considerations, missing information, uncertainties) | **Local model on this computer** (llama.cpp, Qwen3.5-4B) after `npm run llm:setup`; no key, no text leaves the computer; a down model is "Local AI unavailable." and **never** replaced by a hosted one; every statement is checked against the record by code and is a draft until the doctor accepts it. Evaluated on 12 synthetic cases only |
| Clinical accuracy of any AI output | **Not evaluated clinically.** The consultation draft was run with the real local model on 12 synthetic cases (counts, no accuracy figure: [docs/safety/AI_MODELS.md](docs/safety/AI_MODELS.md)); every other AI step was tested only against test doubles and a local mock of the provider API |

- **Drafts only.** Nothing reaches the note until the doctor accepts or edits an item and adds
  it; the server records each insertion with a reference to the AI artifact, and the signed
  snapshot lists them; flagged or unsupported items need explicit confirmation; signing stays a
  separate, attested action. A test proves that accepting AI output never changes the consultation and is
  not in the signed record unless the doctor saved it in the note. The assistant never
  diagnoses, prescribes, changes medicines, closes a consultation or contacts the patient.
- **Provenance.** Facts and recommendations link to transcript lines or record items
  (`ai_evidence`), with who said or recorded it. Unverifiable citations are marked unsupported.
- **Versions and logs.** Every job records provider, answering model, prompt or rules version,
  tokens, latency, errors, data origin and a hash of the non-secret AI settings. Prompt texts are
  checksummed: a changed prompt must get a new version id.
- **Consent.** `ai_recording` (wording `2026-10-v2`) covers recording, drafting, record-aware
  recommendations and the local consultation draft (whether a local model needs its own consent is
  a governance decision that was not made); Mana AI needs no consent to read a patient with the local model unless the patient **withdrew** `ai_record_assistant` (then Mana does not read that patient), and a model that is not local needs it **granted** (what consent Mana should need is a governance decision that was not made);
  photographs need `clinical_photography`, their AI description `ai_image_analysis`.
- **Privacy.** Registered names, MRN, phone numbers and emergency-contact details are replaced
  before text is sent; only age band and sex are sent; only a metadata-free photo preview. Other
  identifiers spoken in conversation may still be present. Sending data to a provider requires
  the patient's consent and a data-processing agreement with the provider.
- **No automatic learning.** Doctor decisions are recorded and summarised; nothing is retrained.
- **Architecture note.** Calls to hosted providers are thin adapters in the Node API behind
  provider-neutral interfaces (`apps/api/src/ai/providers.ts`). The Python service does local
  processing. A self-hosted model would be a Python service behind the same interfaces.

## Thermal imaging: what is and is not real

- **Measurements only**, not a diagnosis, not clinically validated.
- **Correctness check:** for the sample files, `flyr` temperatures match an independent
  implementation of the FLIR raw-to-temperature formula within 0.0001 °C. That is consistency,
  **not** absolute accuracy (which needs a blackbody reference and the clinic's own camera).
- **Camera compatibility is unverified.** Tests use public sample images (FLIR AX8, a generic
  FLIR file, and a DJI Zenmuse XT-R file that is rejected). Fetched by `npm run setup` (MIT
  licence, `samples/thermal/SOURCE.txt`).
- **Licence to review:** `flyr` is EUPL-1.2 (copyleft).
- **Datasets:** no trained model ships; the evaluation pipeline will not train below 20 positive
  and 20 negative labelled images from 10 subjects. Exports contain only approved images of
  patients with research consent, de-identified. Reports say prominently when data is
  non-clinical. Offline: `services/thermal/.venv/Scripts/python -m app.evaluate dataset.zip`.

## Patient portal

Patients see only finalised information about themselves: signed consultation records with
prescriptions and later amendments, visits, measured vital signs (device readings marked as such),
consents, profile and allergies, and doctor-approved thermal measurements. Drafts, transcripts,
audio, photographs, AI output and anything a device simulator generated are never shown. The app is installable (manifest, icons); its
service worker caches only the application shell and hashed build files and never `/api/`
responses (`apps/web/public/sw-policy.js`, unit-tested). Signing out clears all cached data in
the page.

## Services and ports

All services listen on localhost only.

| Service | URL |
| --- | --- |
| Web app | <http://127.0.0.1:5173> |
| API | <http://127.0.0.1:4000/api/health> (proxied by the web app under `/api`) |
| Python service | <http://127.0.0.1:8001/health> (OpenAPI docs at `/docs`) |
| PostgreSQL | `127.0.0.1:5433` |
| Local language model (optional) | `127.0.0.1:8081` (`/health` answers without the secret; everything else needs it) |
| Device gateway API | part of the API: `POST /api/device-ingest/readings`, `/heartbeat`, `/auscultations` (a device token, no session; [docs/DEVICES.md](docs/DEVICES.md)). No gateway program exists except the simulator |

## Commands

| Command | Purpose |
| --- | --- |
| `npm run setup` | One-time / repeatable local setup |
| `npm run dev` | Start PostgreSQL (if needed), API, web and Python service |
| `npm run demo:seed` | Add the synthetic demo patient (idempotent) |
| `npm run demo:devices` | Register two **simulator** records (a band and a stethoscope; not devices), attach the band to the demo patient and write their gateway tokens to `.data/sim/` (idempotent; refused where data is clinical) |
| `npm run devices:simulate -- [--scenario steady\|rising_heart_rate\|low_spo2\|fever\|no_readings\|dropout] [--seed n] [--interval s] [--count n] [--recording]` | The device simulator: posts **generated** values (or, with `--recording`, generated tones) to the running application as a gateway would, through a simulator record's token. The application stores and shows them as SIMULATED. Deterministic for a seed |
| `npm run db:start` / `db:stop` / `db:status` | PostgreSQL lifecycle |
| `npm run db:selftest` | Persistence check: write → clean stop → start → read, plus UTF-8 round-trip |
| `npm run llm:setup` / `llm:status` / `llm:verify` / `dev:llm` | The local language model: download the pinned runtime and model after asking (hash-checked), show what is installed, re-check the model's SHA-256, run the server on loopback with the per-install secret |
| `npm run eval:consult -- [--split dev\|test] [--replay]` | Run the consultation-draft evaluation with the real local model (minutes per case; not part of `npm test`) or re-score the recorded answers with the current checks |
| `npm run eval:mana -- [--replay]` | Score the Mana AI evaluation: the answers recorded from the real local model by `MANA_EVAL=1 npx vitest run test/mana-eval.real.test.ts` (run from `apps/api`; minutes per question; test database only; not part of `npm test`), with the current checks; `--replay` applies the current answer checks again to what the model wrote. Writes `data/eval/results/mana-v1.md` |
| `npm run db:migrate` | Apply migrations to the dev database (`-- --target test` or `e2e`). Also marks what the database is for (development, test or e2e) and refuses a database marked for something else |
| `npm run db:seed` | Synthetic staff and departments (idempotent) |
| `npm run db:generate` | Generate a new SQL migration from `apps/api/src/db/schema.ts` |
| `npm run backup` | Cold backup of the database and uploaded files to `backups/` (stop the app first) |
| `npm run backup:verify -- <dir>` | Start the backup on a spare port and check counts and files |
| `npm run backup:restore -- <dir> --yes` | Restore; the current data is moved aside, not deleted |
| `npm run user:reset-password -- <username> [--seed-password]` | Local recovery of a staff account (lockout or lost password): a one-time temporary password, or back to `SEED_DEMO_PASSWORD`; clears lockout, ends sessions, audited with the OS user and host, never touches patient data. On production or clinical installations `--seed-password` is refused and a reset needs `--break-glass --reason "…"` |
| `npm run retention [-- --dry-run]` | Delete consultation audio of signed consultations older than the configured days |
| `npm run audit:verify -- [--target test\|e2e] [--anchor <seq>:<hash>]` | Check the audit log's hash chain (read-only) and print its head; with an anchor recorded earlier, detect removal of the newest events |
| `node scripts/storage-orphans.mjs [--delete]` | List (or remove) stored files the dev database does not reference (`--delete` only on a database marked as development) |
| `npm test` | API, web, Python and end-to-end tests |
| `npm run test:api` | Vitest against the real test database `adaxai_test` |
| `npm run test:web` | Service-worker caching policy (node --test) |
| `npm run test:thermal` | pytest |
| `npm run test:e2e` | Playwright (desktop + mobile Chromium) with axe WCAG 2.2 AA and phone-overflow checks |
| `npm run lint` | oxlint (warnings fail) + ruff |
| `npm run typecheck` | TypeScript across all workspaces and the e2e tests |

**Test isolation:** API tests use `adaxai_test` and `storage-test/`; the end-to-end suite starts
its own API (4100), Python service (8101) and web app (5273) against `adaxai_e2e` and
`storage-e2e/`. Neither touches the development database or `storage/`, and both can run while
`npm run dev` is up.

This is enforced, not only configured:
- `DB_NAME`, `DB_TEST_NAME` and `DB_E2E_NAME` must all differ, and the test and e2e names must end
  in `_test` and `_e2e`;
- each database carries an identity marker (`meta.database_identity`) set by `db:migrate`;
- the test helpers' reset, `db.mjs reset` and `storage-orphans --delete` refuse unless the database
  identifies as the expected one;
- the e2e configuration stops before starting any server if the names are ambiguous.

Nothing prints connection secrets.

**Upgrading an installation made before this guard existed.** The test and e2e databases already
hold data but carry no identity marker, so setup and the test commands refuse to treat them as
disposable. After checking that they are the test databases, mark them once:

```bash
npm run db:migrate -- --target test --claim-existing
```

```bash
npm run db:migrate -- --target e2e --claim-existing
```

AI output in tests comes from test doubles or the test-only mock server `e2e/mock-anthropic.mjs`.

## Backup and restore

`pg_dump` is not bundled with the embedded binaries, so backups are **cold copies**: the script
stops PostgreSQL, copies the data directory and `storage/`, starts PostgreSQL again and writes a
manifest with row counts. This is a complete, consistent backup for the same PostgreSQL major
version (17) and platform.

```bash
npm run backup
```

```bash
npm run backup:verify -- backups/adaxai-<timestamp>
```

```bash
npm run backup:restore -- backups/adaxai-<timestamp> --yes
```

Stop `npm run dev` first (the scripts refuse while the API is running). `verify` starts a copy
on port 5499 and checks counts and that every referenced file is present, without touching your
data. `restore` moves the current data to `.data/pg.before-restore-*` and
`storage.before-restore-*` before copying the backup in. Backups contain patient data: keep them
encrypted and access-controlled.

## Database

- **Encoding:** `--encoding=UTF8 --locale=C --locale-provider=builtin --builtin-locale=C.UTF-8`
  (without it Windows picks WIN1252 and rejects non-Latin names).
- **Lifecycle:** `scripts/db.mjs` drives `initdb` and `pg_ctl` directly (reasons in
  [`spikes/postgres/RESULTS.md`](spikes/postgres/RESULTS.md)).
- **Roles:** `DB_ADMIN_USER` (superuser, scripts and migrations only); the API connects as
  `DB_APP_USER` (data only).
- **Databases:** `adaxai` (development), `adaxai_test`, `adaxai_e2e`.
- **Lifecycle in the database:** visit and consultation status changes are validated by triggers
  (the same transitions as the API) and recorded in `visit_status_events` and
  `encounter_status_events` with the acting user.
- **Integrity in the database:** triggers keep signed and discarded records, amendments, audit events, status history, AI
  evidence, review history, transcript segments, evaluation runs, photographs and stethoscope
  recordings append-only or frozen, and allow reviewed AI output, labels, routing suggestions and
  device assignments to change only in their single permitted way.
- **Migrations:** `apps/api/drizzle/`, each in its own transaction with a checksum; never edit an
  applied migration. They are additive. Before applying new ones to a database that holds data,
  stop the app (`Ctrl+C` in the `npm run dev` window), take a cold backup with `npm run backup`,
  check it with `npm run backup:verify -- <dir>`, then restart. Migration 0022 enables the
  `btree_gist` extension (bundled with the PostgreSQL binaries) for the no-double-booking constraints.
- **On disk (git-ignored):** `.data/pg`, `.data/logs`, `storage/`, `storage-test/`,
  `storage-e2e/`, `backups/`.

## Configuration

`.env` (created by setup, git-ignored) holds secrets, ports, `DATA_ORIGIN` and optional model
overrides; see [`.env.example`](.env.example) for every variable. Non-secret settings are YAML,
validated strictly at start-up:

| File | Contents | When changes apply |
| --- | --- | --- |
| [`config/adaxai.yaml`](config/adaxai.yaml) | AI features, models, effort, timeouts, live chunk length, context limits, Mana record window and outdated threshold, upload types and limits, retention, safety-rule groups and tolerances, how long a device reading counts as live and how long a gateway may be silent before its device is shown as disconnected | **API restart** |
| [`config/routing.yaml`](config/routing.yaml) | Routing rules, red-flag phrases and instructions, required intake | **At runtime** (re-read on change; an invalid edit keeps the last valid rules) |
| `.env` | Secrets, ports, `DATA_ORIGIN`, `AI_NOTE_MODEL`, `AI_EGRESS_HOSTED`, `SPEECH_PROVIDER`, `SPEECH_URL`, `LLM_PROVIDER`, `LLM_URL`, `LLM_PORT`, `LLM_CTX`, `LLM_THREADS`, `DEVICE_LIVE_SECONDS`, `DEVICE_DISCONNECTED_SECONDS` (the old `AI_STT_*` settings are ignored; the model server's secret is in `.data/llm/api-key`, not in `.env`) | **Restart** |

`DATA_ORIGIN` (default `synthetic`) is recorded on AI jobs, photographs, stethoscope recordings
and thermal images; set `clinical` only in a real clinical deployment.

## Known limitations

**Clinical**
- No AI output, rule, flag or measurement is clinically validated. AI was exercised only with
  test doubles and a local mock; quality with real providers, Indian languages and real
  consultations is unknown.
- Mana AI plans with a 4-billion-parameter model that sometimes plans wrongly (the evaluation counts it, and the server corrects what it can recognise); it answers one question at a time (78 seconds at the median on a laptop CPU, up to about three minutes), has no chaining and no clinical search across all patients, answers no general medical question, and is **not clinically validated**. The slice-1 record answers still fall back to a word
  search of the record (no paraphrase). The "possibly outdated" threshold is a display setting,
  not clinical guidance.
- Red-flag phrase matching is simple text matching with basic negation handling; it misses
  paraphrases and is not triage.
- The allergy group list is illustrative and incomplete; it is not a drug or cross-reactivity
  database. Vital-sign flags use adult ranges only.
- Thermal measurements depend on capture conditions; camera compatibility is unverified.
- No device has been integrated or validated; device readings can only arrive through the documented gateway
  API and are always marked unverified. The only thing that has ever posted to it is the labelled simulator
  (generated values, stored and shown as simulated) and the tests. A reading's state says how old it is and
  whether its gateway is in contact, not whether the value is right. The device card is re-read every five
  seconds: it is not a monitor, and nothing raises an alarm. No stethoscope has been tested; a recording made
  in the browser comes from whatever audio input was chosen.
- Prescriptions are not valid for dispensing in this build.

**Security and operations**
- Local single-machine deployment only: no TLS, no reverse proxy, no rate limiting beyond sign-in
  lockout, no multi-factor authentication, no external security review or penetration test.
- Pseudonymisation before AI calls is best effort (registered identifiers only).
- Backups are cold copies requiring brief downtime; there is no point-in-time recovery,
  encryption of backups or off-site copy.
- Audit coverage is extensive but has not been assessed against a specific regulation; no
  regulatory compliance is claimed.
- Rate limits are kept in memory by the single API process (a restart clears them).
- The audit hash chain and record fingerprints are unkeyed SHA-256: tamper evidence within this
  database, not proof. Someone with the database superuser password (stored in the local `.env`)
  could rewrite records and recompute every hash. Only a head recorded outside the system reveals
  that, or the removal of the newest events.
- Every audited request waits briefly for the audit chain's lock; this has not been measured under
  load.
- Appointments: there are no clinic hours, clinician calendars, department capacity limits,
  recurring appointments or waiting lists; patients cannot book or cancel for themselves; no
  reminders are sent (nothing schedules them); a missed appointment is marked by staff, not
  automatically. Messages reach the patient portal only: a patient without a portal account is
  not told by any other route. The length and horizon rules (10 to 60 minutes, up to 180 days
  ahead) are conservative defaults, not clinical policy.
- Unsigned drafts can be edited, signed or discarded only by their author; there is no supervised
  reassignment yet.
- "Care records" (`data_processing`) consent is recorded and shown but not enforced: whether care
  depends on it is a legal decision that needs qualified review.

**Compatibility**
- Verified on Windows 11 x64 with Chromium (Playwright) only; other browsers and macOS/Linux are
  untested. Web Bluetooth and direct device connections are not used.
- Speech-to-text is a local model on CPU: a part appears after it has been recorded and
  transcribed (seconds to tens of seconds), not word by word. Live transcription restarts the
  browser recorder per 20-second part (a very short gap between parts is possible). Measured on
  synthetic speech only: see `docs/safety/AI_MODELS.md`.
- Images: JPEG, PNG, WebP only (no DICOM). Thermal: FLIR radiometric JPEGs readable by `flyr`.

## Project layout

```
apps/
  api/            Fastify API, Drizzle schema, migrations (drizzle/), tests
  web/            React + Vite + Tailwind web app (all portals), PWA files in public/
packages/
  contracts/      Zod schemas shared by api and web
services/
  thermal/        FastAPI service: thermal, image validation, dataset evaluation (Python)
config/           YAML settings (no secrets)
docs/             PRODUCT_SPEC.md, DESIGN.md, AUDIT.md, STATUS.md, DEMO.md, DEVICES.md, adr/ (decisions)
demo/             Synthetic consultation transcript
scripts/          db lifecycle, setup, backup, retention helpers, icons
e2e/              Playwright end-to-end tests (and the test-only AI mock)
spikes/postgres/  PostgreSQL feasibility spike (reference only)
```

## Troubleshooting

- **“Invalid username or password”**: use the username (`admin`, `dr.meera`, `dr.rahul`,
  `nurse.anil`), not an email address; patients use their MRN. The password is the exact value of
  `SEED_DEMO_PASSWORD` in `.env`. Seeding never changes an existing user's password, so if `.env`
  was edited after setup, or the password is lost, run
  `npm run user:reset-password -- admin --seed-password` (sets it back to `SEED_DEMO_PASSWORD`) or
  `npm run user:reset-password -- admin` (prints a one-time temporary password). If no users exist
  at all, set `SEED_DEMO_PASSWORD` in `.env` and run `npm run db:seed`.
- **“Sign-in is temporarily unavailable”** (it used to read “Request failed (502)”): the web
  server is up but the **API is not**. `http://localhost:5173/api/ready` (or `/login`'s “Sign-in
  service” line) shows it; start everything with `npm run dev`, or just the API with
  `npm run dev:api`. If `npm run dev` was ended with its window left open, an old Vite can still
  hold port 5173 while the API is gone: end that process (Task Manager), then run `npm run dev`
  again. The API's own log says why it stopped.
- **“Too many failed sign-in attempts”**: 5 wrong passwords lock an account for 15 minutes. Wait,
  ask an administrator to reset the password, or use `npm run user:reset-password` as above.

- **`Port 5433 is served by a different PostgreSQL`**: set a different `DB_PORT` in `.env`.
- **`PostgreSQL rejected DB_ADMIN_PASSWORD`**: `.env` no longer matches the cluster. Restore the
  original `.env`, or (losing local data) stop the server, delete `.data/pg` and run setup.
- **After a crash**: `npm run db:start` handles a stale `postmaster.pid`.
- **Ports 4000/5173/8001 still in use after `npm run dev` ended**: stop it with Ctrl+C. If the
  terminal was closed, Windows can leave child processes running; end them in Task Manager.
- **Code changes not picked up by `npm run dev`**: the API (`tsx watch`) and the Python service
  (`uvicorn --reload`) occasionally miss changes on Windows; restart `npm run dev`.
- **Windows PowerShell 5.1**: do not rewrite source files with `Get-Content`/`Set-Content`
  (ANSI encoding corrupts non-ASCII text).
