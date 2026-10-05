# Intended use and system boundary

**Status: draft for the prototype, 3 Oct 2026.** ADAXAI is an MVP prototype. It is **not production-ready, not a medical device, not clinically validated, and not claimed to comply with any law or standard**. All data in it is synthetic. This document states what the software is for so that risks can be assessed against something; it is a working engineering record, not a regulatory submission.

## Intended use (prototype)

Support a **licensed clinician** in an outpatient consultation by:
- showing the clinician the patient's recorded history, allergies, medicines, results, vital signs and earlier consultations;
- capturing the consultation as text (typed, or transcribed from audio) and proposing, **as drafts for the clinician to accept, edit or reject**, important points, a note summary and suggestions;
- preparing, on request and **from a language model that runs on the same computer**, an **AI-generated draft** of what the record, the clinician's own notes and the clinician-confirmed points say, with what is missing, where the record disagrees with itself and considerations to weigh, every statement tied to the record items it rests on (slice V3, [ADR 0016](../adr/0016-local-ai-consultation-intelligence.md));
- answering the clinician's questions about **the clinic's own records** in a read-only conversation (**Mana AI**, slice V4, [ADR 0017](../adr/0017-mana-ai-doctor-assistant.md)): about a patient (a briefing, history, allergies, medicines, vital signs, results, a signed consultation) and about the clinic's day (the queue, appointments, the clinician's own consultations), from registered read-only tools run for the clinician in their own clinic, with a language model that runs on the same computer writing the answer and code checking it, every statement tied to the records the clinician can open. It is a **doctor-facing AI assistant; its outputs require clinician review**;
- measuring skin-surface temperatures from radiometric FLIR thermal images (uploaded on the thermal pages or, since V6, imported in the consultation; live capture from a FLIR ONE on a tablet is written but **has never been compiled or run**), and composing, **by fixed rules and not by AI**, a summary of what was measured for the clinician to accept, edit or reject before it can be added to the note (slice V6, [ADR 0020](../adr/0020-v6-thermal-capture-in-the-consultation.md));
- recording the clinician's decisions in a signed, tamper-evident, auditable record, and making permitted parts of it available to the patient.

## Intended users

| User | Use |
| --- | --- |
| Doctor | Consults, reviews drafts, decides, signs |
| Nurse | Registers and checks in patients, records vital signs; reads, does not edit, consultations |
| Patient | Reads their own signed records and messages |
| Administrator | Manages accounts and devices; reads operational counts and the audit log; cannot read patients' clinical records |

## What the software does not do

- It does **not diagnose, prescribe, triage or decide**. Every AI output is a draft that a clinician must accept, edit or reject; nothing AI-generated is signed, prescribed or added to a record without a clinician's action. The consultation draft's "considerations" are things to weigh, never orders, never doses, and there is no route from a draft to the diagnoses, the prescription or an order. **Mana AI cannot prescribe, sign, change, add, delete, book or cancel anything**: it has no tool that writes, it refuses a request to, and nothing it writes reaches a note, a diagnosis or a prescription. It gives no advice and answers no general medical question (there is no governed source of medical knowledge in the system).
- It does **not** provide a validated measurement. Device readings are stored as *unverified*; blood pressure is entered by a person; thermal flags are rule-based, not validated, and are not a diagnosis; the thermal summary is composed from the measurements and those flags by fixed rules, not by AI, and **no thermal model exists**; thermal imaging measures skin-surface temperature only, and the software produces **no pain score** and no finding of swelling, inflammation, infection or fracture.
- It is **not for emergencies, for unsupervised patient use, or for any use on real patients** until clinical, legal, regulatory and security validation has been done.

## System boundary

Inside: the web applications (doctor, nurse, patient, admin), the API, the PostgreSQL database, the thermal-processing service, locally hosted AI model servers (a speech model, [ADR 0014](../adr/0014-local-speech-service-and-capture-pipeline.md), and a language model, [ADR 0016](../adr/0016-local-ai-consultation-intelligence.md); both loopback only, both downloads approved by the owner), file storage on the same machine, and the Android tablet app with its thermal camera bridge (`android/`: **written, never compiled or run**, [THERMAL_CAMERA.md](../THERMAL_CAMERA.md)).

Outside, and not controlled by ADAXAI: the operating system and network, the clinician's judgement, any wearable, stethoscope or thermal camera hardware (none is integrated today: the device boundary is exercised by a labelled simulator, a program whose values are stored and shown as simulated and are not part of any record, [ADR 0018](../adr/0018-device-readings-states-gateway-and-simulator.md); thermal images arrive as radiometric files or, from the thermal simulator, as numbers marked SIMULATED, [ADR 0020](../adr/0020-v6-thermal-capture-in-the-consultation.md)), the FLIR SDK the bridge is written for (FLIR's licence), and any hosted AI provider (off by default; if selected, patient-derived text or audio leaves the machine under the provider's terms).

## Principles that follow from the intended use

1. **Human oversight:** the clinician is always the decision-maker; the interface shows what is draft, what is confirmed, what is measured and what is model output.
2. **Evidence:** AI statements cite their source or say the record does not establish the answer.
3. **Least privilege and default deny:** roles, facility scope and patient consent are enforced by the server.
4. **Traceability:** who did what, when, with which model version, is recorded in an append-only, hash-linked audit log.
5. **Honesty about uncertainty:** unavailable, stale, simulated and unverified states are shown, never hidden.
