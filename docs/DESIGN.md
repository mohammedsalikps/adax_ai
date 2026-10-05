# ADAXAI design system

How the product looks and why. It was introduced in slice 4 (appointments) together with the
first screens built on it: the application shell, the doctor's Home and the appointment pages. The
other screens inherit the tokens (colour, radius, type, control sizes) but have **not** been
redesigned; see [What is and is not covered](#what-is-and-is-not-covered).

The reference was a premium clinical “Doctor App” mock-up: clean white and neutral surfaces, one
restrained blue, soft borders, rounded cards, readable type, little clutter, no heavy gradients or
animation. Its sample data and controls were **not** copied: every control in the product exists
because the product can do it.

## 1. Audit of the previous UI against the reference

| Area | Before | Reference | Done |
| --- | --- | --- | --- |
| Colour | Teal brand, cool grey canvas | Restrained blue, white cards | Blue brand token (`#2563eb`), cool near-white canvas; favicon, icons and theme colour changed to match |
| Type | System stack, default scale | Modern readable sans | Modern system stack (Segoe UI Variable, SF, Roboto, Inter if installed) with a named scale; see the font note below |
| Shell | Top bar with a flat left list, role chip, no search, no avatar | Sidebar with icons, top bar with search and profile | `AppShell`: sidebar, top bar with patient search, avatar, role, department and clinic, sign out |
| Landing | The doctor landed on the queue | Dashboard: four numbers, schedule, quick actions | Doctor **Home**: four real counts, today's schedule, patients ready, shortcuts |
| Schedule | Stack of cards | Table with status chips, search, date | `AppointmentTable` (table on wide screens, cards on phones), status filter with counts, device-side search, scopes and a date |
| Cards | 12px radius, no elevation | Rounded, soft border | 16px radius, hairline border, near-invisible shadow |
| States | Spinner, bare alerts, no retry on most lists | n/a (a static mock-up) | Loading placeholders, empty with an icon and a next step, failure with **Try again**, refusal without a retry |
| Dialogs | One generic dialog, toasts that appear behind a modal | n/a | One dialog; `ConfirmationDialog` for cancel / did-not-attend; results inside a dialog are shown inside it |
| Phone | Menu list under the header | n/a | Drawer with its own close button, focus handling and an inert page behind |

**Font note.** No web font is bundled. A font file would be a new dependency and, unless
self-hosted, a request to a third party from a clinical app; the system stack renders a modern
sans everywhere and works offline. The cost is that the face differs by device. If a single face
is wanted, self-host a variable font under `apps/web/public/fonts` with `font-src 'self'` and put
it first in `--font-sans`; nothing else changes.

## 2. Tokens

Defined once in [`apps/web/src/styles.css`](../apps/web/src/styles.css) (Tailwind 4 `@theme`).
The shell and the components added with it use the names. Older pages still contain some raw
sizes (`min-h-11`, `text-[10px]`) that match the tokens in value; they move over as each is touched.

| Group | Tokens |
| --- | --- |
| Surfaces | `canvas #f5f7fb` (page), `surface #fff` (cards, bars), `line #e3e8ef` (dividers, card edges), `line-strong #cbd5e1` (buttons) |
| Controls | `control #7c8ba1`: the edge of inputs, selects and text areas (3.4:1 on white, 3.2:1 on the canvas, WCAG 1.4.11 non-text contrast) |
| Text | `ink #0f172a`, `ink-muted #475569` (7.6:1 on white) |
| Brand | `brand #2563eb` (5.2:1 with white text), `brand-strong #1d4ed8` (hover, link text), `brand-soft #eff6ff` (selected, tints) |
| Status | `ok`, `pending`, `down #b91c1c`, `notice`: each an ink with a `-soft` tint; **always** shown with a label (and an icon or dot), never colour alone |
| AI | `ai` / `ai-soft` (violet): reserved for AI-generated draft content, so it is never mistaken for a signed record |
| Type | `xs 12/16`, `sm 14/20`, `base 16/24`, `lg 18/28`, `xl 20/28`, `2xl 24/32` (page titles), `stat 30/36` (numbers) |
| Spacing | Tailwind's 4px scale |
| Radius | `sm 6`, `md 8` (controls), `lg 12`, `xl 16` (cards), `2xl 20` (dialogs) |
| Elevation | `shadow-card` (hairline), `shadow-pop` (dialogs, drawer) |
| Sizes | `control 44px`, `control-sm 36px` (touch targets), `row 72px`, `row-compact 56px` (minimum schedule row heights), `sidebar 256px`, `topbar 64px` |
| Icons | 16px inline with text, 20px in navigation and tiles, 24px for the menu; always `aria-hidden` beside a text label |
| Focus | One ring everywhere: 2px `brand` outline, 2px offset (`:focus-visible`) |
| Motion | None beyond a 180ms settle, a spinner and a loading pulse. `prefers-reduced-motion` limits every animation to one instant cycle (they stop), and smooth scrolling is off |

## 3. Components

Where the brief's name differs from the code's, the code's name stays (renaming would churn every
page for no gain). Components exist only where a screen uses them.

| Brief | Implementation | Notes |
| --- | --- | --- |
| AppShell, Sidebar, TopBar | `components/shell/AppShell`, `Sidebar`, `TopBar`; route element `PortalLayout` | One shell for all four roles. Pages per role in `lib/nav.ts`. Patient search for doctors and nurses only |
| PageHeader | `ui/Layout` `PageHeader` | Title, one-line description, actions |
| StatCard | `ui/Layout` `StatCard` | An icon tile, a label, a number, a hint. Shows a dash (never a zero) while loading or failed |
| PatientAvatar | `ui/PatientAvatar` | Initials only: the product holds no photographs. Hidden from assistive technology (a name is always beside it) |
| StatusBadge | `ui/Feedback` `Badge` (with `dot`), `AppointmentStatusBadge`, `VisitStatusBadge` | The existing `StatusBadge` is the service-health pill on the admin overview |
| AppointmentTable | `components/clinical/AppointmentTable` | See below |
| PatientProfilePanel | `components/clinical/PatientProfileDrawer` | Built with the workstation (§4b): a side sheet over the consultation |
| SectionCard | `ui/Layout` `Card` | Its title names the region for assistive technology |
| EmptyState, LoadingState, ErrorState | `ui/Feedback` | `ErrorState` offers **Try again**, except for a refusal (403), which says so and offers nothing to retry |
| ConfirmationDialog | `ui/ConfirmationDialog` | Says what will happen, offers “keep it” first, can ask for a reason, shows failures inside the dialog, cannot be dismissed while the request is in flight |
| FormField | `ui/Form` `Field`, `TextField`, `SelectField`, `TextAreaField` | Label, hint, error and `aria-describedby` wired once |
| Primary / SecondaryButton | `ui/Button` variants `primary`, `secondary`, `danger`, `ghost` | One component, four variants, two sizes |
| (new) SegmentedControl | `ui/SegmentedControl` | A short row of exclusive choices; each is a toggle button with a pressed state |
| (new) Tabs, TabPanel | `ui/Tabs` | Real tabs: arrow keys, Home and End, one tab stop, each tab names its panel. `underline` inside a card, `pill` (with counts) above a list. Inactive panels stay in the page, hidden, so their state is kept |
| (new) Menu | `ui/Menu` | An overflow ("more") menu: opens with Enter, Space or Down, arrows move, Escape returns to the button; placed against the viewport so a table cannot clip it. For commands without room of their own |
| (new) Side sheet | `ui/Dialog` with `placement="right"` | The same native dialog (focus trapped and restored, Escape closes, page behind inert), at the right edge |

**AppointmentTable.** A list of rows styled as a table (a grid with a decorative header) from the
`xl` breakpoint (1280px, where the content is about 960px wide) and as stacked cards below it, so
there is one structure at every width and the columns always line up with the header. On the
doctor's Home the schedule has the full content width until 1536px, and shares it with a side
column only above that. Each
row carries its time and length, the patient (avatar, name, MRN, reason), the clinician and
department, the status with any flags, the linked visit, and **Check in** when the server allows
it. Everything else (reschedule, cancel, did not attend, history, messages) is in **Details**: the
destructive actions are one deliberate step away. The row shows no “patient not told” flag for the
normal case (a patient without portal access); it flags a cancellation the patient may not know
about and a message that failed.

## 4. The doctor app's information architecture, as built

| Brief | Built | Why / why not |
| --- | --- | --- |
| Sidebar: Home | **Home** | Real data only |
| Patients | **Patients** | |
| Today's Schedule | **Appointments** (scopes: today, upcoming, past, a date) and **Today's schedule** on Home | One page, not two |
| Consultations | **My consultations** | |
| Reports | not built | There is no reporting feature; a link would be a fake control |
| Mana AI | not a page | Mana answers about one patient's record, so it lives on the patient record and in the consultation. A stand-alone page would have no patient to ask about |
| Settings | not built | There are no user settings. **Change password** is at the bottom of the sidebar |
| (existing) | **Today's patients** (the doctor's view of the OPD queue; nurses keep **OPD queue**), **Thermal**, **AI review** | Kept |
| Top bar: patient search | Yes, for doctors and nurses | Submitting opens the Patients page with the term in the router state: not in the address, a shared link, the referrer or a server log; the page takes it once and clears it from the history entry, so a reload or Back does not repeat the (audited) search. Nothing is searched until it is submitted. Two characters at least |
| Notifications | not built | Staff have no notifications; the outbox is for patients |
| Doctor, role, facility | Yes | Name, role, department and clinic (from `/api/auth/me`) |
| Dashboard: Total in queue / Ongoing / Completed / Upcoming | **In the queue**, **With a doctor**, **Completed today**, **Appointments to come**, under a time-of-day greeting | Counted from today's queue and schedule, for the doctor's own patients |
| Today's Schedule list with *Start* | **Today's schedule** on Home: who is still to be seen, in time order (appointments and walk-ins together), with the action that applies | Patients ready or in the room are always listed (however many), and the next three others stay in view; *Start*/*Continue consultation* only when the visit allows it; *Check in* for a booked appointment; otherwise the state in words |
| Quick actions | **New appointment**, **Register patient**, **Find a patient**, **My consultations** | Only to places that exist (the reference's *View reports* and *Mana AI* have nothing behind them) |
| Today's Patients (tabs, date, table, row menu) | **Today's patients** (`/doctor/queue`) | See §4b |
| Consultation workspace | **Built in part** (§4b, §4c): header, banner, past history, patient summary, profile sheet, **live transcription with timestamps and doctor-assigned speakers, and important points** (V2). **A live stethoscope, a waveform, a writing pad and the AI summary are not built** | Each shows its real state or says "not available yet" |

## 4a. The front door and sign-in pages

The first thing anyone sees (`/login`) and the three sign-in pages share one frame and the same
tokens; they set the look future applications inherit.

| Component | Where | Role |
| --- | --- | --- |
| `AuthShell`, `AuthHeader`, `BackToApplications` | `components/auth/AuthShell` | The frame of every signed-out page (also activation and the password change): skip link, product mark, development notice; the heading with the application badge and one line; the way back |
| `ApplicationCard` | `components/auth/ApplicationCard` | One application on the selector: who it is for, what it really offers (only features that exist), one button-styled link. The description is guidance, never a permission |
| `ApplicationBadge`, `appStyle` | `components/auth/` | Names the application ("Doctor App") on its pages: an icon, a tint and an accent line from the tokens (blue for clinical work, green for the patient's space, ink for administration) |
| `LoginForm` | `components/auth/LoginForm` | The sign-in form of one application: labelled fields, a loading state, retry, forgotten-password help (who can reset it; there is no self-service reset) |
| `PasswordField` | `components/auth/PasswordField` | Password with a show/hide toggle (a button with a pressed state) |
| `ErrorBanner` | `components/auth/ErrorBanner` | A sign-in problem announced at once: a title, a sentence that helps, and **Try again** when the problem is the service |
| `ServiceStatus` | `components/auth/ServiceStatus` | "Sign-in service available", or unavailable with a retry, from the public `/api/ready` |
| `SignedInNotice`, `NoAccessPage` | `components/auth/`, `pages/NoAccessPage` | Someone signed in as another role at a sign-in page, or opening another application's address: said plainly, with their own workspace and sign-out, never a silent move |

Behaviour rules for these pages: errors never show a code or a trace and never say which usernames
exist; a banner for a service problem offers a retry and a refusal does not; the selector stacks to
one column below 768px, and every control is at least 44px; keyboard order is skip link, way back,
fields, password toggle, Sign in. Verified in Chromium at 1440 × 900, 1280 × 800, 1024 × 768 and
390 × 844 (see [STATUS.md](STATUS.md)).

## 4b. The Doctor workstation (slice V1)

The reference is a clinical workstation: dense, calm, one patient in focus. These are the parts of it that are built, each from real data.

**Today's patients** (`pages/doctor/TodaysPatientsPage`): filter tabs with counts (all, waiting, in the room, completed, cancelled or no-show), a day picker, *My patients / Whole clinic*, and a row per visit in the same table-look grid the schedule uses (a table from 1280px, cards below): token, time (the appointment's, or the check-in's), the patient with age, sex, MRN and **allergies always shown**, the reason and clinician, the status, and the action that moves the patient on; vitals, routing, editing and cancelling are in the row's menu. Another day shows that day's record and says it is not live. Nurses keep their own `OPD queue` page.

**Consultation** (`pages/doctor/ConsultationPage`):

| Part | Component | Behaviour |
| --- | --- | --- |
| Header | `ConsultationHeader` | Back to today's patients, "Consultation", **"Draft · in progress"** and the elapsed time (for the eye; screen readers hear the start time once), the save state, **Save**, **Complete consultation** (which opens the review and sign step) and a **More** menu holding *Discard draft…*. Sticky from 1024px; below that the actions are a bar fixed to the bottom of the screen, so the save state and *Complete consultation* are never scrolled away. Once the banner has scrolled out of view, the patient's **name, MRN and allergies** stay with the bar (under it from 1024px, above the actions below that) |
| Banner | `ConsultationBanner` | Avatar, name, age, sex, MRN, blood group, a *Synthetic* tag from the data, **allergies with severity** (red for severe, amber for moderate **and for "severity not recorded"**: not recorded is not mild; neutral only for mild), known conditions, the token, department and day, whether the **latest reading of each kind** this visit is within the **adult reference range** (a display aid; says what it rests on, and that no range is applied to children or to kinds without one) and **View profile**. The allergy list is re-read every minute and when the window regains focus. While the record loads, or if it cannot be read, the allergy names from the consultation itself are shown too, and a failed refresh adds **"Allergy list may be out of date"**: an allergy is never hidden, and an old list is never presented as current, by a failed request. The same chips are shown **where medicines are chosen** (the Prescription card) and **in the review-and-sign step** |
| This visit | `Card` + `VitalsTiles` | The reason, and each latest vital sign as a tile with its **time and source** ("entered by staff", or "device, unverified"). Blood pressure is the two values together. There is no live feed: a reading is as old as its time says |
| Past history | `PastHistoryPanel` | Tabs *Summary, Consultations, Medications, Allergies, Investigations*, all from `GET /api/patients/:id/history`. Earlier consultations show what was prescribed, labelled "not a record of what the patient takes". Doctors add, stop and correct entries (dialogs); **every entry shows who entered it and when**, and the stop and entered-in-error dialogs **repeat the entry as it reads** (what, since when, status, who entered it) because two entries can share a name; nothing is deleted. A result is typed as it reads with its unit and range; a plain number is compared with the range by the server. Loading, empty, error-with-retry and refused states. Collapsible |
| Patient summary | `RecordSummary` | Conditions, allergies, current medicines, results outside their range and the last consultation, **composed by fixed rules from the record and labelled "not AI-generated"**, with what it is based on |
| Patient profile | `PatientProfileDrawer` | A side sheet: *Overview* (demographics and the summary), *Full history* (the same panel) and *Documents* (photographs, stethoscope recordings, thermal studies). Escape closes it and focus returns to *View profile* |
| Capture | `CapturePanel` (§4c) and existing cards | **Live transcription** and **Important points** first in the left column (§4c); then the stethoscope card (upload and playback only, and it says so) and clinical photographs |
| Digital writing pad | `WritingPadCard` | **"Not available yet"**, with what it needs. No control |
| AI | `ConsultationIntelligence` (§4d), then existing panels | **Consultation intelligence** (V3: an AI draft from a model on this computer), then Mana, and the AI assistant (note suggestions, recommendations, activity: no recording or transcript any more). Each says plainly when its provider is not configured. The patient summary above them stays the rules-composed one, labelled "not AI-generated"; nothing AI stands in for it |

**Layout.** Three columns from 1400px (**capture** and this visit, 20rem | past history and the note | the patient summary and the AI panels, 22rem); two from 1280px **in the same left-to-right order** (capture and this visit with the summary and the AI panels under them | the note); one below, with capture first. The columns were mirrored at 1280px in V2 so that the transcript is on the left at every width where there are columns (before, the two-column layout put it on the right). At 1440px the middle column is about 420px wide, so the diagnosis and prescription editors lay their fields out **by the width of their own column** (container queries), not of the screen: two fields per row at that width, four on a tablet, one on a phone. An end-to-end test measures every field at nine screen widths (1920 down to 390) and fails if one is narrower than 110px or leaves its card.

**Not built, on purpose:** a live stethoscope, a heart-sound waveform, vital-sign sparklines (no series is fetched, and nothing is drawn that is not data), a waveform of the consultation audio (the recorder shows the microphone's real level, nothing more) and the writing pad. They need the slices in [DOCTOR_APP_PLAN.md](DOCTOR_APP_PLAN.md). (The AI consultation draft was built in V3: §4d.)

## 4c. Live capture (slice V2): three kinds of content that are never mixed

`components/capture/` (`CapturePanel`, `Recorder`, `TranscriptView`). It is a clinical workstation card pair, not a chat: compact rows, tabular timestamps, small speaker chips, a calm neutral surface, and colour used only to say what a piece of content *is*.

| Kind | Where | How it looks | What it is |
| --- | --- | --- | --- |
| **Raw transcript** | *Live transcription* card | Neutral grey surface with a heavy rule down the left edge; the label **Raw transcript**; one row per line: its time on the recording (`mm:ss`, tabular figures), a **speaker chip**, a language badge if it differs from the recording's, a **Low model score** badge when the model itself was unsure, the line's id (S4) and the text exactly as heard | What the speech model heard. Typed text shows no time and no language, because it has none |
| **Extracted draft** | *Important points* card | **Dashed violet** border and tint, an **Extracted draft** badge with the sparkle mark, the category, who said it (or **Speaker not assigned: guessed patient** in amber when nobody assigned the line), the point in the speaker's own words, *From* chips with the source lines' times (click one to find the line in the transcript), "Rules on this computer (extract-rules-v1) · time", review flags (⚑), and **Confirm / Edit / Reject / Set aside** | What the system thinks may matter. Not part of the record |
| **Doctor confirmed** | *Important points* card, its own section | **Solid green** border and tint, a **Doctor confirmed** badge with a tick; the separate **Add to note** button appears here only | A point the doctor accepted. Still not in the note until *Add to note* |
| **Doctor rejected** | A collapsed list under the points | Grey, struck through, kept | What the doctor refused. Never offered again |

- **Speaker chip.** Unassigned lines read **Not assigned** with a dashed outline; a doctor-assigned line carries a tick. The chip is a menu (Doctor, Patient, Nurse, Relative, Attendant, Other, Not assigned): Enter or Space opens it, arrows move, Escape closes it. Changing a speaker never changes the words. The same chip, without the menu, is shown on a signed or read-only consultation.
- **Recorder.** One button, **Start recording**, which is absent until the patient's consent is recorded and disabled with the reason when the local speech service is unavailable. While recording: a red pulsing dot and the word **Recording** with the clock, **Pause** (the clock holds) and **Stop**, the microphone's real level, and "N parts sent". Failures are said in words: microphone refused, no microphone, microphone busy, unsupported browser, consent withdrawn (recording stops, the part being recorded is thrown away), recording ended elsewhere, a part that could not be sent.
- **Hosted AI is shown as a state too.** The assistant panel carries a "Hosted AI: off" badge (with "Nothing leaves this computer" and that it is a server setting this screen cannot change) or, when the server allows it, "Hosted AI: allowed (to <host>)" with the external-service disclosure; the administrators' AI page says the same and whether a key sits unused. Nothing on a screen can switch it.
- **Unavailable is a state, not an error.** Without the local speech service the card says **Local transcription unavailable**, why, and that no audio is ever sent to a hosted service instead; typed transcripts remain.
- **Order.** Lines are in time order; a part still being transcribed is a row in its place ("Transcribing part 3…"), a part that failed says so with **Retry**; it is never filled with guessed text.
- **Sizes.** Checked at 1440×900, 1280×800, 1024×768 and 390×844 by the end-to-end layout test (no horizontal overflow; both cards inside the page width; at 1440 the note is to the right of capture) and by looking at the screenshots it writes. At 20rem the point cards are tall (flags and the confirmation tick take lines); that is deliberate: each flag is a reason to look.

## 4d. Consultation intelligence (slice V3): an AI draft that is read, never trusted

`components/ai/ConsultationIntelligence.tsx`, the first card of the consultation's side column (right-hand column from 1400px; under the left column's cards at 1280px; stacked below that). It is the same violet as every AI surface and it is **a draft to read**: the three labels **AI DRAFT**, **AI-GENERATED** and **REQUIRES DOCTOR REVIEW** are always at the top, with one sentence saying what it was made from (the record, the doctor's notes and the points the doctor confirmed), that nothing reaches the note, the diagnoses or the prescription until a statement is accepted *and* added by a separate click, that it is not clinically validated, that **"Supported by record" means the cited record items contain the statement's words and figures, not that the statement is right** (so the items are to be read), and which model made it ("Local model qwen3.5-4b-q4_k_m: it runs on this computer and nothing leaves it", or the hosted warning if the server is set to hosted).

| State (badge) | When | What the card shows |
| --- | --- | --- |
| **NOT RUN** | A model is available and no draft was asked for | "Generate draft", and the **record check** (fixed rules: conflicts, old items, what is not recorded) |
| **GENERATING** | A draft is being made | Elapsed time ("the local model is writing the draft ... it can take a few minutes on this computer"), or "waiting for the local model" when another draft is ahead; **Cancel** |
| **READY FOR REVIEW** | Finished | The draft, grouped as a doctor reads it: Clinical summary; Current problem (problem, symptoms, observations); Relevant history (history, allergies, medicines); Potential considerations; Potential investigations; Medication considerations; Missing information; Conflicts and uncertainties (with the rules' own findings above the statements) |
| **PARTIALLY AVAILABLE** | Statements were removed because they could not be verified | The same, with "Some statements the AI wrote were removed because they could not be verified against the record (n)" |
| **INSUFFICIENT INFORMATION** | Too little is recorded to draft from: the model is not asked, or it said so and nothing it wrote could be kept | Says which of the two it was, what to add, and the record check |
| **STALE** | The record, the note or the confirmed points changed after the draft | A warning with one sentence saying what changed; each affected statement says "changed since" |
| **FAILED / CANCELLED** | The model failed, timed out, answered in the wrong form or the doctor cancelled, **and there is no earlier draft** | The reason in words and **Try again**; nothing from the failed attempt is shown. **With an earlier draft, that draft stays on screen** (READY, STALE ...) under a note, **"The newest attempt did not finish"**, that says why and whether trying again can help: a later attempt never hides or replaces a draft the doctor already has |
| **UNAVAILABLE** | The local model is not running (or AI is switched off, or hosted is refused) | **"Local AI unavailable."**, why, **Check again**, and "no draft is made without it, and nothing is made up". The record check below does not need AI |

**What the rules found is not tucked away.** The record check's list of what is not recorded appears in the **Missing information** group under "Found by fixed rules, not by the AI" (the model names little of it); a conflict the rules found is written under each statement that rests on it, and above the statements of the conflicts group.

**What the AI was shown.** Under every finished draft one line says how many record items were shown to the AI and, when the record held more than fits the model's context, **how many did not fit and were not shown** (older and less central ones go first), and that only confirmed points were used (rejected and unreviewed points, the transcript and the audio never are).

**A statement** is one card: its **support badge** (*SUPPORTED BY RECORD* green; *INFERRED* violet; *NOT FOUND* grey; *CONFLICTING* red; *OUTDATED* amber; never by colour alone), then the text, then **"Checks to make"** (each flag in words, with an alert mark), the rules' own sentence when it is a conflict they found, **"Why the AI listed this"** and **"Uncertain: …"** in the AI's own words (labelled as not a measured probability), and **Sources (n): A1, N2 ...** that opens to each cited record item (its id, field, date, status and the excerpt the model was shown; "changed since this draft" or "no longer in the record" when it moved). A marked statement shows **"I have checked this against the record"**; **Accept** and **Save edited text** stay disabled until it is ticked (the server enforces the same). **Accept**, **Edit** and **Reject** record a decision; an accepted or edited statement then offers **Add to note section** (a menu of note sections) and **Add to note**, which is the only way text moves into the note, appended at the end of the section, never replacing the doctor's own words; once added, the card says **In the note**. A rejected statement stays, struck through and grey.

**How it is built for the doctor.** The card polls while a draft is being made and every 5 s while the model is unavailable; it announces progress through a status region. Every control is a real button or native control sized by the design system's rules (axe's target-size check passes in each state), the sources are native `details`, and nothing is conveyed by colour alone. At 1440, 1280, 1024, 412 and 390 px the card stays inside its column and the page does not scroll sideways (checked by the end-to-end tests with axe in each state). The AI's statements are worded as "Consider ...", "Not found" or "Inferred" and carry a support badge; none is worded or shown as a diagnosis.

**Not built:** streaming text, side-by-side diff against the note, a way to correct the AI's *reason*, a comparison of drafts.

## 4e. Mana AI (slice V4): a conversation with the clinic's records, closed until opened

`components/mana/ManaAssistant.tsx`, mounted in the consultation's side column (under the consultation draft card) and as the companion card of the patient's record. It replaces the slice-1 "Mana questions" card on the screen. The header reads **MANA AI — Doctor's Clinical Assistant** (the same violet as every AI surface) with one button, **Open**. **It is closed until the doctor opens it and nothing is asked of the server before**: opening it opens (or continues) the doctor's conversation for this consultation or patient, and closing it discards what the browser loaded.

| State | When | What the panel shows |
| --- | --- | --- |
| **Closed** | Default | The header and **Open** |
| **Open** | The doctor opened it | A line saying whom it is about (for a consultation: name, MRN, age and sex), suggested questions as buttons (*Brief me on this patient*, *Allergies on record*, *Last prescription and medicines*, *Vital signs compared with earlier*, *What changed since the last visit*, *Visits of this patient*, *My queue today*, *My appointments today*, *My consultations today*), the input (**"Ask Mana about this patient, today's queue, or hospital records..."**), **Send**, **New conversation**, and the footer "Mana AI is a doctor-facing AI assistant; its outputs require clinician review. It only reads records you can already see, and cannot prescribe, sign or change anything." |
| **Generating** | A question is being answered | The phase in words (*Waiting for the local model*, *Working out what to look up*, *Reading the records you may see*, *Writing the answer*, *Checking the answer against the records*) and **Stop** in place of Send |
| **Answer** | Finished | **About <name> · MRN · age and sex** (written by the server from the records that were read); the statements, with the patients' names put back for their handles; under each statement its **source chips** in words ("Allergy · 1 Sep 2026"), a mark when it rests on records that disagree, only on old records, goes a little beyond its sources, or also rests on another record; then the findings found by rule (*Records disagree*, *Possibly outdated*, *Not in the records*, *Unusual text, not used*), how many statements were removed, **Records read for this answer**, and **How this was made** |
| **Source opened** | A chip was pressed | The record: its kind, its date, its state, the words of the record, and a link to the consultation or the patient record |
| **Choice of patient** | A name fits several patients | "I found multiple matching patients. Please select one." and up to five buttons (name, MRN, age and sex, last visit); nothing clinical is shown until one is chosen |
| **Refusal** | A request to change something, a general medical question, or more than a doctor's work needs | The fixed words, nothing else |
| **Could not verify** | Every statement the model wrote was removed, or one of them was a link, a claimed action or an unknown handle | "Mana could not safely verify that response.", what the rules found, and the records that were read; none of the model's words |
| **Error** | The model failed, timed out or answered in the wrong form, a patient's consent changed meanwhile, or the doctor's access changed | The reason in words and, when trying again can help, **Ask again** |
| **Unavailable** | The local model is not running | **"Mana is currently unavailable."**, why, **Check again**; the input and Send are disabled; the panel looks again every few seconds and comes back by itself; nothing is stored or made up |

**How it is built for the doctor.** The panel polls while an answer is being made. One status region tells assistive technology what arrived (*Mana answered.*, *Mana did not do that.*, *Mana could not safely verify that response.*, *Mana needs you to choose or to say more.*), not the whole answer: each answer that arrives, once, also when two in a row are worded the same (the line is replaced), and not the answers that were already there when the panel was opened; the messages inside the log carry no live-region role of their own, so nothing is said twice. The conversation is a labelled scrollable group; after Send, Stop, a suggestion, a choice or *Ask again* focus is in the question box (the button that was pressed has left the screen or been replaced). A choice between patients can be made only while it is the last thing said; after the next answer its buttons are disabled. Enter sends, Shift+Enter writes a new line, Stop ends a question. Every control is a real button or native control, sources are native `details`, nothing is conveyed by colour alone, and at 1440, 1280, 1024, 412 and 390 px the panel stays inside its column and the page does not scroll sideways (checked by the end-to-end tests with axe in each state, and by looking at the screenshots: see [STATUS.md](STATUS.md)).

**Not built:** streaming text, a way to put an answer into the note (a doctor copies what they choose), a separate Mana page, voice.

## 4f. Device readings (slice V5): a state on every value, and SIMULATED said out loud

The card sits in the consultation's left column under "This visit", and on the patient record. It follows the plan's rule that **measured data, model output and clinician interpretation are never mixed**, with one more separation: a **simulator's** values are neither.

- **One device, one block.** The label, the kind, when it was attached (and until when), the device's state, the last contact from its gateway with its age, and the reason for any state that is not live, in a sentence.
- **One kind, one tile**, two to a row at every width: the name, a **state chip** on its own line (LIVE with a dot, STALE, DISCONNECTED, or "No reading"), the value (greyed when not live), a flag against the adult range for a device value, "Measured 10:15:42 · 8 s ago" or "Last measured …", and what it is: "Device · unverified" or "Simulated · not a measurement".
- **States are words, always**; colour repeats them (ok, pending, down, neutral) and is never the only cue. The chip is sized so that the longest word fits the narrowest tile (checked in the browser at five widths).
- **SIMULATED** is a dashed frame around the device block and each tile, a dashed "SIMULATED" chip beside the state, and a sentence: "A simulator generates these values. They are not measurements of this patient and are not part of the record." Simulated values carry no range flag. The same chip marks simulator records in the device lists and simulated audio in the stethoscope list.
- **Nothing is filled in.** No device attached: "Unavailable. No device is attached to this patient." No consent: says so and disables "Attach a device". The server unreachable: an error line with the time of the last read; the values stay, ageing.
- **Not a monitor.** A footer says what live, stale and disconnected mean with the configured seconds, that the card is re-read every few seconds, and that it raises no alarm. There is no live region on the values (a screen reader is not told every five seconds); the states are text.
- **Seconds matter here**: times on this card show seconds, and ages are "just now" (under five seconds), "12 s ago", "3 min ago".
- **Stethoscope recordings**: "Record" (in the browser, from a chosen audio input, with a sentence that the system cannot tell what an input is) beside "Add recording" (a file); each recording says how it arrived.

## 5. Rules the screens follow

- **No fake controls.** A control appears only if the product can do it.
- **Clinical safety is visible.** AI content is violet and labelled as a draft; the signed record
  is not styled like it. The development banner stays on every page.
- **Nothing succeeds silently or falsely.** Success messages say what happened; where a patient
  could not be told, the message says so.
- **Destructive actions are confirmed**, with a reason where the record needs one.
- **Times are the clinic's.** The API sends a day and a clock time; the browser's timezone is
  never used for an appointment. Instants (history, message times) are shown on the clinic's
  timezone, which the API supplies with them.
- **Every list has five states:** loading, empty, populated, failed (with retry) and refused.
- **Accessibility.** Landmarks (skip link, banner note, navigation, search, main), one `h1`,
  labelled regions, visible focus, a scroll margin under the sticky top bar, 44px targets (36px
  in dense rows), form-control edges at 3:1, status never by colour alone,
  `prefers-reduced-motion`, a drawer that manages focus (in on open; back to the menu button, or
  to the new page, on close) and makes the page behind it, and the skip link, inert. A dialog
  with a request in flight cannot be closed, even by a repeated Escape, and when one dialog
  replaces another (Details, then Reschedule) focus returns to what opened the first. The drawer
  also stops the page behind it from scrolling. The e2e suite runs axe
  (WCAG 2.2 A and AA rules that axe can test; it does not test non-text contrast, focus order or
  screen-reader output) and a horizontal-overflow check on the screens listed in section 6.
- **Responsive.** Desktop first; below 1024px the sidebar becomes a drawer and the search moves
  under the top bar; below 1280px the schedule's rows stack as cards; the side column of Home
  appears from 1536px.

## 6. Verification, and what was not verified

Done, in headless Chromium against the disposable end-to-end stack:

- Screenshots reviewed by hand at **1440 × 900** and **390 × 844** (a phone), plus the suite's own
  **1280 × 720** desktop and **412 × 915** phone projects. Screens: doctor Home (empty and with
  data), appointments (today, upcoming, search with no match, status filter with no match),
  detail, cancel confirmation with a validation error, booking with patient results, the OPD queue,
  a patient record, the loading, failed and refused schedule, the nurse queue, the administrator's
  redacted schedule, the patient portal's appointments, and the open phone menu.
- Automated: axe and overflow checks in `e2e/appointments.spec.ts` and `e2e/doctor-home.spec.ts`
  (Home, schedule, details, the portal, the administrator's view, the failed and refused states),
  and the drawer's focus, Escape, inert and close behaviour.

Not done: Firefox and Safari, real phones or tablets, a screen reader by hand, Windows high
contrast, browser zoom beyond the default, print styles for the new pages, and a dark theme (there
is none).

## 7. What is and is not covered

**Redesigned:** the application shell (all roles), the doctor's Home, the appointment pages and
dialogs (staff and patient portal), the shared controls and states.

**Re-coloured and re-rounded by the tokens, otherwise unchanged:** every other page, including the
queue (which gained the segmented control), the patient record, the consultation, thermal, AI
review, devices and the administrator's pages. They were not audited screen by screen; expect
details (spacing, tables, older alert styles) to be uneven until each slice reaches them.
