# ADR 0022: the Doctor HERO workstation: five clinical inputs, one analysis with Mana, the doctor's review, and a pediatric shock research view

- **Status:** accepted; implemented in part (the owner stopped the slice "Doctor HERO premium UI UX redesign" for time after its first polish round; see STATUS.md for what was and was not verified) (after D2, `00bc67b`). It supersedes [ADR 0019](0019-d1-integrated-consultation-workspace.md) §2.2 ("all tools mounted and visible", the "Go to" bar) for the doctor's consultation editor, and builds on [ADR 0021](0021-d2-multimodal-consultation-context.md) (D2) and [ADR 0020](0020-v6-thermal-capture-in-the-consultation.md) (V6). It adds **no model, no prompt, no table and no route**: one field of an existing read model (`ConsultDraft.startedAt`), three fixes to V3's checks, and a new arrangement of what exists.
- **Date:** 6 Oct 2026

## 1. Context

After D2 the consultation held every input (the conversation, the history, vital signs and device readings, stethoscope recordings, thermal images), an AI draft made by the local model (V3), Mana's assistant (V4), the D2 overview, and the note, diagnosis and prescription, in D1's two panes: a long tools column of nine parts with a "Go to" bar, and the note. The owner's brief asked for a premium, doctor-first workstation that tells one story at a glance (**inputs → intelligence → action**): exactly five compact clinical inputs on the left, one prominent "Analyze with Mana", the result on the right with the prescription, the doctor's review before anything reaches the record, thermal imaging as a first-class input, and a clearly separated pediatric shock **research** view, without fake data, fake AI, fake timing or fake predictions.

## 2. Decisions

### 2.1 Two panes, read left to right; a workflow strip on top

From 1024px: the **inputs rail** on the left (20–24rem, sticky, scrolls on its own, "Analyze with Mana" fixed at its foot) and the **main column** on the right: the Mana area (analysis, result, the fixed-rule overview, Ask Mana), then the record (note, diagnosis, prescription with "Before you prescribe"). Only when the main column itself is at least 72rem wide (a 1920px screen) do the Mana area and the record stand side by side. This is not a three-column dashboard: at every desktop width it reads *inputs → intelligence → action*. Below 1024px everything is one column in that order.

A **workflow strip** under the header (*1 Inputs → 2 Mana analysis → 3 Your review → 4 Note & prescription → 5 Sign*) shows each step's real state (from data the page already holds: no request of its own) and jumps to it. It **replaces D1's "Go to" bar**: the five numbered modules are themselves always visible in the rail. The consultation keeps the app's navigation as a drawer at every width (focus mode); the nurse's view and the signed record are unchanged.

### 2.2 Five input modules: a summary always visible, the full panel kept mounted

Each input is a numbered module (*1 Conversation, 2 History, 3 Health band & vitals, 4 Stethoscope, 5 Thermal imaging*) with an icon, a state chip, a one- or two-line summary and a Show/Hide control; the **existing full panel is its body, always mounted, hidden when collapsed**. Unmounting would stop a recording and the only device poller (the reason D1 rejected tabs); a sheet would unmount them on close. The summaries are **observers** of the panels' own queries: they add no request and no audit entry. A panel that fails to draw opens its module so that the failure is seen. Clinical photographs and the older assistant, which are not among the five inputs, move to a "More tools" sheet (they fetch nothing until opened).

### 2.3 "Analyze with Mana": one action, real steps, real time

One button runs, in order: **save** the note (the page's own save chain, so the analysis reads what the doctor just typed), then **in parallel** the fixed **safety rules** (`safety-rules-v1`) and the **local model's draft** (V3, the only engine that writes a summary from the record; its prompt and checks are unchanged in what they ask). It does **not** open or ask Mana's chat (one model slot is shared; Mana stays closed until opened). Before and during the run the panel lists **what each input contributes, as it really is** (the confirmed points, not the raw transcript; the record; staff and device vital signs, unverified, never simulated ones; stethoscope recordings **not analysed**; approved, non-simulated thermal measurements). Progress shows only observable states (saving → saved; rules → n results; model *waiting for the local model* / *writing the draft* / the outcome) and an elapsed clock from the click; the result shows "took m:ss" from the server and, with the new `startedAt`, how long it *waited* and how long the *writing and checks* took. There is no percentage, no ETA and no step that is not observed. Cancel and "Analyze again" use the existing routes.

### 2.4 The result: model output and rules apart, the doctor decides

The local model's draft is shown as the **Mana result** with its existing labels (AI DRAFT · AI-GENERATED · REQUIRES DOCTOR REVIEW), each statement with its server-decided support state and sources, regrouped under *AI summary, Important findings, Conflicts & uncertainties, Missing information, AI-assisted recommendations*. The **fixed-rule** D2 overview and the safety rules follow in a neutral card ("Fixed rules, not AI"). Nothing reaches the note without *Accept* and then *Add to note*; nothing reaches the diagnosis or the prescription at all.

### 2.5 The prescription: no AI prescription rows

No part of the system drafts prescription entries, and none is added here: an AI-drafted row placed in the prescription would be saved and signed with no provenance, and doses are forbidden to the model by design. The prescription card is the doctor's (Medicine, Strength, Form, Dose, Route, Frequency, Duration, Instructions; "Add medicine"; "Print preview" of the unsigned draft, marked "not a valid prescription"; finalized by signing). Beside or below it, **"Before you prescribe"** shows the draft's *medication considerations* (text only, at most four, never a dose, never a medicine not in the record) as **AI DRAFT** statements the doctor may accept and add to the note's Plan, the fixed statement "No AI prescription suggestions…", and the fixed-rule allergy name check.

### 2.6 Thermal as an input, and a research view that stops where the evidence stops

Module 5 shows the camera state ("FLIR ONE not connected" in a browser), the newest image of the consultation (thumbnail, source mark, approval, range), the model status (MODEL UNAVAILABLE) and two actions: the V6 thermal workspace, and **"Pediatric shock research"**: a sheet headed **PEDIATRIC SHOCK — RESEARCH MODE**, "Research only. Not for clinical decisions. Nothing here detects, predicts or scores shock." It shows the research pipeline with each stage's **real** status (acquisition, preprocessing, normalisation and quality checks, feature extraction, feature set, research model, research output, review), the **feature set** of the approved, non-simulated images (measurements, regions, doctor-defined pairs; drafts and simulated images listed as excluded), the model stage as "Research model unavailable. Not currently available. Research pipeline ready for model integration.", and a **Published research** panel for Sudhi et al., *Engineered Science* 2025, 33, 1367 (doi:10.30919/es1367), a **review article**: verified bibliographic fields, its objective, the approaches it discusses, the **published figures attributed to the primary studies it cites** (Nagori et al. 2019, Vats et al. 2022, as stated in those papers and checked against them), its limitations and its research gaps (no established temperature profiles for any shock type), under "PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION". No threshold, score, probability or "gradient" is computed or worded; no language model is asked about an image.

### 2.7 Three V3 fixes found by the workstation's journey

- A record item's date was compared in UTC with the facility's local day, so from 00:00 to 05:30 IST today's vital signs read as outdated; also the 180-day age rule. Fixed (local calendar days).
- A statement quoting the record's "SpO₂ 94 %" was removed as an invented figure (the subscript ₂ became a "2"). Fixed on both sides; the gas symbols' 2 is never a figure.
- A streaming band made every draft STALE within seconds (newer readings pushed older ones out of the inputs). Newer readings of a kind the draft already had from a device no longer make it stale; staff readings, changed or withdrawn readings and a device's first reading of a new kind still do.

`consult-checks-v2`. The prompt, schema and record-check versions are unchanged.

## 3. Consequences

- A jury or a new doctor sees the story without explanation: five inputs, one Analyze, a labelled result, their decisions, the note and the prescription, the signature.
- **Time:** with the local model on this machine's GPU (llama.cpp, Qwen3.5-4B Q4_K_M, about 44 tokens a second), a full draft took 36.9, 39.8 and 43.0 seconds from the click (server 36.2, 39.0, 40.2 s; it writes about 1,600 tokens). The owner's target of about 10 seconds is **not met**; the screen says what is happening and never pretends. Reaching it would need a shorter first answer (a two-step summary-first design with its own prompt and checks) or a faster model: a decision for the owner.
- Hidden-but-mounted panels keep polling (devices every 5 s, capture every 20 s); acceptable because their summaries show what they read.
- Tests that encoded D1's layout were changed deliberately, each with its reason.

## 4. What was not built

AI prescription entries; any stethoscope analysis; any shock, perfusion or capillary-refill computation; any research model; streaming or ETA progress; a separate "finalize prescription" state; changes to the nurse, patient or admin applications.
