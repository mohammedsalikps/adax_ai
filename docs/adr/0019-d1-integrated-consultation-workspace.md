# ADR 0019: D1, the doctor's consultation as one workspace: the tools beside the note, nothing hidden, one way into the note

- **Status:** accepted and implemented in D1 (after V5, `a43a72d`). It changes how the consultation screen of slice 4A/V1 is laid out and joins the pieces of V2 (capture, [ADR 0015](0015-hosted-ai-egress-policy-and-speech-service-hardening.md)), V3 ([ADR 0016](0016-local-ai-consultation-intelligence.md)), V4 ([ADR 0017](0017-mana-ai-doctor-assistant.md)) and V5 ([ADR 0018](0018-device-readings-states-gateway-and-simulator.md)) on it. It adds no engine, no model, no table and no route.
- **Date:** 5 Oct 2026

## 1. Context

By V5 a doctor's consultation had every part the plan asked for, each built and tested on its own, but laid out as fifteen cards in a grid made for a wide laptop: three columns from 1400px, two from 1280px and **one long column below that**. On a tablet held sideways (1024 to 1279px, the device the Doctor App is meant for) the note came after seven cards and the AI draft and Mana were at the very bottom. The patient's facts were repeated in up to five places (allergies), there were two AI cards that could both "Generate draft" with different meanings, a placeholder card for a writing pad that does not exist, nothing at the top said whether the devices or the local AI were working, and the older AI assistant put a suggestion into the note in the same click as *Accept*. A fault while drawing any panel would have replaced the whole page, the note included, with an error page.

The owner's D1 brief asked for one polished, doctor-first workspace for one patient and one encounter, tablet held sideways first, with no new clinical capability, no weaker safety mechanism and no change to the nurse, patient or admin applications.

## 2. Decisions

### 2.1 Two panes from 1024px: the tools on the left, the note on the right

From 1024px the consultation is two panes: the **tools** (20 to 26rem; 30rem from 1536px) and the **note, diagnosis and prescription**. The tools are in the order a consultation uses them (the visit and the history, the conversation, the AI draft, Mana, the devices, the rest), so reviewed text moves left to right into the note. The tools column keeps its place under the consultation bar and scrolls on its own; the note scrolls with the page; each stays in view while the doctor works in the other. Below 1024px it is one column, the tools first, with a *Note* button at the top. The route marks itself a **workspace** (`handle: { workspace: true }`): the shell keeps its sidebar a drawer up to 1280px on that page only and does not hold it to the 80rem column of lists and forms, so a tablet's whole width is the consultation's. The frame belongs to the route, so the doctor's read-only and signed view of a consultation gets it too (more width, the sidebar a drawer below 1280px); every other page of every application keeps the shell as it was.

### 2.2 Nothing is hidden: a bar of anchors, not tabs

The tools are **all mounted and visible**; a bar at the top of the column (*History, Conversation, AI draft, Mana, Devices, More*) scrolls **the column only** (the page, with the note beside it, stays where the doctor left it) and moves focus to the part, a named group; the column's first keyboard stop is *Skip to the note*. Tabs were considered and rejected: a hidden panel that stays mounted keeps polling and, for the AI draft, would record that the doctor viewed a draft they never saw (`ai.consultation_draft_viewed`); a panel that is unmounted stops a recording mid-consultation (the recorder releases the microphone) and stops the only poller of the device readings, which would then age to stale and disconnected on screen while the device was live. Mana keeps its own rule: closed until opened, nothing asked of the server before; it is a panel in the page, not a modal dialog, so the note stays usable during an answer that can take minutes.

### 2.3 The bar says who, what to be careful of, and what the consultation relies on

The patient's **name is the heading**; the banner, part of the sticky bar from 1024px, holds age, sex, MRN, token and department, allergies with severity, up to three conditions, **the reason for the visit**, **Urgent visit** when the visit is marked urgent (the visit's priority, now in the consultation's read payload: an added field, not signed and not hashed), the vital signs outside the adult range, and three **status chips**: devices, the AI draft's model, speech-to-text. A chip is an **observer of the query its panel already makes** (TanStack Query, same key, never fetching itself): it adds no request and no audit entry, says nothing until its panel has answered, ages device states by the same function as the card (V5's `readingState`), marks SIMULATED and UNVERIFIED, and says "not updated" when its panel's last read failed (or, for devices, is old). "Local AI" means the model runs on this computer; a model elsewhere is "AI on another computer", and a hosted model is "allowed" (the server's setting), never "ready", because nothing on the screen checked it. Speech-to-text is taken from the newer of the transcription panel's two reads (its status is re-read every 20 seconds). The time of the last check and the model's name are in each chip's accessible name and tooltip. It leads to its panel. There is no alerts engine: only recorded facts are shown.

### 2.4 One way into the note, everywhere

AI output reaches the note only through *Add to note* / *Add to <section>*, a separate act after the doctor accepted or edited it, through the editor's one `NoteInserter` (which saves the doctor's edits first, on the same serial chain as autosave) and the server's `POST /api/encounters/:id/insertions` (which checks the review decision and that the text is the reviewed text, appends to one of the seven note sections, never to the diagnosis or the prescription, and records the source). The older AI assistant's *Accept* used to insert in the same click; it no longer does (its *Add to <section>* button is the step). Mana has no way into the note. The panels receive a stable inserter that always calls the editor's current one.

### 2.5 Less on the screen

The rules-composed patient summary moved to the profile (*View profile*, Overview): the banner and the past history already show the same facts. The writing-pad placeholder is not shown (the feature does not exist). The token, department and reason moved into the banner. The V3 card's intro no longer repeats what the new line under its button says (what a draft is made from, including the number of points the doctor confirmed).

### 2.6 A fault stays inside its tool; the note is not redrawn by every keystroke

Each tool, each card of a part that holds several (the device readings and the stethoscope recordings; the photographs and the older assistant) and the bar's status chips are drawn inside their own error boundary (`PanelBoundary`): one that fails to draw says so with *Try again* (focus returns to it), nothing about the error is shown on the screen or sent anywhere (the browser's console keeps React's own report, as for any error), and the note and the other tools keep working. Tools are memoised and drawn again when the consultation's AI insertions change (they say what is already in the note), not on every keystroke in the note.

### 2.7 Wording, in the consultation only

The device card and the stethoscope card take an opt-in `variant="consultation"`, used only on this route: an **UNVERIFIED** mark beside each device that is not a simulator (solid outline; SIMULATED stays dashed), a disconnected device's reason starting **"Device not connected."**, **"No recording available."**, **"This consultation"** on recordings made in it, and an error state when the recordings cannot be read. On the patient record (doctor and nurse) and in the profile sheet the cards are unchanged.

### 2.8 Finishing cannot be interrupted

The *Review and sign* dialog cannot be closed while the signature is being recorded (the design rule for dialogs with a request in flight; it was not followed before). Signing itself is unchanged: the attestation, the server's completeness checks, the signed snapshot and its fingerprint.

## 3. What was not built

- **Thermal in the consultation** (V6) and anything of FLIR; the profile's *Documents* tab, where thermal studies already are, is the place a later slice starts from.
- **A doctor-facing audit trail of a consultation** (V8). The journey's audit entries exist and are checked by the end-to-end test through the administrators' audit API; the doctor sees the status history and the AI activity trail, as before.
- **New AI capability**: no new model, prompt, tool or engine; V3 still drafts from the record, the note and the confirmed points, never from the raw transcript; Mana's tools and consent rules are unchanged.
- **Any device or stethoscope integration**: still none exists (see [DEVICES.md](../DEVICES.md)); the simulator stays a simulator.
- Keyboard shortcuts, a tablet-specific touch keyboard layout, a resizable split.

## 4. Consequences

- The secondary applications are unchanged: the nurse's consultation route renders the read-only record as before (it has no panels and never had the editor); the shared cards change only when the consultation passes `variant="consultation"`; the shell changes only for a route that marks itself a workspace.
- End-to-end tests that measured the old three/two/one-column grid were rewritten to the new layout (two panes from 1024px at nine sizes, tablets included; the banner, *Complete consultation* and the first note field on the screen at opening); the strip test now checks that from 1024px the banner itself never leaves the screen (the strip still takes over on phones); the older assistant's test now requires the separate *Add to <section>* step and checks the note is unchanged after *Accept*. One new end-to-end test walks the whole journey on one synthetic patient (§5).
- A device chip can only be as current as the card's last read; the card is always mounted, so it is current to within the five-second poll.
- The visit's priority on a signed record's read payload is the visit's priority now, not at signing (it is not part of the signed content); the banner that shows it is only in the editor.
- The page's scroll padding follows the consultation bar's published height, so a focused field is never left under the sticky bar; the banner is held to about a third of the screen and scrolls inside itself beyond that (allergies first).
- A chip can be as old as its panel's last read: the AI draft panel re-asks the model server only while it is unavailable, and the chip says when it last checked.

## 5. Verification

See [STATUS.md](../STATUS.md), section D1: the Doctor hero end-to-end test (sign in, dashboard, today's patients, the patient, the consultation, the transcript with doctor and patient lines, important points, the AI draft with support states, accept, edit and reject, add to note, a Mana question, simulated device readings live, stale and disconnected, a stethoscope recording, signing, and the audit entries, with no free text in them), `e2e/workspace.spec.ts` (a tool that fails to draw stays in its place and the note is still saved; the bar moves the column, not the page, and focuses the part; *Skip to the note*; the sign step cannot be closed while signing; the drawer only on the consultation), the unit tests of the device summary, the API tests of the visit's priority, the rewritten layout tests, and screenshots of the workspace at 1024×768, 1180×820, 1280×800, 1366×1024, 1920×1080 and 390×844.
