# ADR 0021: D2, the multimodal consultation: one context read from the records, an overview, rules that find disagreements, and a summary made by rules

- **Status:** accepted and implemented in D2 (after V6, `e9f1590`). It joins what V2 (capture), V3 ([ADR 0016](0016-local-ai-consultation-intelligence.md)), V4 ([ADR 0017](0017-mana-ai-doctor-assistant.md)), V5 ([ADR 0018](0018-device-readings-states-gateway-and-simulator.md)), D1 ([ADR 0019](0019-d1-integrated-consultation-workspace.md)) and V6 ([ADR 0020](0020-v6-thermal-capture-in-the-consultation.md)) keep about one consultation into one read model. It adds one read-only route and one read-only Mana tool; **no table, no migration, no model, no prompt**.
- **Date:** 5 Oct 2026

## 1. Context

After V6 a consultation could hold a conversation and its important points (V2), an AI draft and the doctor's decision on each statement (V3), Mana's answers (V4), the staff's vital signs and device readings in five states (V5), stethoscope recordings (V5), thermal images, their measurements and summaries (V6), and what the doctor added to the note (D1). Each was shown by its own part of the D1 workspace and checked by its own rules. Nothing put them side by side: to know what a consultation held, what still waited for the doctor, or that the patient's band disagreed with the nurse's measurement, the doctor had to read every part.

The owner's D2 brief asked for one coherent workflow over all of them: one authoritative context for the consultation, PostgreSQL the only source of truth, a chronological view of the evidence with its source, time, state and provenance, the distinction between what was observed, measured, inferred, made by a model, entered by a clinician, simulated or unverified, a summary that is advisory, disagreements surfaced and never resolved, Mana able to answer questions about the consultation without writing anything, failures contained, everything audited without clinical payloads, and no new autonomous action of any kind.

## 2. Decisions

### 2.1 One read model, built on request, stored nowhere

`GET /api/encounters/:id/context` (`apps/api/src/consultation-context/build.ts`) builds the context of one consultation from the records that already exist, each through the read path its own part already uses (the device card's readings and states, the note insertions, the V3 drafts and decisions, Mana's conversations, the V6 captures and summaries). Nothing is copied into a new table and nothing is written: the context is as current as the database at the moment it is read, and there is no second copy to drift. The contract is `packages/contracts/src/consultationContext.ts`.

A **store** (a table of "evidence" kept up to date by each part) was considered and rejected: it would be a second source of truth, every part would have to write to it in the same transaction as its own record, and a missed write would show the doctor something the record does not say.

Each source is read on its own and bounded (the newest few of each kind, for this encounter only; what waits for review is counted in full by separate counts; a device's newest reading of each kind is one index look-up per assignment, never a scan of the visit's readings). A source that cannot be read is left out and said to be missing ("… could not be read just now"); the rest is returned. **Not read is never "none"**: the counts of what waits carry `unread` (the kinds that could not be read, or that this viewer is not shown), and the summary does not state an absence it could not check. The server log gets the reason; the screen does not.

### 2.2 Every item says how far it can be trusted, and nothing is upgraded

Every item has a **kind** (conversation, important point, vital sign, device reading, stethoscope, thermal image, thermal summary, AI draft, Mana, added to the note), a **time** (the one the record holds), a **state** in a word, a **source** in words, its **versions** (model, prompt, rules) when there are any, and a **trust** from a fixed list, in the screen's words:

| Trust | Words on the screen | Given to |
| --- | --- | --- |
| `clinician_entered` | Entered by staff | the staff's vital signs; the record's allergies, conditions, medicines |
| `observed` | Said in the consultation | the conversation |
| `measured` | Measured | a thermal image that is not simulated (from the radiometric data) |
| `measured_unverified` | Device reading, unverified | a device reading (V5: a device not validated here) |
| `simulated` | SIMULATED, not a measurement | anything a simulator made |
| `recorded` | Recorded, not analysed | a stethoscope recording |
| `extracted` | Extracted from the conversation, to review | an important point found by V2's fixed rules (the default extractor) that the doctor has not decided |
| `rule_output` | Fixed rules, not AI | thermal summaries, the summary's own statements |
| `model_output` | AI output, to review | the AI draft, Mana's answers, an undecided important point found by a model (when the facility chose one) |
| `doctor_reviewed` | Reviewed by the doctor | important points the doctor accepted or edited, what was added to the note |

A point's trust follows **its review state**, not what found it; a point the doctor **rejected** is left out of the context altogether (as the summary, the conflicts and V3 leave it out).

A device reading stays unverified; a simulator's output stays SIMULATED and is **never LIVE** (its state reads "SIMULATED", "SIMULATED · STALE" …); a recording stays "not analysed"; an imported thermal image says so ("imported at 10:20; date taken not known"). Device states are decided by V5's `readingState` at the server's clock, the same function the device card uses. A device's newest reading of a kind keeps one id (`vital_device:<device>:<kind>`) from one read to the next, so the screen keeps its place.

### 2.3 Who sees what is decided as it is today

The route needs `encounters:read` (doctors and nurses of the consultation's facility). Another facility's consultation is "not found" and audited as such; a patient-portal session is refused. Inside, each item is shown to whoever may already see its record: the conversation and the important points to doctors (`ai:use`), the AI draft to the consultation's own doctor only, Mana conversations only to the doctor who asked in them; vital signs, device readings, recordings, thermal records and note insertions to the consultation's readers. Only **this** encounter's records are read: another consultation of the same patient contributes nothing (its thermal images, its devices' readings, its drafts).

### 2.4 Disagreements: found by fixed rules (`context-conflicts-v2`), never resolved

Four rules, in `conflicts.ts`, each saying what it compared:

- **Staff measurement against a device reading** of the same kind at the same visit within 15 minutes, differing by at least SpO₂ 3 %, heart rate 15 /min, temperature 0.5 °C or respiratory rate 5 /min. A simulator's values are never compared. ("Staff measured SpO₂ 98 % at 10:40; a device (unverified) sent 94 % at 10:42.")
- **An important point against the record.** An allergy point is compared again with the record **as it is now** (its active allergies, by the record comparison's own name matching, and "no known allergies"), so a disagreement disappears when the doctor records the allergy; a point the doctor **edited** is not judged again by what the extraction read in it (the doctor wrote it against the record). Any other point: where V2's comparison flagged it when it was extracted, said to be so; for a vital sign, naming where the value it differs from came from (entered by staff, or a device, unverified), never calling a device's value "measured".
- **An AI draft statement** that V3's checks marked *conflicting* with the record.
- **Allergy status**: allergies were mentioned in the consultation while the record has neither an allergy nor "no known allergies".

The thresholds are constants with their reasons; they are not clinical rules and say nothing about which side is right. Both sides are shown as they were recorded, with the rule's name; nothing is changed, chosen or hidden. Of a device's readings, only the one a staff value was compared with is listed beside the newest (not every reading in the window).

### 2.5 The summary: composed by fixed rules (`multimodal-summary-v2`), advisory

Five sections (current presentation, patient context, current observations, AI-derived information, items for the doctor's review), each statement with its trust and the items it rests on. No language model is asked. It states the reason for the visit as entered and the points the doctor confirmed; the record's allergies (or that the status is not recorded), conditions and medicines; the staff's vital signs; a device reading **only** as "device reading, unverified" with its time (not its momentary state, which ages on the screen), and never a simulator's; the measurements of an **approved** thermal image that is not simulated, as stored, "skin-surface temperature only", an imported or uploaded one **first said to be so** ("IMPORTED: an earlier image chosen from the device, date taken not known."); a stethoscope recording only as "recording available for clinician review; not analysed"; **only** the AI draft statements the doctor accepted or edited, quoted, and counts of what waits; then what waits, each disagreement, what is missing and the limitation ("Advisory: composed by fixed rules from this consultation's records; the doctor decides"). Of a source that could not be read it says so, never that there is none. It never states a finding, a diagnosis, a recommendation or a prescription, and it never goes into the note: it is read beside the note.

A summary written by the local model was considered and rejected for D2: it would be a new prompt and a new kind of AI text to review, while what the doctor needs here is a faithful list; V3 already drafts the note from the record under its own checks.

### 2.6 The Overview: first in the tools column, showing and never deciding

The consultation's tools column starts with **Overview** (`ConsultationOverview`): what needs the doctor's review (counts that lead to where each is reviewed; "Nothing is waiting for your review." only when every kind was counted, otherwise "Some items could not be read just now, so this list may be incomplete." or, for a nurse, that the conversation's points and the AI draft are reviewed by the consultation's doctor), each disagreement in words first ("Sources disagree.") with the rule, the newest evidence with its kind, time, state, trust and source and a *View* that leads to its part, what is missing, and the summary, closed until opened. It reads the context every 15 seconds while the page is visible, when the window regains focus, and after an insertion into the note. A device value shown LIVE turns STALE on the screen when the device card's does; only a device reading's state is drawn in the device colours (a conversation left "Live" is not). If the context cannot be read, the Overview says so in its place ("The consultation and the note are not affected"), and every other part and the note go on working (D1's per-part boundary). It never shows an answer about another encounter or patient.

### 2.7 Mana: the consultation's own questions, read-only

A new read-only tool, `consultation_context` (`mana-tools-v3`), reads the context for the consultation a conversation was opened in, after the same role, facility and consent checks as Mana's other record tools; it refuses a conversation that was not opened in a consultation. **Consents are applied as for every model input:** with consent to thermal imaging withdrawn, no thermal image, summary or measurement is read; without consent to recording and AI assistance (in its current wording) for this consultation, the conversation, its points, the conflicts that rest on them and the AI draft's quoted words are not read; the doctor is told why in each case. A point the doctor rejected is never a fact. Four suggested questions have fixed plans (no planner call): *What was recorded in this consultation?*, *What still needs my review?*, *What information is missing?*, *Show the thermal measurements from this consultation.* **Nothing simulated is given to the model**, not even labelled; the server tells the doctor how many simulated items were left out. Disagreements are shown by the server as findings, "not resolved". The answer checks (`mana-answer-checks-v4`) hold a statement to its fact's trust: a statement resting on a device reading must say "unverified", on a recording "not analysed", on AI output that it is AI output, on an undecided extracted point that it is extracted or to review; it may not raise a device or simulated value to "measured", "verified" or "confirmed" ("staff measured" stands only beside a cited staff value); and on a recording, a thermal measurement or a simulator's output it may add **no word** beyond the facts, however short (no "murmur", "inflammation", "hot", "red" or "rub"). "Nothing waits" is said only of the kinds that were counted. The planner prompt was **not** changed (prompt versioning): a free-text question is rarely routed to the new tool; the four suggested questions work with any model.

### 2.8 V3's inputs are unchanged

Giving V3's draft model the consultation's stethoscope recordings (as "available for clinician review; not analysed") was built and then **removed** after the review: V3's existing checks let a model's invented sound ("Mitral area recording suggests a murmur.") through as an *inferred* statement without a confirmation tick. V3's inputs are exactly as before D2; no recording reaches the draft or the record rules. Only the Overview, the summary and Mana's consultation tool say that a recording exists, as recorded and not analysed, under their own checks.

### 2.9 Audit

`encounter.context_viewed` once per user and consultation every five minutes (the existing limiter; the window is given back if the audit row could not be written, so the next read is audited), with counts only (items by kind, disagreements, missing, pending, the rules' versions). Mana's tool reads are audited as Mana's other tools are (`mana.tool_run`, counts and versions). No words of the conversation, no values, no image, no recording and no summary text reach the log.

## 3. What was not built

- No new capture: the thermal camera, the devices and the microphone are V6's, V5's and V2's.
- No autonomous diagnosis, prescription, treatment, signing, messaging or device control; nothing from the context or the summary is written to the note, the record or anywhere else.
- No resolution of disagreements, no alerting engine, no population or outbreak analytics, no Mana actions; no V7 or later.
- No change to the nurse, patient or admin applications.

## 4. Consequences

- The doctor sees in one place what the consultation holds and what waits, with how far each item can be trusted, and is told where two sources disagree.
- The context is built on every read (bounded queries, one index look-up per attached device and kind); an open consultation reads it every 15 seconds (a reply the screen does not understand is not retried within the same read). That is acceptable for one doctor's consultation; a store or a change feed would be the next step if it is not.
- The trust vocabulary is a contract between the server, the screen and Mana's checks; a new source must choose one of its words, and a new word changes the contract.
- The thresholds of `context-conflicts-v2` are not clinically chosen; they flag a difference for a look, and are versioned so that a change is visible.

## 5. Verification

- API: `apps/api/test/consultation-context.test.ts` (the synthetic cases A to J: all modalities; thermal unavailable; wearable disconnected; stethoscope unavailable; AI unavailable; conflicting measurements; unverified readings; simulated device and thermal data; another facility and the patient portal; another encounter's thermal and device data; plus the audit window and its return after a failed audit, failing sources and `unread`, counts beyond the listed items, allergies compared with the current record, vital-sign sources never called measured, imported and uploaded images, stable device ids). Mana: `mana-tools`, `mana-assistant`, `mana-answer`, `mana`, `consult` tests. Web: `consultationContext.test.ts`.
- Browser: `e2e/multimodal-consultation.spec.ts`, one consultation with every modality (stand-ins for the model, speech, microphone, devices and camera, as named in the file), the Overview checked after each, the sizes 1024×768 to 1920×1080 and 390×844, signing, and the audit log.
- Review: an independent adversarial review of the D2 diff (four reviewers, each followed by a verifier trying to refute their findings): 26 findings verified, 24 confirmed (2 high, 9 medium, 13 low), 2 refuted; all fixed (the two high: V3's inputs restored; a point's trust follows its review state).
- Not verified: any hardware (no device, stethoscope or camera), a real speech recogniser in the browser test, clinical usefulness of the rules and thresholds. Mana's consultation questions were asked of the real local model on the development stack (answers in 5 to 7 seconds; its checks removed one or two statements of each answer, and the server's findings were shown): safe but terse with that model.
