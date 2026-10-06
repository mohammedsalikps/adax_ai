# ADAXAI ML Reality Audit

**Scope.** Repository `C:\Users\nihaa\ADAXAI-MVP`, branch `v5-devices`, HEAD `decd538`. The audit ran on 2026-10-06, from about 10:43 to 11:12 IST, against the running dev stack: API on :4000, llama-server on :8081, speech on :8002, thermal on :8001. Host: Intel i5-12450HX (8 cores, 12 threads) and an NVIDIA GeForce RTX 3050 6GB Laptop GPU (driver 581.86).

**Evidence root.** `C:\Users\nihaa\AppData\Local\Temp\claude\C--Users-nihaa-ADAXAI-MVP\b1d895dc-8c6e-4b08-80cb-ddf703936a6f\scratchpad\ml-audit\`, shortened below to `ml-audit/`. **This is a temporary session folder**: copy it somewhere permanent if the raw evidence (scripts, logs, JSON outputs, WAVs, nvidia-smi samples) must be kept.

| Tag | Audit area | Evidence folder |
|---|---|---|
| A | Local LLM runtime (llama.cpp, Qwen3.5-4B) | `ml-audit/area-a-llm/` |
| GH | How the application uses the LLM; rules; Mana | `ml-audit/GH/` |
| B | Speech-to-text | `ml-audit/speech/` |
| CD | Thermal imaging and pediatric shock | `ml-audit/thermal-shock/` |
| EF | Wearable band and smart stethoscope | `ml-audit/E-F-wearable-stethoscope/` |
| SW | Repo-wide sweep: inventory, providers, mocks, claims | `ml-audit/sweep/` |

**Terms used in this report.**
- **REAL ML**: learned weights were loaded and run during this audit, and the input, output and timing were captured.
- **REAL AI**: a product feature that sends data through a REAL ML model end to end through the API.
- **REAL NON-ML PROCESSING**: deterministic code that was run, such as physics, statistics, regular expressions, rules or SQL. This report never calls it ML.
- **SIMULATED / MOCK**: generated data or a test stand-in.
- **MISSING**: neither the code nor the weights exist.
- **UNVERIFIED**: the code or file exists but was not run in this audit.

**Audit ground rules.** No service was started, stopped or restarted, and no hosted service was contacted. No repository file changed: every area recorded `git status` showing only the untracked `.claude/` that was already there. All inputs were synthetic or public samples. No secret was printed; scripts read the keys and the demo password from files.

---

## 1. Executive verdict

ADAXAI runs three learned models, all of them locally. All three are general-purpose models; none is fine-tuned for medicine and none is clinically validated.

1. **Qwen3.5-4B (Q4_K_M GGUF) on llama.cpp b11379, Windows CUDA 12.4 build, on the RTX 3050.**
   - It is the only model behind the V3 consultation draft and Mana V4.
   - A ran it directly 10 times. GH, EF and SW ran it end to end through the API for 3 drafts and 11 Mana questions.
   - GPU execution is proven three ways: CUDA modules are loaded in the process, nvidia-smi lists it as a compute process, and GPU utilisation was 88-100 % during calls.
2. **faster-whisper-small (CTranslate2, int8 weights) on CPU, for speech-to-text.**
   - Whisper language identification runs from the same weights.
   - B sent it 35 requests directly and 5 through the API, and SW ran it once. The GPU stayed at 0 %.
3. **Silero VAD v6 (ONNX, onnxruntime on CPU).** It is bundled inside faster-whisper and runs on every transcription (B, SW).

There is one more piece of learned code: a hand-written numpy logistic-regression baseline inside the thermal dataset-evaluation pipeline. It trains on each request and is then thrown away. In this audit it ran only on a synthetic dataset (CD), and it is never applied to a capture or a patient. It is research code, not a product model.

Everything else the product shows near the word "AI" is deterministic code. That covers:
- thermal decoding, ROI statistics and flags;
- the important-point extractor;
- the safety checks, which are the "recommendations" a user sees;
- the record checks and the draft validator;
- Mana's tools and checks, and the Mana V1 answers;
- the D2 Overview summary and the thermal summary;
- device ingest.

| Area | Status |
|---|---|
| Thermal ML | **NO TRAINED THERMAL ML MODEL VERIFIED.** |
| Pediatric shock ML | **MISSING** |
| Wearable ML | **MISSING**. There is no hardware and no signal analysis; the LLM only reads device numbers as text. |
| Stethoscope ML | **MISSING**. Recordings are stored and played back, never analysed. |
| Hosted Anthropic features (AI note drafting, AI photo description, LLM recommendations, Mana V1 AI summary, hosted reasoner) | Switched off, **UNVERIFIED** |

The main risks before the final demo are about provenance and honesty, not about what the models can do:
- **Unpinned runtime.** The CUDA runtime that actually serves the LLM is not pinned or hash-checked. The model card and the recorded evaluations still describe a CPU-only build on a different GPU (A, SW).
- **Synthetic evidence only.** All accuracy evidence comes from Windows TTS speech and consult and Mana cases written by the authors (B, GH, SW).
- **Safety depends on the code checks.** In a raw run the LLM turned "Allergies: not recorded" into "no known allergies listed". What stands between that and the doctor is the product's code checks, not the model (A).
- **Latency.** Drafts took 23.6-31.3 s in this audit and 36.0-50.3 s in the previous server's log, against the owner's target of about 10 s (GH, EF, A).
- **Misleading demo data.** The dev database holds 584 wearable readings posted by the visual-QA screenshot scripts run against the development database during the D2 and Doctor HERO work (`d2-look.mjs`, `hero-look.mjs`; the record labels carry those runs' tags, e.g. "Band under test muvlwc9h"); the e2e suite uses its own database. They display as unverified device data, not as simulated (SW `db-devices.json`; attribution checked by the integrator).
- **Disk space.** Drive C: reached 0 bytes free during the audit (GH, A, B); after it, 2.17 GB were free (integrator, `Get-PSDrive C`). Postgres lives on C:.

---

## 2. Verified real AI/ML components

All seven components below were run in this audit.

| # | Component | Model and runtime | How it was verified | Classification | Evidence |
|---|---|---|---|---|---|
| R1 | Local LLM inference | Qwen3.5-4B Q4_K_M; llama.cpp b11379 CUDA; RTX 3050 | 3 chat runs, 3 `/completion` runs, 1 JSON-schema run, 1 draft-length run and 1 CPU-time run. All 6 temperature-0 outputs were byte-identical. | REAL ML (research/demo grade) | A: `inference_runs.json`, `sustained_run.json`, `run_cputime.log`; SW: `llm-smoke.json`, `llm-smoke2.json` |
| R2 | V3 consultation draft | R1 through `LocalLlmClient` | 2 drafts (GH) plus 1 draft with device data (EF), end to end through the API. The draft v1 prompt was rebuilt with the app's own code; its SHA-256 equals `ai_runs.input_sha256`. | REAL AI | GH: `04-draft.json`, `13-draft2-with-conflict.json`, `08-reconstruction-run1.json`, `08-draft-request-reconstructed-v1.json`; EF: `results3.json` |
| R3 | Mana V4 planner and answer writer | R1 through `LocalLlmClient` | 10 questions including 4 refusals (GH) and 1 lab question (SW). The writer prompts were re-rendered, and their SHA-256 equals `ai_runs.input_sha256`. | REAL AI | GH: `06-mana-*.json`, `09-mana-answer-request-*.txt`, `10-mana-probes.json`; SW: `mana-probe-17a56354.json` |
| R4 | Speech-to-text | faster-whisper-small; faster-whisper 1.2.1 / CTranslate2 4.8.2; CPU, int8 | 35 service requests, 5 API transcriptions and a reproduction in a separate process. Each clip gave identical text on 3 repeats. | REAL ML; REAL AI through the API | B: `service_results.json`, `service_extra_results.json`, `api_results.json`, `direct_results.json`; SW: `speech-and-vad.json` |
| R5 | Spoken-language identification | Same Whisper weights | Detected `en` with probability 0.9974-0.9981 on speech, and compared against a `language='en'` hint | REAL ML | B: `service_results.json` |
| R6 | Voice activity detection | Silero VAD v6 ONNX; onnxruntime 1.30.0 on CPU | Speech timestamps were captured. The onnxruntime DLLs appear in the service process only after its first request. Silence gives no speech regions. | REAL ML | B: `direct_results.json`; SW: `speech-and-vad.json` |
| R7 | Thermal evaluation baseline | numpy logistic regression (not sklearn); nothing is saved | Trained on a 60-capture synthetic set, both in process and through the running `/evaluate`. Both gave identical results. | REAL ML code, research only, synthetic data only. Not a product model. | CD: `evaluation_synthetic_run.json`, `synthetic_large_report.md` |

**Note on R7.** SW classified it UNVERIFIED because SW did not run it. CD did run it, so the code is verified to execute. Whether it is useful is a separate question (see §13).

---

## 3. Real but non-ML processing

All of these ran in this audit unless the table says otherwise, and all are deterministic. None of them may be called AI or ML.

| Component | Version id | What it does | Evidence |
|---|---|---|---|
| Radiometric decoding | flyr 5.1.0 plus an independent Planck formula | Converts raw sensor counts to °C using each file's own constants. The two methods agree within 5.1e-6 °C on the AX8 sample and 3.0e-5 °C on flir_example. | CD `thermal_processing_run.json`; SW `thermal-extract.json` |
| Whole-image and ROI statistics | `services/thermal/app/roi.py` | min, max, mean and SD; rectangle, ellipse and polygon masks; differences between paired regions | CD `thermal_processing_run.json`, `api_thermal_path.json` |
| Thermal flags | rules-v1 | Hotspot: pixels at or above mean + 2 SD forming an 8-connected area of at least 12 px. Asymmetry: absolute mean difference of at least 1.0 °C. | CD `thermal_processing_run.json` |
| Thermal summary | thermal-summary-v1 | Fixed text templates. Classified from the code only; it was not run in this audit. | CD (code: `apps/api/src/thermal/summary.ts`) |
| Thermal dataset evaluation | thermal-eval-v1 | Label consensus, rule confusion matrix, Wilson 95 % confidence intervals | CD `evaluation_synthetic_run.json` |
| Audio decoding and resampling | `services/speech/app/media.py` | Detects the container type, decodes with PyAV, and resamples to 16 kHz mono float32 | B `direct_results.json` |
| Speech API client | `apps/api/src/ai/stt.ts` | Checks the response with zod, normalises segments, and drops likely non-speech segments (no-speech probability at least 0.9 and confidence below 0.5) | B `api_results.json` |
| V3 input assembly and prompt | `consult/inputs.ts`, `consult/prompt.ts`, `ai/llm/neutralise.ts` | Writes one line per source, scrubs identifiers by pattern, applies a 14,000-character budget, and hashes the context | GH `08-reconstruction-run1.json` |
| Draft validator | consult-checks-v2 | Removes or flags statements, and decides every support state | GH `04-draft.json` |
| Record checks | record-check-v2 | Finds allergy-group conflicts using 3 illustrative drug groups | GH `13-draft2-with-conflict.json` |
| Mana tools and checks | mana-tools-v3, mana-plan-checks-v3, mana-answer-checks-v4 | 11 fixed, parameterised SQL tools; correction of the plan; removal of unsupported answer blocks | GH `06-mana-*.json`, `10-mana-probes.json` |
| Mana V1 answers | mana-record-v3 | Picks an intent with regular expressions, then answers from rule sections | GH `11-legacy-mana-rules.json` |
| D2 consultation context | context-conflicts-v2, multimodal-summary-v2 | Evidence list, conflicts, "missing" lines and the Overview text | GH `12-consultation-context.json` |
| Important points | extract-rules-v1 with record-compare-v1 | Extracts points from typed transcripts with regular expressions and word lists (41 ms) | GH `15-rules-steps.json`, `16-encounter-ai-runs.json` |
| Safety checks, shown as "recommendations" | safety-rules-v1 | Allergy groups, missing allergy status, adult vital ranges, red-flag phrases | GH `15-rules-steps.json` |
| Egress policy and loopback guard | `ai/providers.ts`, `ai/llm/local.ts` | Builds the hosted clients only if egress is on and a key is set; the LLM URL must be a loopback address | GH `01-ai-status.json`; SW `status-probe.json` |
| Advisory boundary | `ai/review.ts`, `encounters/insertions.ts` | Accepting an AI item changes nothing in the note; only an explicit insertion writes note text | GH `05-encounter-after-draft.json`, `14-review-and-insert.json` |
| Device gateway | `apps/api/src/devices/*` | Token-authenticated ingest, a gate on which reading kinds each device may send, time windows, reading states and adult reference-range flags | EF `exercise.log`, `results.json`, `results2.json` |
| Auscultation storage and playback | `devices/routes.ts`, `files/storage.ts` | Checks magic bytes, stores the bytes unchanged, plays them back byte-identical | EF `probe_playback.log`, `results.json` |
| LLM launcher and lock files | `scripts/llm.mjs`, `services/llm/*.lock.json` | Checks the model's hash; only checks that the runtime files exist | A `npm_llm_status.log`, `npm_llm_verify.log`, `llm_dev_dry_run.json` |

---

## 4. Simulator/demo components

| Component | What it is | Safeguards observed | Evidence |
|---|---|---|---|
| device-sim-v1 (`apps/api/src/devices/simulator.ts`) | Vitals from a seeded random generator, with scenarios steady, rising_heart_rate, low_spo2, fever, no_readings and dropout. `simulatedToneWav` makes two decaying sine bursts (62 Hz and 88 Hz) sampled at 4000 Hz. | Readings are stored with `validationStatus 'simulated'` and no flags. A simulated SpO2 of 89 did not reach the LLM draft. | EF `results.json`, `results2.json`, `results3.json` |
| thermal-sim-v1 (`packages/contracts/src/thermalSim.ts`) | Seeded 160x120 warm oval with four cases | Uploads that claim `captureSource=simulator` are refused. The simulate route is gated by `simulatorAllowed`. The 13 simulated captures are left out of data counts. | CD `sim_check.json`, `api_thermal_path.json` |
| e2e mocks | `e2e/mock-llm.mjs` (`mock-llm-e2e`); `e2e/mock-speech.mjs` (`mock-speech-e2e`, a hash of 64 zeros, a fixed 5-line script); `e2e/mock-anthropic.mjs`; vitest fakes | Only `playwright.config.ts` starts them. The running dev API reports the real models, not the mock ids. | SW `status-probe.json`; A `api_ai_status.log`; B `api_results.json` |
| "Band under test" records in the dev DB | 8 `wearable_band` records with `integration gateway_api`, holding 584 readings posted by the visual-QA screenshot scripts run against the development database during the D2 and Doctor HERO work (`d2-look.mjs`, `hero-look.mjs`; the record labels carry those runs' tags, e.g. "Band under test muvlwc9h"); the e2e suite uses its own database | None. They are stored as `device_unverified`, so the UI will show them as unverified device values, not as SIMULATED. | SW `db-devices.json` |
| Pediatric shock research view | A static literature panel and pipeline stages hard-coded `not_built` | Disclaimer: "Nothing here detects, predicts or scores shock." | CD; SW |
| Public thermal samples | A FLIR AX8 image and an older FLIR file (MIT licence, from nationaldronesau/FlirImageExtractor) | Marked `dataOrigin=public_sample` by their hash | CD `api_thermal_path.json` |

Most of the Playwright tests that check AI behaviour run against the mocks. Only the opt-in `e2e/consult-real.spec.ts`, `e2e/mana-real.spec.ts` and `e2e/capture-real.spec.ts` use the real models (A, B, SW).

---

## 5. Missing ML components

| Missing component | Evidence that it is absent |
|---|---|
| Any trained thermal model (segmentation, classification or detection) | CD artifact sweep (`artifact_sweep_novenv.txt`, `artifact_sweep_venv.txt`). `/model/status` is hard-coded to `available:false`. The `ThermalModel` interface (`apps/api/src/thermal/client.ts:88`) has no implementation. The thermal venv has no sklearn, torch or onnxruntime (`thermal_pip_list.txt`). |
| Pediatric shock detection or prediction (centre-to-periphery gradient, perfusion, capillary refill, SIPA, random forest, LSTM) | CD `shock_grep.txt`; ADR 0022 says none exists |
| Heart or lung sound analysis (murmur, wheeze or crackle detection; MFCC or spectrogram features) | EF grep; the `NOT_ANALYSED` constant in `apps/api/src/consultation-context/summary.ts:30` |
| Wearable signal analytics: BP (cuff or cuffless), arrhythmia/AFib, HRV, ECG, PPG, sleep, steps, anomaly or early-warning models | EF grep; the gate refuses BP with 422 |
| Speaker diarization | B: the speech service's `/health` declares `notCapable: speaker_identification` |
| GPU speech path | B: `services/speech/app/engine.py:127` hard-codes `device="cpu"` |
| Local vision model (for AI photo description) | A: no mmproj downloaded, and `/props` shows vision:false. GH: the hosted describer is off. SW: `image_analyses` has 0 rows. |
| Embeddings or retrieval (RAG) | GH: Mana uses fixed SQL tools only |
| Medical fine-tuning of any model, or any evaluation on real patient data | A, B, GH, SW: every evaluation is synthetic |
| Pain detection or pain score | SW |

Some missing pieces are not ML, but they block related claims:
- wearable and stethoscope hardware integration (EF, SW);
- live FLIR ONE capture, because the Android bridge was never compiled (CD, SW);
- a laboratory feed or a "pending" lab state (SW);
- paediatric vital ranges (CD).

---

## 6. Model artifact inventory

Paths are relative to `C:\Users\nihaa\ADAXAI-MVP`.

| Name | Type | Path | Size (bytes) | SHA-256 | Version | Licence (and where the claim comes from) |
|---|---|---|---|---|---|---|
| Qwen3.5-4B-Q4_K_M.gguf | LLM weights: GGUF v3, architecture qwen35, 4,205,751,296 parameters, Q4_K_M mixed quantisation | `.data/llm-gpu/cuda/models/Qwen3.5-4B-Q4_K_M.gguf`. The same file is hard-linked at `.data/llm/models/` (inode 1407374884169688, 2 links). | 2,740,937,888 | `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4` | `unsloth/Qwen3.5-4B-GGUF` revision `e87f176479d0855a907a41277aca2f8ee7a09523`; base model `Qwen/Qwen3.5-4B`; quantised by Unsloth with an importance matrix | Apache-2.0, stated only in the GGUF metadata and `services/llm/models.lock.json`. There is no licence or model-card file on disk. |
| faster-whisper-small `model.bin` | CTranslate2 Whisper small; 80 mel bins, 99 languages | `.data/models/faster-whisper-small/model.bin` | 483,546,902 | `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671` | `Systran/faster-whisper-small` revision `536b0662742c02347bc0e980a01041f333bce120` | MIT, stated only in `services/speech/models.lock.json`. The model card was not fetched. |
| faster-whisper-small `config.json` | Model configuration | `.data/models/faster-whisper-small/config.json` | 2,370 | `b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828` | same | same |
| faster-whisper-small `tokenizer.json` | Tokenizer | `.data/models/faster-whisper-small/tokenizer.json` | 2,203,239 | `fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab` | same | same |
| faster-whisper-small `vocabulary.txt` | Vocabulary | `.data/models/faster-whisper-small/vocabulary.txt` | 459,861 | `34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913` | same | same |
| `silero_vad_v6.onnx` | Voice activity detection, ONNX | `services/speech/.venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx` | 1,245,151 | `4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2` | Silero VAD v6 as shipped in faster-whisper 1.2.1. Pinned only indirectly, through `faster-whisper==1.2.1`. | Not recorded in the repo. faster-whisper itself is MIT; the upstream Silero licence was not checked. |
| Thermal logistic-regression baseline | numpy logistic regression with 4 features | None: it is trained and discarded on each `/evaluate` call | n/a | n/a | thermal-eval-v1 | Project code |
| Any thermal model | None | None | None | None | None | NO TRAINED THERMAL ML MODEL VERIFIED |

**Who hashed what.**
- A hashed the GGUF and the CPU runtime zip itself (`area-a-llm/hashes.json`), and EF hashed the GGUF again.
- B (`speech/hashes.txt`) and CD (`thermal-shock/artifact_hashes.json`) hashed the Whisper files and the VAD file.
- Every value matches its lock file wherever a lock entry exists.

**Files that no application code loads** (SW `inventory.txt`, CD `artifact_sweep_venv.txt`). None of these is an ADAXAI model:
- onnxruntime package test files: `logreg_iris.onnx` (670 B, SHA-256 starting `8224784c`), `mul_1.onnx` (130 B, `71f431c4`) and `sigmoid.onnx` (103 B, `5340aba6`);
- numpy test files `astype_copy.pkl` and `py2/py3-objarr.npz`, in both venvs.

---

## 7. Runtime inventory

| Runtime | Version | Device / backend | Used by | Pinned and verified? | Licence evidence | Evidence |
|---|---|---|---|---|---|---|
| llama.cpp llama-server, running as PID 25980 on 127.0.0.1:8081 | b11379; the server reports build_info `b11379-1537a0a8b` | Windows x64 CUDA 12.4 build: `ggml-cuda.dll` plus the CUDA 12 runtime; `ggml-cpu-alderlake.dll` for host ops; n_threads 8 | V3 drafts, Mana V4 | **No.** `services/llm/runtime.lock.json` pins only the CPU zip, and the two CUDA zips (below) have no lock entry. The extracted files equal the zip entries byte for byte, which proves internal consistency only, not where they came from. `scripts/llm.mjs` never re-hashes the binaries. | MIT according to the lock JSON. There is no llama.cpp LICENSE file in the runtime folder; the zip contains only `LICENSE-LLVM-OpenMP`. There is no NVIDIA EULA or notice next to the cudart and cublas DLLs. | A `hashes.json`, `zip_vs_extracted.json`, `probe_endpoints.json` |
| llama.cpp CPU build (`.data/llm/runtime/b11379`), used when `LLM_DIR` is unset | b11379 | CPU backends | Not running | Yes. The zip matches the lock: 19,352,297 B, `ec014c2c2a27b18786d24eba3e8650d4e68b9003ca6cf91714125b71975eb7ea`, and all 51 extracted files match the zip. | MIT according to the lock | A. Not run, so UNVERIFIED at runtime. |
| faster-whisper / CTranslate2, speech service PID 4068 on 127.0.0.1:8002 | 1.2.1 / 4.8.2, with Python 3.12.10, PyAV 16.0.1, numpy 2.5.3 | CPU. int8 is requested; the effective type is `int8_float32`. About 4 intra-op threads, inferred from CPU load, not read. | STT, language ID | The model hash is checked against the lock at load (`engine.py:178-196`). Packages are pinned by `requirements.txt`. | MIT according to the package metadata | B |
| onnxruntime | 1.30.0 | `CPUExecutionProvider` only | Silero VAD | Through `faster-whisper==1.2.1` | Not recorded | B, SW |
| Thermal service, PID 30164 on 127.0.0.1:8001 | Python 3.12.10, numpy 2.5.3, flyr 5.1.0, opencv-python-headless 5.0.0.93, pillow 12.3.0, fastapi 0.142.2, uvicorn 0.54.0 | CPU. OpenCV reports 0 CUDA devices. | Decoding, statistics, flags, evaluation, the LR baseline | `requirements.txt` | flyr is EUPL-1.2, a copyleft licence that `requirements.txt` flags for legal review. OpenCV is Apache-2.0. | CD `thermal_pip_list.txt` |
| API, PID 28828 on 127.0.0.1:4000 | Node v24.19.0 (tsx), Fastify 5.12.5, drizzle-orm 0.45.3, pg 8.23.1, zod 4.6.5, embedded PostgreSQL 17 | CPU | All rules, the device gateway, orchestration | npm lock file | not checked | EF, GH |
| @anthropic-ai/sdk | 0.131.0 | Hosted, over HTTPS | Hosted providers only | not checked | not checked | SW. **Not constructed**: egress is off and `ANTHROPIC_API_KEY` is empty. |

**CUDA runtime files actually loaded by the running llama-server** (folder `.data/llm-gpu/cuda/runtime/b11379/`; hashes from A `hashes.json`):

| File | Size (bytes) | SHA-256 | Note |
|---|---|---|---|
| `llama-server.exe` | 9,216 | `1521dafa86ac7032f6521573de7c99dc17751273662e5017c73026a3964447a5` | Launcher stub, byte-identical to the CPU build's |
| `llama-server-impl.dll` | 9,137,152 | `88c4fc7cf1f024f9bfe61176b3d8916bf29febd6ceb2a93284a5ba0ebc8cc08b` | Server code, byte-identical to the CPU build's |
| `ggml-cuda.dll` | 568,677,376 | `4d055e0d2e8b38553e7cc4cf7e43e4de287d83016469a785b0eec5e87c8a33c1` | The CUDA backend |
| `cudart64_12.dll` | not recorded | `d28e42265da7462162a54da6b7a99ea4fa2caf8139d862bb500db875d0b32dfc` | NVIDIA runtime |
| `cublas64_12.dll` | 100,033,536 | `e40202fe4223c1cd2d2dce7beec59e1ed61c7801bd827309183be9b50e358f4c` | NVIDIA cuBLAS |
| `cublasLt64_12.dll` | 473,551,360 | `2a896460bef60ed57ef32b0875812f355a6984e671d638bb632f5e8c1d7a831f` | NVIDIA cuBLASLt |
| `llama.dll` | not recorded | `096d3fc04bcf43314700401a737cb42990da5a461f1bbc58c31b01ae18df37be` | |
| `ggml-base.dll` | not recorded | `c89f456f13be462034429854fb2ee62cc8547afdbaa168a61426d394a9ef2245` | |
| Source: `llama-b11379-bin-win-cuda-12.4-x64.zip` | 263,794,565 | `b4f0870dad35f3c2065a3dcf44f6c0c8121cc3658bb951d8505203d8e0c1ab15` | Not in any lock file |
| Source: `cudart-llama-bin-win-cuda-12.4-x64.zip` | 391,443,627 | `8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6` | Not in any lock file |

**Exact LLM launch line**, taken by A from the running process. The key is passed in the `LLAMA_API_KEY` environment variable, not on the command line:

```
llama-server.exe --model <repo>\.data\llm-gpu\cuda\models\Qwen3.5-4B-Q4_K_M.gguf --alias qwen3.5-4b-q4_k_m --host 127.0.0.1 --port 8081 --ctx-size 8192 --parallel 1 --no-cache-prompt --cache-ram 0 --no-cache-idle-slots --ctx-checkpoints 0 --offline --no-webui --no-slots --cors-origins http://adaxai-no-browser.invalid --jinja --reasoning off
```

The line passes no `--n-gpu-layers`, `--flash-attn` or `--threads`. The CUDA build is used only because the git-ignored `.env` sets `LLM_DIR=.data/llm-gpu/cuda`.

---

## 8. Exact inference entry points

### LLM (Qwen3.5-4B through llama-server)

**Server endpoints** (A `probe_endpoints.json`):
- `POST /v1/chat/completions`, `POST /completion` and `POST /apply-template` were all exercised.
- `GET /health` is public.
- `GET /v1/models` and `GET /props` need the bearer key and return 401 without it.
- `GET /slots` and `GET /metrics` return 501 because they are disabled.

**API client** (`apps/api/src/ai/llm/local.ts`):
- `LocalLlmClient.generate()` sends temperature 0 and a strict json_schema `response_format`.
- `.health()` checks the server.
- `.info()` (local.ts:104-109) copies the pinned weights hash by alias name.
- `llmUrlProblem` (local.ts:14-25) refuses non-loopback URLs.

**Construction.** `apps/api/src/ai/providers.ts` `providersFromConfig` (:223-277) is called once in `buildApp` (`apps/api/src/app.ts:114`). Drafts and Mana share one `Gate` with 1 slot and at most 3 waiting (`app.ts:120`).

**V3 draft call path.**
1. `POST /api/encounters/:id/consultation-ai/drafts`
2. `consult/routes.ts:44`
3. `ConsultationService.request` (`consult/service.ts:262`)
4. `run()` (:348)
5. `model.generate` (:370)
6. `validateDraft` (:371)
7. persist (:376-390)

The client then polls `GET /api/consultation-ai/drafts/:id`.

**Mana V4 call path.**
1. `POST /api/mana-assistant/conversations/:id/messages`
2. `ManaAssistantService.ask` (`mana/assistant/service.ts:275`)
3. `run()` (:484)
4. planner call (:539)
5. `validatePlan` (`plan.ts:220`)
6. `runTool` (`tools.ts:607`)
7. writer call (:642)
8. `checkAnswer` (`answer.ts:496`)

**Other callers.**
- Evaluation harness: `apps/api/src/eval/consult.ts:228`.
- Launcher: `node scripts/llm.mjs dev` (`npm run dev:llm`).

### Speech-to-text and language ID (faster-whisper-small)

**Service.** `POST http://127.0.0.1:8002/v1/transcribe` takes a multipart `file` and an optional `language`. It requires the header `x-adaxai-local: 1` and a loopback Host. `GET /health` reports status.

**Service call path.**
1. `services/speech/app/main.py:transcribe`
2. `run_in_threadpool(Engine.transcribe)` (`engine.py:226`)
3. `media.decode_bounded` (`media.py:79`)
4. `WhisperModel.transcribe` (`engine.py:236-245`), with `task='transcribe'`, `beam_size=5`, `vad_filter=True`, `min_silence_duration_ms=500` and `condition_on_previous_text=False`, under a single lock.

The model is built at `engine.py:127` with `device="cpu"`.

**API side.**
- `apps/api/src/ai/stt.ts` `LocalSpeechTranscriber.transcribe()` is built at `providers.ts:235`.
- It is called by the transcription job in `apps/api/src/ai/routes.ts:322-377` (`t.transcribe` at :350).
- That job is started by `POST /api/encounters/:id/audio` (:696), `POST /api/encounters/:id/live-transcripts` (:732) and `POST /api/transcripts/:id/chunks` (:770).
- In the browser, `apps/web/src/components/capture/Recorder.tsx:233-253` starts a new MediaRecorder for each part of about 20 s.

**Offline evaluation CLI:** `apps/api/src/eval/stt.ts`.

### Voice activity detection (Silero v6)

Reached only indirectly: `faster_whisper/vad.py` `get_vad_model()` (:289) builds the session (:295-312), and it runs whenever `vad_filter=True` is passed.

### Thermal logistic-regression baseline

- `services/thermal/app/evaluate.py` `model_metrics` calls `fit_logistic`.
- It is reached only through `POST http://127.0.0.1:8001/evaluate` (`main.py:107`), `python -m app.evaluate dataset.zip`, or `POST /api/thermal-data/exports/:id/evaluate` (`apps/api/src/thermal/datasets.ts:267`).
- There is no entry point that runs a model on a single capture: `GET /model/status` (`services/thermal/app/model.py`) is hard-coded to `available:false`.

### Hosted providers (off, UNVERIFIED)

`apps/api/src/ai/anthropic.ts` `createAnthropicProviders` (:202-212). It is built only when `settings.ai.egress.hostedProviders` is true and `ANTHROPIC_API_KEY` is set (`providers.ts:227`).

---

## 9. Real inference evidence

### R1: the LLM called directly (A, `area-a-llm/inference_runs.json`)

**Input.**
- System message: "You are a clinical documentation assistant for a doctor. Use only the record provided. Do not diagnose, do not prescribe, do not give doses."
- User message: a fictional record (age band 40-49, female, fever and sore throat for 3 days, 38.4 C, HR 96, allergies not recorded, no medicines) asking for at most 3 missing-information bullets.

**Output excerpt:**
- "Specific details on the nature of the sore throat (e.g., presence of white patches, difficulty swallowing, or neck stiffness)…"
- "History of recent antibiotic use or exposure to other sick contacts…"

**What was run.**
- 3 calls to `/v1/chat/completions` and 3 to `/completion`, at temperature 0, with 150 prompt and 85 completion tokens.
- All 6 outputs were byte-identical: SHA-256 `dd7b534cd663c641fc360ba94aee97e9f935f91dce9b80e9f670e1023a9e9815`.
- A call shaped like the product's (strict json_schema) returned 168 tokens of valid JSON.
- A 481-token draft-length run and a 400-token CPU-time run also completed.

**Quality observations.** These come from the raw model, without the product's prompt or checks:
- The missing-information list never named allergy status.
- The long answer said the patient "has no known allergies listed in her profile" when the input said "Allergies: not recorded".
- It framed the illness as "viral or bacterial", which is diagnostic framing.

**SW smoke test** (`sweep/llm-smoke.json`). Input: "a patient named Synthetic Test reports a dry cough for three days. Restate the complaint…". Output: "The patient reports a dry cough that has persisted for three days." (49 prompt and 14 completion tokens).

### R2: the V3 draft through the API (GH)

**Input.**
- Synthetic patient ADX-001041: penicillin allergy (rash, moderate), amlodipine 5 mg once daily, T 37.1, HR 88, BP 164/98, SpO2 97, and a typed history of headache and dizziness.
- GH rebuilt the user message (10 sources) with the application's own code. Its SHA-256 `b3c30328367521448ce8e7c98edb8501334b87d55e2c04fe7590c1c4d2ca1927` equals `ai_runs.input_sha256` (`08-reconstruction-run1.json`).

**Draft v1 output** (`04-draft.json`).
- 16 statements were produced and 15 kept. One was removed for containing a dose or regimen, and 2 were flagged. The draft status is `partial`.
- Excerpts, with the support state that the code assigned:
  - "Systolic BP 164 mmHg." [V3]: supported.
  - "Penicillin (reaction: Rash), severity moderate." [A1]: supported.
  - "Consider the impact of missed amlodipine doses on the patient's headache and dizziness." cited C2 and A1: inferred.
- 1,159 input and 1,138 output tokens.

**Draft v2** (`13-draft2-with-conflict.json`). It was made after the doctor typed amoxicillin 500 mg three times daily into the prescription.
- record-check-v2 found the penicillin-group conflict, and the code set 4 statements to `conflicting`.
- The model itself wrote "Consider the prescribed amoxicillin in light of the recorded penicillin allergy."

**Advisory boundary** (`05-encounter-after-draft.json`, `14-review-and-insert.json`).
- Making drafts and accepting an item left the encounter version, note, diagnoses and prescription unchanged.
- Only an explicit insertion changed the note text.

**Draft with device data** (EF, `E-F-wearable-stethoscope/results3.json`).
- The observations included "Heart rate 121 bpm, device reading (device unverified), this visit" [V1].
- One `potential_considerations` item was wrong: "Consider the variation in heart rate readings (118 bpm, 119 bpm, 121 bpm)… recorded during this visit". The 118 and 119 readings were not from this visit.
- The simulated SpO2 of 89 did not appear, and the stethoscope recording was not mentioned.

### R3: Mana V4 (GH `06-mana-*.json`, `10-mana-probes.json`; SW)

- **"What allergies does this patient have?"** The planner chose `get_patient_record(current, allergies)`. Answer: "The patient has an allergy to Penicillin with a reaction of Rash and moderate severity." [S1].
- **"Which patients are waiting today?"** The planner chose `get_today_queue(status waiting)`, and the code corrected `mine=true` to false. The answer reported 23 visits but did not say that 0 were waiting, and it dropped "1 cancelled". The checks passed it.
- **"What should I consider for this patient's blood pressure today?"** Mana restated 164/98 only and gave no advice.
- **"What medicines is this patient on?"** Mana answered with the drafted amoxicillin only and left out the recorded amlodipine. This is a rule gap (§18).
- **Refusals.** The planner LLM made these decisions, and no tool was run for any of them:
  - a request to prescribe and sign: `write_request`;
  - a request for the audit log: `out_of_scope`;
  - a general dose question: `general_knowledge`;
  - an SQL-injection text: `out_of_scope`.
- **SW lab question** ("Which lab results are still pending…?"). The planner chose only `get_today_queue`, and the outcome was `not_established` with 0 answer blocks (`sweep/mana-probe-17a56354.json`).

### R4 and R5: speech (B `speech/service_results.json`, `api_results.json`; SW `speech-and-vad.json`)

The inputs are Windows System.Speech TTS clips that the auditor wrote. No person was recorded. Raw word error rate (WER) counts edits after lower-casing and removing punctuation.

| Clip | Reference | Transcript | Raw WER | Note |
|---|---|---|---|---|
| tts1, 3.239 s | "I have had a fever and a cough for three days." | identical | 0/11 | en, probability 0.9981 |
| tts2, 4.024 s | "The pain is in my lower back and it gets worse when I bend down." | identical | 0/15 | en, probability 0.9975 |
| tts3, 5.139 s | "…metformin five hundred milligrams twice a day…" | "I take metformin 500 mg twice a day for my diabetes." | 3/12 | Every edit is number or unit formatting |
| tts_long, 20.586 s | 53-word paragraph | "The patient is a synthetic 42-year-old woman. … Her temperature today is 38.2 degrees. …" | 6/53 | Every edit is numeral formatting; the WebM/Opus copy gave the same text |
| SW clip, 7.885 s | "This is a synthetic test. I have had a dry cough for three days and a mild fever. No chest pain." | three segments, identical text | 0 | Language hint en |
| 3 s silence; 3 s low noise | none | no segments | n/a | Still reports `en` with probability 0.3326 |

Each clip gave identical text on 3 repeats. Through the API, uploads and live chunks returned the same text, and 5 speech runs were recorded with model `faster-whisper-small`, runtime `faster-whisper 1.2.1 / ctranslate2 4.8.2` and weights hash `3e3059…`.

### R6: voice activity detection

- **B** (`direct_results.json`):
  - Speech regions [0, 46336], [0, 58112] and [0, 77056] samples at 16 kHz for tts1, tts2 and tts3.
  - Audio left after VAD: 2.896, 3.632 and 4.816 s, against clip lengths of 3.239, 4.024 and 5.139 s.
- **SW**: on an 11.88 s clip padded with silence, the speech regions were 1.74-3.95 s, 4.02-7.70 s and 7.79-9.49 s. On 5 s of silence there were none.

### R7: thermal logistic-regression baseline (CD `evaluation_synthetic_run.json`)

**What was run.** 60 synthetic captures from 30 subjects, built exactly as `services/thermal/tests/test_evaluate.py` builds them.

**Results.**
- Status `trained`, AUC 0.9989, sensitivity 0.9667 (29/30), specificity 0.9667 (29/30).
- Full fit: standardised weights [1.3562, 1.3562, 1.3562, 0.0], bias 0.2919.
- The input [2.0, 2.0, 1.0, 0] gives probability 0.9903; [0.419, 0.419, 0.21, 0] gives 0.0485.

**Why these numbers mean little.** In this generator three features are collinear and the fourth is constant, so the "model" is a threshold on the generated difference.

**Other checks.**
- The 7-capture set was `skipped: Insufficient labelled data`.
- After training, no file changed under `services/thermal` or `.data`, and `/model/status` still reported `available:false`.

---

## 10. GPU/CPU evidence

### Qwen3.5-4B (llama-server, PID 25980): runs on the GPU (CUDA, RTX 3050)

**Positive evidence.**
- **Loaded modules:** `ggml-cuda.dll`, `cudart64_12`, `cublas64_12`, `cublasLt64_12` and `nvcuda.dll`.
- **nvidia-smi:** lists it as a compute process.
- **Dedicated GPU memory:** 3,084.8-3,088.8 MiB (WDDM per-process counter); every other process used under 8 MiB.
- **Utilisation:**
  - During an 11 s generation: 94-96 %, performance state P0, 59.8-67.9 W, SM clock 1650-1755 MHz.
  - Idle before it: 0 %, P8, 3.6-5.9 W.
  - During product drafts: 95-100 % at 60-71 W (GH), and 93-100 % for the whole 24 s draft window (EF).
- **Host CPU:** 8,828 ms of CPU time over 9,273.5 ms wall, a ratio of 0.95, which means one busy host thread.
- **Throughput:** about 45 tokens/s, against the 8-10 tokens/s recorded for the CPU build.

**Caveats.**
- `n_gpu_layers`, the flash-attention state and the KV-cache type are not reported anywhere, so full offload is inferred, not stated.
- The WDDM per-process 3D engine counter read 0 during CUDA work, so it was not used as evidence.
- Several auditors shared the GPU (EF saw 91-96 % while making no model calls), so attributing a sample to a run rests on matching time windows.

**Evidence:** A `sustained_nvidia_smi.csv`, `sustained_gpu_process_counters.csv`, `run_cputime.log`; GH `07-gpu-samples.csv`; EF `nvidia_smi_during_run.csv`; SW `smi-during-llm2.csv`, `smi-during-mana.csv`.

### faster-whisper-small (speech service, PID 4068): runs on the CPU

**Positive evidence.**
- `engine.py:127` sets `device="cpu"`.
- CTranslate2 reports `model.device == 'cpu'` with compute type `int8_float32`.
- The service used 13.2-14.0 CPU-seconds per 3-5 s clip, about 3.1-3.8 cores.

**Negative evidence.**
- GPU utilisation never rose above 0 % over all 35 requests (sampled every 100 ms), and GPU memory stayed flat at the llama-server baseline.
- The speech processes have no GPU Engine counters.
- No `nvcuda`, `cudart` or `cublas` is loaded. `cudnn64_9.dll` is loaded only because `ctranslate2.dll` depends on it at load time.
- SW saw 0 % in 19 of 19 samples.

**Caveat.** The `device` field in `/health` is a hard-coded string, not a runtime reading.

**Evidence:** B `service_results.json`; SW `smi-during-speech.csv`.

### Silero VAD: runs on the CPU

`session.get_providers()` returned `['CPUExecutionProvider']` (SW `speech-and-vad.json`; B).

### Thermal decoding, statistics, flags and the LR baseline: run on the CPU

- They run as numpy and OpenCV code inside the thermal service.
- `cv2.cuda.getCudaEnabledDeviceCount()` returned 0.
- The thermal process (PID 30164) never appeared among nvidia-smi compute apps.
- GPU utilisation was 0 % during processing, but that rests on only 3 samples covering under 1 s.

**Evidence:** CD `gpu_during_processing.csv`, `gpu_compute_apps_before.csv`, `gpu_compute_apps_after.csv`.

### Device gateway and auscultation: CPU, no model

The `devices/*` code imports no AI provider. GPU samples are meaningless for this path because other auditors were using the GPU at the same time (EF).

---

## 11. Latency measurements

All figures are wall-clock times on this machine during the audit. Each is a single run unless a range is given.

| Operation | Size | Latency | Throughput / RTF | Source |
|---|---|---|---|---|
| LLM chat, direct | 150 prompt / 85 generated tokens | 1,976.9-2,208.1 ms (3 runs) | Generation 45.54-45.84 tok/s. Prompt 1,347-1,353 tok/s, but 466 tok/s on the first request after idle. | A `inference_runs.json` |
| LLM `/completion`, direct | 150 / 85 | 1,967.8-1,986.6 ms (3 runs) | Generation 45.49-45.58 tok/s | A |
| LLM with json_schema (grammar) | 168 generated | 4,896.1 ms | 35.71 tok/s | A |
| LLM sustained run | 203 / 481 | 11,122 ms | Generation 45.21 tok/s; prompt 458.5 tok/s | A `sustained_run.json` |
| LLM 400-token run | 400 generated | 9,273.5 ms | 45.37 tok/s | A `run_cputime.log` |
| LLM short smoke tests | 49 / 14, and 135 generated | 756 ms; 3,245 ms | 42.6 and 45.7 tok/s | SW `llm-smoke.json`, `llm-smoke2.json` |
| LLM model load at server start | n/a | about 4.4 s | n/a | A (server log) |
| V3 draft v1, end to end | 1,159 in / 1,138 out | 26.8 s (gate wait 22 ms) | About 42 output tok/s, including the prompt | GH `04-draft.json` |
| V3 draft v2, end to end | 1,219 / 1,102 | 31.3 s: 5.57 s queued behind one Mana question, then 25.7 s in the model | n/a | GH `13-draft2-with-conflict.json` |
| V3 draft with device data | n/a | 23.6 s server; 24.6 s client | n/a | EF `results3.json` |
| V3 product drafts from the previous server instance (historical log, not run in this audit) | 1,685-1,815 prompt / 1,509-2,158 generated | 36.0-50.3 s | 43.5-44.3 tok/s | A |
| Draft request acknowledged (202) | n/a | 68 ms (GH); 141 ms (EF) | n/a | GH, EF |
| Draft validator and persistence | n/a | about 30 ms | n/a | GH |
| Mana planner, tool plan | 90-110 output tokens | 3.5-3.8 s | n/a | GH |
| Mana planner, refusal | 24-26 output tokens | 1.8-2.2 s | n/a | GH |
| Mana writer | 58-122 output tokens | 1.7-3.2 s | n/a | GH |
| Mana whole question | n/a | 3.3-6.3 s (GH); 7.8 s (SW lab question) | n/a | GH; SW |
| Mana tools (SQL) | n/a | 3-85 ms | n/a | GH |
| STT service, language auto-detected | 3.239 s clip | 3.91-4.26 s | RTF 1.21-1.32 | B `service_results.json` |
| STT service, language auto-detected | 4.024 s | 3.63-3.74 s | RTF 0.90-0.93 | B |
| STT service, language auto-detected | 5.139 s | 3.53-3.73 s | RTF 0.69-0.73 | B |
| STT service, language auto-detected | 20.586 s, WAV / WebM | 5.11-5.32 s / 5.01-5.55 s | RTF 0.24-0.27 | B |
| STT service, with `language='en'` hint | 3.239 s | 1.81 s | RTF 0.56 | B `service_extra_results.json` |
| STT service, with hint | 7.885 s | 2.481 s | RTF 0.31 | SW `speech-and-vad.json` |
| STT on silence or noise | 3 s | 1.71-1.74 s | n/a | B |
| STT through the API, upload | 3-5 s clips | 3.81-4.33 s | n/a | B `api_results.json` |
| STT through the API, live chunk | 3.2 s / 20.6 s | 4.13 s / 5.69 s | n/a | B |
| VAD | 3-5 s clips; 11.88 s clip | 7-11 ms; 19.6 ms | n/a | B; SW |
| Audio decoding and resampling | 3-5 s | 16-17 ms | n/a | B |
| Thermal `/extract`, median of 5 | AX8 (80x60); flir_example (240x320) | 26.1 ms; 46.5 ms (SW's single call: 103 ms) | n/a | CD; SW |
| Thermal `/roi-stats` and `/flags`, median of 5 | AX8; flir_example | 12.8 and 12.8 ms; 22.8 and 23.6 ms | n/a | CD |
| Thermal upload through the API | AX8 | 80.2 ms | n/a | CD `api_thermal_path.json` |
| Thermal LR full fit | n = 60 | 47.1 ms; the whole evaluation took 236-252 ms | n/a | CD |
| Device ingest batch | 4 readings | 26.2-50.7 ms | n/a | EF `exercise.log` |
| `GET /api/ai/status` | n/a | 17 ms | n/a | A `api_ai_status.log` |

RTF (real-time factor) is latency divided by audio length; above 1 means slower than real time.

The owner's target for "Analyze with Mana" is about 10 s. Every draft measured in this audit (23.6-31.3 s, on smaller synthetic records) and every product draft in the historical server log (36.0-50.3 s) misses it. The 36.9 / 39.8 / 43.0 s in `docs/STATUS.md` were measured earlier the same day, before this audit, with the same model and runtime: browser click to result on a fuller synthetic consultation (a streaming band, a recording, an approved thermal image), server latency 36.2 / 39.0 / 40.2 s, about 1,500-1,700 generated tokens at 43.7 tok/s (evidence: `scratchpad/hero-shots/timings.json` and that run's llama-server timing lines). They were not re-run in this audit. Draft time grows with the size of the record, because almost all of it is generation.

---

## 12. Reproducibility commands

**Environment for every command.**
- Git Bash, with `export PATH="/c/Program Files/nodejs:$PATH"` and `cd /c/Users/nihaa/ADAXAI-MVP`.
- `S=/c/Users/nihaa/AppData/Local/Temp/claude/C--Users-nihaa-ADAXAI-MVP/b1d895dc-8c6e-4b08-80cb-ddf703936a6f/scratchpad/ml-audit`.
- The scripts read the LLM key (via `LLM_API_KEY_FILE`) and the demo password (`SEED_DEMO_PASSWORD`) from `.env` with `process.loadEnvFile`, and never print them.
- The stack must already be running: `npm run dev`, or `npm run dev:llm` and `npm run dev:speech` plus the API and the thermal service.

**Commands that write to the dev database** (marked `# WRITES` below): `GH/e2e.mjs` (and probably `GH/probe.mjs` and `probe2.mjs`, which GH used to post a transcript, request recommendations and insert note text), `speech/run_api.mjs`, `thermal-shock/api_thermal_path.mjs`, `E-F-wearable-stethoscope/exercise*.mjs` and `sweep/mana-lab-probe.mjs`.

```bash
# Local LLM (A): read-only against llama-server
node $S/area-a-llm/run_inference.mjs        # 3x chat, apply-template, 3x /completion, json_schema, GPU sampling
node $S/area-a-llm/run_sustained.mjs        # long generation, nvidia-smi polled every 0.5 s
node $S/area-a-llm/run_cputime.mjs          # host CPU-time / wall ratio
node $S/area-a-llm/probe_endpoints.mjs      # /health, /v1/models, /props, /slots, /metrics with and without key
node $S/area-a-llm/api_ai_status.mjs        # the API's view of the model
node $S/area-a-llm/hash_artifacts.mjs       # SHA-256 of weights and runtime
services/thermal/.venv/Scripts/python.exe $S/area-a-llm/gguf_meta.py
services/thermal/.venv/Scripts/python.exe $S/area-a-llm/zip_vs_extracted.py
npm run llm:status; npm run llm:verify; node scripts/llm.mjs dev --dry-run   # read-only

# Application path: V3 drafts and Mana (GH)
cd $S/GH && node e2e.mjs && node probe.mjs && node probe2.mjs   # WRITES synthetic rows
cd /c/Users/nihaa/ADAXAI-MVP/apps/api && ../../node_modules/.bin/tsx $S/GH/reconstruct.ts <encounterId> <conversationId> [draftVersion]   # read-only prompt proof

# Speech (B)
powershell -File $S/speech/make_tts.ps1; powershell -File $S/speech/make_tts_long.ps1
services/speech/.venv/Scripts/python.exe $S/speech/to_webm.py $S/speech/tts1.wav $S/speech/tts1.webm
PYTHONDONTWRITEBYTECODE=1 services/speech/.venv/Scripts/python.exe $S/speech/run_service.py <speech uvicorn PID>
PYTHONDONTWRITEBYTECODE=1 services/speech/.venv/Scripts/python.exe $S/speech/run_service_extra.py <PID>
PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 services/speech/.venv/Scripts/python.exe $S/speech/run_direct.py
node $S/speech/run_api.mjs                  # WRITES a synthetic patient, encounter and audio
services/speech/.venv/Scripts/python.exe $S/sweep/speech-and-vad.py

# Thermal (CD)
PYTHONDONTWRITEBYTECODE=1 services/thermal/.venv/Scripts/python.exe $S/thermal-shock/run_thermal_processing.py
PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1 services/thermal/.venv/Scripts/python.exe $S/thermal-shock/run_evaluation_synthetic.py
node $S/thermal-shock/api_thermal_path.mjs  # WRITES a synthetic patient and a draft capture
node node_modules/tsx/dist/cli.mjs $S/thermal-shock/sim_check.mts
services/thermal/.venv/Scripts/python.exe $S/sweep/thermal-extract.py
curl -s http://127.0.0.1:8001/model/status
(cd services/thermal && .venv/Scripts/python.exe -m pytest -p no:cacheprovider)        # 42 passed
(cd apps/web && node --experimental-transform-types --test test/thermalResearch.test.ts test/thermalCamera.test.ts)   # 29 pass
git grep -n -i -I -E "shock|pediatric|paediatric|perfusion|capillary|\bCPD\b|cent(er|re)[- ]to[- ]periph|\bSIPA\b|random.?forest" HEAD -- .

# Wearable and stethoscope (EF)
services/thermal/.venv/Scripts/python.exe $S/E-F-wearable-stethoscope/make_wav.py
services/speech/.venv/Scripts/python.exe $S/E-F-wearable-stethoscope/make_webm.py
node $S/E-F-wearable-stethoscope/exercise.mjs    # WRITES synthetic devices, readings and recordings
node $S/E-F-wearable-stethoscope/exercise2.mjs   # WRITES
node $S/E-F-wearable-stethoscope/exercise3.mjs   # WRITES

# Sweep (SW)
python $S/sweep/inventory.py                     # interpreter not recorded by SW
node $S/sweep/status-probe.mjs; node $S/sweep/llm-smoke.mjs; node $S/sweep/llm-smoke2.mjs
node $S/sweep/db-facts.mjs; node $S/sweep/db-devices.mjs     # read-only transactions
node $S/sweep/mana-lab-probe.mjs "<question>"                # WRITES one Mana conversation

# GPU sampling, run in parallel with any of the above
nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv,noheader -lms 200
```

**Not run, and why.**
- `npm run eval:consult`, `npm run eval:mana` and `apps/api/src/eval/stt.ts` were not run. The STT harness writes `data/eval/audio/last-run.json` inside the repo.
- The CPU LLM build was not run, because starting it would replace the running GPU server. With the owner's consent: comment out `LLM_DIR` in `.env`, then run `npm run dev:llm`.
- `npm run demo:devices` and `npm run devices:simulate` were not run, because they write tokens and post to the demo patient.

**Synthetic state the audit left in the dev database** (clean it up before a demo):
- **GH:** patient ADX-001041 "Kavya Synthetic-Audit-…". Encounter `187cc9a4-…` is still in progress.
- **B:** patient "SpeechAudit… Synthetic". Encounter `5c863e1c-…` is still in progress.
- **CD:** patient "Synthetic ThermalAudit", with one draft capture.
- **EF:** patient "Synthetic AuditEF MUW8BYLE" (ADX-001038), with four device records. Their assignments are ended and their tokens revoked.
- **SW:** one Mana conversation for dr.meera.

---

## 13. Thermal ML status

**NO TRAINED THERMAL ML MODEL VERIFIED.**

**No model exists.**
- No thermal weights exist anywhere in the repo, `.data` or either venv (CD `artifact_sweep_novenv.txt`, `artifact_sweep_venv.txt`; SW `inventory.txt`).
- The thermal venv has no sklearn, torch, onnxruntime or TensorFlow (CD `thermal_pip_list.txt`).
- `GET /model/status` returned `{available:false, … reason:'No trained thermal model is installed.'}` live, in 11.7 ms from the service and 30.5 ms through the API. The response is hard-coded in `services/thermal/app/model.py`.
- The `ThermalModel` interface (`apps/api/src/thermal/client.ts:88`) has no implementation.

**What runs is deterministic measurement**, all on CPU at 13-47 ms per call (CD):
- flyr decoding, checked against an independent Planck formula to within 3.0e-5 °C;
- image and ROI statistics;
- the rules-v1 flags.

**The only learned code is the thermal-eval-v1 logistic-regression baseline** (§9 R7).
- In this audit it was trained only on a synthetic generator.
- In the dev DB it has never been trained: there are 0 thermal labels, 0 dataset exports and 0 evaluation runs (CD; SW `db-facts.json`).
- Its target is "any clinician finding vs none", not shock.
- Its AUC of 0.9989 measures a toy generator.

**Data in the dev DB.**
- 19 public-sample captures (7 draft, 12 approved), counted after CD's own upload; SW counted 18 before it.
- 13 simulated captures.
- 0 live captures and 0 clinical captures.

**Cameras.**
- Only the FLIR AX8 sample and one older FLIR file decode.
- The DJI Zenmuse XT-R file is refused as `unsupported_format`.
- The clinic's FLIR ONE was never tested.
- The Android FLIR ONE bridge exists as source code only. There is no FLIR SDK `.aar` and no JDK, Gradle or adb on the machine, and `android/README.md` says "NOT COMPILED. NOT RUN." (CD, SW).

**Defects (not ML).**
- `/roi-stats` subtracts rounded means while `/flags` subtracts unrounded ones (2.09 vs 2.08 °C on flir_example). The evaluator's features and its rule can therefore disagree near the 1.0 °C threshold.
- rules-v1 does not flag the simulator's own `localized_difference` case at default thresholds (CD `sim_check.json`).
- Note provenance labels the rule-composed thermal summary "AI-assisted text". `docs/AI_STATUS.md` lists this as a known limitation (SW).

**Licence.** flyr is EUPL-1.2, a copyleft licence, and `services/thermal/requirements.txt` flags it for legal review.

---

## 14. Pediatric shock ML status

**MISSING.**

**No code, weights, labels or dataset exist for shock detection or prediction.** A `git grep` at HEAD for shock, pediatric, perfusion, capillary, CPD, centre-to-periphery, SIPA and random forest found 105 hits (CD `shock_grep.txt`). They are only:
- UI text, literature data, tests and department names;
- one label string;
- ADR 0022, which states that no shock, perfusion or capillary-refill computation exists.

**The "Pediatric shock research" view is descriptive, not a model.**
- Files: `apps/web/src/lib/thermalResearch.ts`, `components/thermal/ResearchMode.tsx` and `PublishedResearch.tsx`.
- The model, output and review stages are hard-coded `not_built`.
- Its only arithmetic is taking the largest absolute value of stored ROI or pair values.
- Its disclaimer reads: "Research only. Not for clinical decisions. Nothing here detects, predicts or scores shock."
- 29 web unit tests pass, including checks that no stage text contains score, threshold, probability, predict, AUC or "%" (CD `web_research_tests.txt`).
- It was not opened in a browser during the audit.

**Published figures.** The panel shows third-party published figures labelled "PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION", attributed to the primary studies the review cites (Nagori et al., Sci Rep 2019; Vats et al., Front Physiol 2022). They were checked against those papers' open-access pages during the Doctor HERO work (`scratchpad/hero-impl/cite.md`), not again in this audit. They are not ADAXAI results and must never be presented as such.

**Vital ranges.** Paediatric vital ranges are not implemented (CD); the adult ranges in `flagVital` are the only vital rules.

---

## 15. Wearable ML status

**MISSING.** No ML runs on wearable data, and no wearable hardware is integrated.

**No hardware path exists.**
- App code has no BLE, vendor SDK, serial, MQTT, HealthKit/Health Connect or cloud bridge (EF grep).
- The only data path is the token-authenticated gateway API. It was exercised with numbers posted by scripts and by the simulator, never with a device.

**The gateway accepts scalar readings only**, with no waveform or PPG input (EF `exercise.log`).
- A wearable may send heart_rate, spo2, temperature and respiratory_rate.
- BP is refused with 422 `kind_not_allowed`.
- Device values are stored as `device_unverified`; simulator values as `simulated`.

**The flags and states are rules, not ML.**
- The "high/low" flags use fixed adult reference ranges (`flagVital`).
- The reading states are clock rules: live means the newest reading is at most 30 s old, and disconnected means more than 120 s without contact. "Stale" sits between the two.
- There are no alarms.

**The only learned model that touches device data is the LLM.** It receives `device_unverified` readings as templated text in the V3 draft (EF `results3.json`). It restated them correctly, but it also produced an inaccurate "variation during this visit" item. Simulated values were correctly kept out of the draft.

**Demo hazard.** 584 readings on 8 "Band under test" records, posted by the visual-QA screenshot scripts run against the development database during the D2 and Doctor HERO work (`d2-look.mjs`, `hero-look.mjs`; the record labels carry those runs' tags, e.g. "Band under test muvlwc9h"); the e2e suite uses its own database, sit in the dev DB as `device_unverified`, and they will look like real band data (SW `db-devices.json`).

---

## 16. Stethoscope ML status

**MISSING.** Recordings are captured, stored and played back; nothing analyses them.

**No analysis code or model exists** (EF grep; SW inventory):
- no heart or lung sound model;
- no MFCC or spectrogram code;
- no filtering or resampling on this path;
- no audio-classification weights on disk.

**Storage and playback work as plain file handling.**
- Uploads (staff file, browser recording, gateway) are checked by magic bytes and size, then stored unchanged.
- Playback was byte-identical by SHA-256 (EF `probe_playback.log`).
- Stethoscope files are never sent to the speech service; transcription jobs are created only for `consultation_audio` files.

**Recordings do not reach any model.**
- The consultation context labels a recording "recording available for clinician review; not analysed" (`consultation-context/summary.ts:30`).
- Recordings are not sent to the LLM; the EF draft made with a recording present never mentioned it.
- `docs/STATUS.md` line 129 records that the LLM once invented a "murmur", which is why recordings were removed from the V3 inputs (SW).

**UNVERIFIED parts.**
- The browser recorder (`AuscultationCard.tsx`, with audio processing switched off and a 120 s cap) was read but not run in a browser.
- No real stethoscope was tested as an audio input.

---

## 17. AI recommendation/LLM status

| Feature | What actually runs | Status | Evidence |
|---|---|---|---|
| V3 consultation draft | The local Qwen3.5-4B on the GPU, plus the rule validator consult-checks-v2 and record-check-v2 | REAL AI, research/demo grade | GH, EF, A |
| "Recommendations" shown to the doctor | safety-rules-v1: allergy groups, missing allergy status, adult vital ranges, red-flag phrases | REAL NON-ML PROCESSING | GH `15-rules-steps.json` (3 rule recommendations and the `EGRESS_OFF` notice) |
| LLM recommender (recommend-v1) | Hosted Anthropic only | OFF; UNVERIFIED | GH, SW |
| AI note drafting (note-draft-v1) | Hosted only | OFF: `POST /api/transcripts/:id/drafts` returned 503 `ai_unavailable` | GH |
| AI photo description (image-describe-v1) | Hosted only; there is no local vision model | OFF, so MISSING in practice; `image_analyses` has 0 rows | GH, SW |
| Hosted reasoner | Hosted only | OFF; `docs/safety/AI_MODELS.md` says it has never been run against the real service | GH |
| Important-point extraction | extract-rules-v1, not the LLM extractor | REAL NON-ML PROCESSING | GH |

**How hosted AI is kept off** (GH `01-ai-status.json`, SW `status-probe.json`).
- `config/adaxai.yaml` sets `ai.egress.hostedProviders: false`.
- `AI_EGRESS_HOSTED` is empty, and `ANTHROPIC_API_KEY` is empty.
- `/api/ai/status` reports llm, vision and qa as unavailable with the `EGRESS_OFF` reason, and `egress.hosted false`.
- This works because no hosted client is constructed; it is not a network block. Setting both the flag and a key would enable hosted calls after a restart.

**LLM quality findings.**
- **Allergy status.** The raw model treated "allergies not recorded" as "no known allergies" and used diagnostic framing (A). The product check removes "no allergies" when an allergy is ACTIVE (GH G3). What it does when allergy status is "not recorded" was not tested in the product path: UNVERIFIED.
- **Citations.** The validator checks that a cited reference exists, not that it is the right source. The allergy entry A1 was cited for amlodipine statements. In draft v2, that wrong citation alone made an unrelated statement `conflicting` (GH).
- **Missing sections.** Neither GH draft produced any `missing_information` or `uncertainties` items, and the suggestions were generic (GH).
- **Device readings.** One inferred item attributed device readings to the wrong visit (EF).

**Provenance findings.**
- The raw model output is not stored, only its hash. Removed statements survive only as counts (GH).
- The weights hash that the API shows and stores is copied from the lock file by alias name, not measured. The runtime string "llama.cpp b11379" does not say CPU or CUDA (A, GH).

**Evaluation and determinism.**
- consult-v1 has 12 synthetic cases written by the authors. It was run on the CPU build of the previous laptop, with a median of 147 s per case (GH).
- It has not been re-run on the CUDA build, and CPU and CUDA outputs have not been shown to match (A, GH).
- All 190 consultation items in the dev DB are still `pending`, so there is no clinician review data (SW).
- Determinism: 6 of 6 outputs were identical on this build and GPU with prompt caching off (A). Each product draft was run only once (GH).

---

## 18. Mana intelligence status

### Mana V4 (the assistant): REAL AI, research/demo grade, narrow by design

**How it works** (GH):
1. **Planner (LLM).** It chooses up to 3 calls from a fixed list of 11 read-only tools, with typed arguments. Its prompt holds the question, the date, a current-patient flag and patient handles (sex and age band only), never record data.
2. **Plan checks (code).** They validate and correct the plan: regex refusals, the `mine` correction, at most 2 patients, a wrong-patient check and date bounds.
3. **Tools (SQL).** Fixed, parameterised queries, scoped to the caller's facility, return numbered facts.
4. **Writer (LLM).** It restates those facts with citations.
5. **Answer checks (code).** mana-answer-checks-v4 removes unsupported blocks, with about 40 removal reasons.

**Verified live.**
- 10 GH questions and 1 SW question, all on the local model on the GPU, each taking 3.3-7.8 s.
- The planner refused requests to prescribe and sign, to see the audit log, a general dose question and an SQL-injection text, with no tool run.

**What it does not have** (GH, SW):
- no SQL written by the model;
- no write tools;
- no external calls;
- no embeddings or RAG;
- no chaining of lookups;
- no clinical advice: the BP question got only the readings restated;
- no lab feed or lab-status tool;
- access to one facility only.

**Gaps found.**
- **Medicines.** "What medicines is this patient on?" leaves out the recorded current-medicine list. `lastPrescriptionSections` (`mana/answers.ts:147-171`) lists only the last signed prescription and today's draft (GH).
- **Completeness.** Answers are only as complete as the rule tools. The queue answer dropped "0 waiting" and "1 cancelled" and still passed the checks (GH).
- **Consent.** With the local model, Mana reads a record unless `ai_record_assistant` consent has been withdrawn; a grant is not required (`tools.ts:94-99`) (GH).
- **Auditability.** Planner prompts include the clock time, so they cannot be rebuilt byte for byte. Raw planner and writer outputs are stored only as hashes (GH).
- **Shared queue.** Drafts and Mana share one gate; one Mana question delayed a draft by 5.57 s (GH).
- **Evaluation.** The recorded evaluation mana-v1 (49 synthetic cases) was run on the CPU build, with a median of 78 s per question, and has not been re-run on CUDA (GH, A).

### Mana V1 record answers: REAL NON-ML PROCESSING

They pick an intent with regular expressions and answer from rule sections (mana-record-v3). The optional "AI summary" (mana-qa-v1) is hosted-only and returned `generation.status 'unavailable'` (GH `11-legacy-mana-rules.json`).

### D2 Overview summary: REAL NON-ML PROCESSING

It is built by context-conflicts-v2 and multimodal-summary-v2. It has no rule comparing allergies with the prescription: with amoxicillin drafted against a penicillin allergy, `context.conflicts` was empty, while record-check-v2 and safety-rules-v1 both flagged the conflict (GH).

---

## 19. Claims that must NOT be made in the final demo

| # | Do not say | Why (evidence) |
|---|---|---|
| 1 | "AI thermal analysis", "AI-powered thermography", "thermal ML", "detects inflammation/infection", or any thermal accuracy, AUC or confidence figure | No thermal model exists, and the flags are fixed thresholds (CD, SW). |
| 2 | "Trained thermal classifier" or "AUC 0.99" | The LR baseline is evaluation code. It was trained only on a synthetic generator, is never saved, and is never used on a capture (CD). |
| 3 | "Pediatric shock detection, prediction, screening or early warning", or quoting the published AUROC/AUC figures as ADAXAI results | There is no shock code, the research view says nothing detects shock, and those figures are third-party literature (CD, SW). |
| 4 | "Real FLIR live capture" or "FLIR ONE integrated/tested". The title of commit e9f1590 already overclaims this. | The Android bridge was never compiled, and there are 0 live captures (CD, SW). |
| 5 | "Heart/lung sound analysis", "murmur/wheeze/crackle detection", "AI stethoscope", "noise-filtered stethoscope audio" | Recordings are stored unchanged and never analysed (EF, SW). |
| 6 | "Mana analyses all five inputs" | Stethoscope recordings never reach any model (EF, SW). |
| 7 | "Connected wearable", "Bluetooth band", "live/continuous patient monitoring", "alarms", "validated device readings" | There is no hardware, device values are `device_unverified`, and "live" is a 30 s display rule (EF, SW). |
| 8 | "AI vitals monitoring", "anomaly detection", "early-warning score", or cuffless BP, AFib, HRV, ECG, sleep or stress analytics | None of these exists, and the gate refuses BP (EF). |
| 9 | "Clinically validated", "accurate", "safe", "medical model", "second opinion", "diagnoses", "prescribes", "codes diagnoses" | Every evaluation is synthetic, the model is a general-purpose 4B model that was not fine-tuned, and the AI never writes diagnoses or prescriptions (A, GH, SW). |
| 10 | "The AI detects drug-allergy conflicts", "validates the draft", "every statement is verified against the record", "hallucination detection" | Conflicts and support states come from fixed rules, and wrong-but-existing citations pass (GH). |
| 11 | "AI recommendations" or "clinical decision support AI" | Every recommendation shown comes from safety-rules-v1 (GH). |
| 12 | "AI note drafting", "AI photo/wound analysis", "AI record summaries", "powered by Claude" | These are hosted-only and switched off (GH, SW). |
| 13 | "Multimodal model" or "the model sees images/audio" | The model is text-only; no mmproj is installed and `/props` shows vision:false (A). |
| 14 | "Real-time AI", "10-second drafts", "real-time/streaming transcription" | Drafts take 23.6-50.3 s. STT works on 20 s chunks, with a 4-6 s delay after each and no interim words (A, GH, B). |
| 15 | "GPU-accelerated speech recognition" | STT runs only on the CPU, and the GPU stayed at 0 % (B, SW). |
| 16 | "Runs on CPU only" for the LLM, or quoting CPU-era timings (68-214 s drafts, 8-10 tok/s) as current | The live LLM is the CUDA build on the RTX 3050 (A). |
| 17 | "Pinned and hash-verified runtime", "every file the server loads is hash-checked", "llm:verify verifies the runtime" | Only the CPU zip is pinned, and the runtime binaries are never re-hashed (A). |
| 18 | "Every draft records a measured weights hash", "the API verifies which weights and backend served each draft" | The hash is copied from the lock by alias, and the backend is not recorded (A, GH). |
| 19 | "Full GPU offload" or "flash attention on", stated as fact | The runtime does not report either; both are inferred (A). |
| 20 | "Deterministic", beyond this build, GPU, settings and prompt | Outputs were 6/6 identical only under those conditions (A). |
| 21 | Any WER as real-world accuracy (including the repo's 1.8 %), "clinical-grade transcription", "medical speech model", or validated Hindi or multilingual support | All speech evidence is clean English Windows TTS, and the model is generic Whisper-small (B, SW). |
| 22 | "Speaker identification/diarisation" or "per-line transcription confidence" | The service declares speaker identification not supported, and confidence scores are per decoding window and uncalibrated (B, SW). |
| 23 | "Audio is never written to disk", said of the whole product | The API stores every upload and chunk as a plain file (B). |
| 24 | "Mana knows lab status / pending investigations", "hospital-wide intelligence", "answers any clinical question", "lists all current medicines", "RAG/AI retrieval", "the model generates SQL" | There is no lab feed; Mana covers one facility and at most 2 patients per question; the medicines answer has a gap; the tools are fixed SQL (GH, SW). |
| 25 | "Mana only reads a record with the patient's explicit AI consent", in local mode | It reads unless consent has been withdrawn (GH). |
| 26 | "Anonymised" or "ML-based de-identification" | The scrub matches name tokens by pattern; it replaced the ordinary word "Synthetic" with "(PATIENT)" because it was in the surname (GH). |
| 27 | Calling rule output "AI": important points, safety checks, the Overview summary, the thermal summary (including its "AI-assisted text" label) | All of these are fixed rules (GH, CD, SW). |
| 28 | "The e2e suite demonstrates the AI", or quoting e2e timings | The e2e AI steps run against mocks (A, B, SW). |
| 29 | "The system cannot send data to the cloud", as an absolute | Hosted egress is a server setting; it is off here, but it can be turned on (GH). |
| 30 | "Learns from doctors" | The README states there is no automatic learning (SW). |
| 31 | "Connected Healthcare Intelligence Platform", as a factual description | It is an aspirational tagline (`ApplicationSelectorPage.tsx:22`) (SW). |

---

## 20. Exact ML gaps to fix before the final MVP

| ID | Gap | Evidence | Fix |
|---|---|---|---|
| G1 | The CUDA runtime that serves the LLM is not pinned or verified. `STATUS.md:386` says its hashes were checked, but nothing records that check. | A gaps 1 and 7; A3 | Add both CUDA zips (name, size and SHA-256 from §7) to `services/llm/runtime.lock.json`. Make `scripts/llm.mjs` hash the extracted CPU and CUDA binaries, and make `llm:verify` check the runtime. Ship the llama.cpp LICENSE and the NVIDIA redistribution notices next to the binaries. |
| G2 | Provenance does not record what actually served each call. | A4; GH G1 gap 4 | Read the backend (CPU or CUDA) and GPU name from the server and record them in `ai_runs`. At the very least, label the hash "pinned, not measured". |
| G3 | GPU offload and attention settings are implicit. | A gap 2 | Pass `--n-gpu-layers` (all layers) and an explicit `--flash-attn` value in `scripts/llm.mjs`, and log both at start. |
| G4 | The model card and evaluation records describe a CPU build on a different GPU. | A gap 3; SW (`AI_MODELS.md` §1b, §8, §9, §10; `AI_STATUS.md`; `consult-v1.md`) | Re-run `npm run eval:consult` and `npm run eval:mana` on the CUDA build, store the results, and update the docs. |
| G5 | No model has any real-world evidence. | A gap 5; B; SW | Build a small, consented, de-identified test set: real-voice clinic-style audio (Indian English, background noise) for WER, and consult cases reviewed by doctors. Report the results as internal pilot numbers only. |
| G6 | "Allergies not recorded" can become "no known allergies". | A inference evidence | Add an evaluation case and a validator rule: when allergy status is not recorded, remove or flag any claim that the patient has no allergies. |
| G7 | Wrong citations to records that do exist pass the validator. | GH G1 and G3 | Before support states are propagated, check that a statement's key terms appear in at least one cited item. |
| G8 | The raw model output is not stored. | GH G1 gap 1 | Store the raw JSON, with access control, alongside each run so that drafts and Mana answers can be audited. |
| G9 | Draft latency is 23.6-50.3 s against a 10 s target. | A, GH, EF | Reduce `maxOutputTokens` and the schema size, stream progress, or split the draft into parts; then measure again on the CUDA build. |
| G10 | Language detection costs about 2 s per STT chunk, and a language is reported even on silence. | B | Set `ai.stt.languageHint: en` for the English MVP, and do not report a language for empty chunks. |
| G11 | STT has not been tested across the 20 s boundaries of real browser recordings. | B | Test with Chromium MediaRecorder output across 20 s boundaries. |
| G12 | The Silero VAD file is not pinned and its licence is not recorded. | B, SW | Add its SHA-256 and licence to `services/speech/models.lock.json`. |
| G13 | Device readings reach the LLM, which drew an unsafe conclusion from them (wrong visit attribution). | EF | Put each reading's date in the prompt, and add a validator rule for "this visit" claims about values from several visits. |
| G14 | Rule gaps that shape AI outputs: Mana's medicines answer leaves out current medicines; record-compare-v1 ignores the medicine list; context-conflicts-v2 has no allergy-vs-prescription rule; the extractor tags an allergy sentence as a symptom. | GH | Fix `mana/answers.ts:147-171` and `ai/compare.ts:102-106`, add the conflict rule, and adjust the word list. |
| G15 | In local mode, Mana reads a record without a consent grant. | GH H2 | Require an `ai_record_assistant` grant in local mode too, or document the policy and show it in the UI. |
| G16 | Thermal has no model and no labels. | CD, SW | Do not build a model for the MVP; present thermal as a measurement tool. Fix the rounded vs unrounded pair-difference mismatch. |
| G17 | The demo database contains misleading device data. | SW | Before the demo, remove the 584 readings and the "Band under test" / "Simulator band" records left by the visual-QA scripts, the synthetic patients those scripts created (e.g. "Asha…", "Riya…", "Kavya…" Synthetic) and the ones this audit created. |
| G18 | Drive C: ran out of space during the audit, and Postgres is on C:. | A, GH, B | Free space and keep a margin before any demo. |

---

## 21. Priority order for fixing them

**P0: before any external demo** (honesty and stability; no new ML).
1. G18: free disk space.
2. G17: clean the demo database.
3. §19: brief the presenters, and fix UI labels that call rule output "AI", including the thermal summary's "AI-assisted text".
4. G4, documentation part: correct `AI_MODELS.md`, `AI_STATUS.md` and `consult-v1.md` to describe the CUDA deployment, or clearly mark them as historical.

**P1: before the final MVP** (provenance and safety of the one real AI path).

5. G1: pin and verify the CUDA runtime.
6. G2: record the backend, and stop presenting the copied hash as measured.
7. G3: set the GPU offload explicitly.
8. G4, evaluation part: re-run the consult and Mana evaluations on CUDA.
9. G6: add the allergy-absence rule and its evaluation case.
10. G7: add the citation relevance check.
11. G13: fix how device readings are attributed to visits.
12. G14 and G15: close the rule and consent gaps that shape AI answers.
13. G8: store raw model outputs.
14. G9: reduce latency.

**P2: credibility of measured claims.**

15. G10 and G11: set the STT language hint and test chunk boundaries.
16. G12: pin Silero VAD.
17. G5: build small real-world test sets.
18. G16: fix the thermal pair-difference mismatch.

---

## ML AUDIT VERDICT

**REAL ML:**
- Qwen3.5-4B Q4_K_M on llama.cpp b11379 CUDA, on the RTX 3050.
- faster-whisper-small on the CPU, including Whisper language identification.
- Silero VAD v6 on onnxruntime, CPU.
- As research code run only on synthetic data: the thermal-eval-v1 numpy logistic-regression baseline.

**REAL AI** (all research/demo grade, evaluated only on synthetic data, not clinically validated):
- The V3 consultation draft and Mana V4 (planner and writer). Both run on the local Qwen model and were verified end to end through the API, with their prompts proven by hash.
- Speech-to-text through the API, for uploads and live chunks.

**REAL NON-ML PROCESSING:**
- Thermal: radiometric decoding, image and ROI statistics, rules-v1 flags, thermal-eval-v1 rule metrics.
- Speech: audio decoding and resampling.
- Drafts: V3 input assembly, consult-checks-v2, record-check-v2.
- Mana: its tools and checks, the Mana V1 answers (mana-record-v3), and the D2 context and Overview.
- Rules shown to doctors: extract-rules-v1, record-compare-v1, and safety-rules-v1 (the "recommendations" shown).
- Guards: the egress and loopback guards and the advisory boundary.
- Devices: the device gateway, reading states and adult range flags, and auscultation storage and playback.
- The LLM launcher and lock-file checks.

**SIMULATED:**
- device-sim-v1 (band values and stethoscope tones) and thermal-sim-v1.
- The e2e mocks (mock-llm, mock-speech, mock-anthropic) and the vitest fakes.
- The 584 "Band under test" readings posted by e2e tests.
- The pediatric shock research view (static literature and `not_built` stages).

**MISSING:**
- Models: any trained thermal model; pediatric shock ML; heart and lung sound analysis; wearable signal analytics (BP, arrhythmia, HRV, ECG, PPG, sleep, anomaly); speaker diarization; a local vision model; embeddings or RAG; medical fine-tuning.
- Integration and evidence: wearable and stethoscope hardware integration; a GPU speech path; any evaluation on real patient data; a lab feed for Mana.

**UNVERIFIED:**
- All hosted Anthropic providers: the note drafter, LLM extractor, recommender, image describer, Mana V1 AI summary and hosted reasoner.
- The pinned CPU llama.cpp build, and whether its outputs match the CUDA build's.
- The LLM's GPU layer count, flash-attention state and KV-cache type.
- Where the CUDA zips came from.
- The Android FLIR ONE bridge and the browser stethoscope recorder.
- Whether thermal-summary-v1 runs as the code suggests.
- The repo's own evaluation figures (consult-v1, mana-v1, stt-v1 with WER 1.8 %, extraction-v1); none was re-run here.
- What the product does when allergy status is "not recorded".
- The upstream licences of Qwen3.5-4B and Silero VAD; only metadata and lock files were read.

---

## Recommended minimal ML work for a credible final MVP

The MVP does not need a new model. It needs the three real models to be pinned, measured on the hardware they now run on, and described accurately.

1. **Pin and verify the serving stack (G1-G3).** Lock the CUDA zips, hash the binaries after extraction, set GPU offload explicitly, and record the backend and a measured weights hash in every run.
2. **Re-measure on the CUDA build (G4).** Re-run the existing consult and Mana evaluations, and publish the numbers labelled "synthetic, written by the authors". Update the model card.
3. **Close the three LLM failure modes seen in this audit (G6, G7, G13)** with code checks and evaluation cases: wording about absent allergies, wrong citations to records that exist, and visit attribution of device readings.
4. **Fix the rules behind the AI answers (G14, G15).** Fix the rule gaps that make Mana and the draft disagree, and the consent rule for local mode.
5. **Make any speech accuracy figure honest (G10, G5).** Set the English language hint and run a small, consented real-voice test. Until then, quote no WER.
6. **Do not add models for thermal, wearable, stethoscope or pediatric shock in this MVP.** Keep them as measurement, data capture and research views, and make no model claims for them. If a thermal model is wanted later, start by collecting consented, labelled captures; the existing evaluation pipeline needs at least 20 positive and 20 negative captures from at least 10 subjects.
7. **Before the demo:** free disk space, clean the demo database, and rehearse the claims list in §19.
