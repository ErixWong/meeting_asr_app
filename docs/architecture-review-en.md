# AI Meeting Assistant — Technical Architecture Overview

> **Purpose**: Consolidated technical architecture for IT Headquarters approval.
> **Scope**: Functional overview, system architecture, data model, and data flows.
> **Project**: Smart Meeting Minutes System (Web-based ASR + LLM Meeting Assistant)
> **Status**: Core application implemented and deployed locally; database portability work is in progress.

---

## 1. Executive Summary

The **AI Meeting Assistant** is a web-based, self-hosted meeting intelligence platform. It captures meeting audio in the browser (microphone and/or system audio), streams it through an **ASR Gateway** to a **FunASR** speech recognition service (2-pass protocol) for real-time transcription, then uses an **OpenAI-compatible LLM** to automatically generate structured meeting minutes, provide real-time / historical / selection-based translation, and deliver results via email (SMTP).

The system is fully self-contained: a single Node.js application server (Next.js 15 custom server) serves the UI, API, WebSocket ASR gateway, relational database persistence, LLM queue, and mailer. The business data layer is being made portable across **SQLite, Microsoft SQL Server (MSSQL), and MySQL**. SQLite remains the default database for the current local deployment, while MSSQL and MySQL are compatibility targets for enterprise deployment.

### 1.1 Core Capabilities

| # | Capability | Description |
|---|-----------|-------------|
| 1 | Real-time ASR transcription | Streaming speech-to-text (partial + final segments), language selection (auto / zh / en / ja / ko / yue) |
| 2 | Dual-channel capture | Multiple microphones + system audio (`source`: `mic` / `speaker`), per-channel mute toggle during recording |
| 3 | Speaker identification | Two-tier: server-side CAM++ registration-based 1:N recognition (names) + browser-side feature clustering (fallback) |
| 4 | Audio file transcription | Upload audio/video files, transcribed through the same ASR pipeline into a meeting |
| 5 | LLM meeting minutes | Template-driven generation with multiple templates, versioned persistence (V1/V2/...) |
| 6 | Translation | Real-time (final-sentence batching), historical (meeting-level), and selection-based translation, versioned |
| 7 | Recording resilience | ASR-failure checkpoint auto-save (`paused` status) and resume with transcript preserved |
| 8 | English meeting support | Full pipeline: SenseVoice multilingual ASR + bilingual voiceprint + English prompt templates |
| 9 | Text-to-speech | Read transcripts / minutes / selection via Web Speech API |
| 10 | Email delivery | SMTP sending of minutes with send audit records |
| 11 | Admin console | RBAC user management, ASR/LLM/Mail configuration, prompt templates, ASR hotwords, voiceprint management, audit logs, connection tests |

> Task/action-item tracking is explicitly **out of scope**; it should be developed as a separate product consuming this system's transcripts or minutes.

### 1.2 Technology Stack

| Category | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | 15 | Full-stack React; API Routes act as backend proxy |
| Language | TypeScript | 5.x | Type safety |
| UI | Tailwind CSS | 3.x | Atomic CSS |
| Database | Relational database compatibility layer | - | Supports SQLite, Microsoft SQL Server (MSSQL), and MySQL; SQLite is the current local default |
| State | Zustand | 4.x | Lightweight client state |
| ASR client | Custom `src/lib/funasr.ts` | - | Browser connects to ASR Gateway over WebSocket |
| Audio capture | Web Audio API (ScriptProcessorNode) | - | PCM 16 kHz mono extraction |
| ASR Gateway | WebSocket (`ws`) | 8.x | Browser ↔ upstream ASR relay/proxy |
| LLM | OpenAI-compatible API | - | Minutes / translation / tests share one endpoint |
| Mail | Nodemailer | 9.x | SMTP |
| TTS | Web Speech API | built-in | Browser-native |
| Voiceprint | Standalone Python service (stdlib HTTP + CAM++ `speech_campplus_sv_zh-cn_16k-common`) | separate container | Registration-based 1:N identification; zh container :10097 / zh_en :10098 |

---

## 2. System Architecture

### 2.1 Architecture Diagram

```mermaid
flowchart TB
    subgraph Browser["Browser (React / Next.js 15 Client)"]
        direction TB
        UI["Recording & Transcript UI"]
        A1["Audio Capture<br/>Web Audio API → PCM 16 kHz<br/>(mic channels + system audio)"]
        A2["FunASRClient per channel<br/>(WebSocket to /asr)"]
        A3["Transcript State Machine<br/>(partial/final per source+device,<br/>checkpoint on ASR failure)"]
        A4["Voiceprint Clustering<br/>(browser-side, 12-dim, fallback)"]
        A5["Translation Buffer<br/>(final-sentence batching)"]
        A6["TTS Provider<br/>(Web Speech API)"]
        A7["Server Voiceprint Client<br/>(identify per final segment)"]
    end

    subgraph Server["Node.js Application Server (single process)"]
        direction TB
        B1["Next.js API Routes<br/>/api/config · meetings · translate<br/>translate-selection · llm-queue-status<br/>voiceprint · admin · auth"]
        B2["ASR Gateway  /asr<br/>(WebSocket proxy + protocol adapter)"]
        B3["admin-store.ts<br/>(business logic / DB access)"]
        B4["Global LLM Queue<br/>(semaphore + FIFO, llm-queue.ts)"]
        B5["API Auth Guard<br/>(RBAC, api-auth.ts)"]
        B6["LLM Client<br/>(OpenAI-compatible, SSE streaming)"]
        B7["Mailer (Nodemailer SMTP)"]
        B8["Voiceprint Proxy<br/>(5s timeout, degradable)"]
    end

    subgraph Storage["Data Layer"]
        C0["Database Compatibility Layer<br/>Dialect-neutral repositories<br/>and versioned migrations"]
        C1[("Business Database<br/>SQLite / MSSQL / MySQL<br/>SQLite current default")]
    end

    subgraph External["External Services (intranet / cloud)"]
        D1["FunASR 2-pass ASR<br/>(local WebSocket service<br/>or Alibaba DashScope)"]
        D2["LLM Service<br/>(OpenAI-compatible,<br/>e.g. qwen3.6-35b)"]
        D3["SMTP Mail Server"]
        D4["Voiceprint Service<br/>(CAM++, zh :10097 /<br/>zh_en :10098, own SQLite DB currently)"]
    end

    UI --> A1
    A1 --> A2
    A2 -->|"WebSocket PCM stream"| B2
    A2 --> A3
    A3 --> A4
    A3 --> A5
    A3 --> A7
    UI --> A6
    UI -->|"HTTPS REST API (session cookie)"| B1
    B1 --> B5
    B5 --> B3
    B3 --> B4
    B4 --> B6
    B6 -->|"SSE streaming /chat/completions"| D2
    B3 --> B7
    B7 --> D3
    B2 -->|"protocol-adapted 2-pass stream"| D1
    B1 --> B8
    B8 -->|"identify/register/config proxy"| D4
    B3 --> C0
    B2 --> C0
    C0 --> C1
```

### 2.2 Module Description

**Browser client (Next.js)**
- Captures audio via `getUserMedia` / `getDisplayMedia`, extracts PCM 16 kHz Int16 with `ScriptProcessorNode`, and streams each channel over a dedicated WebSocket to the ASR Gateway.
- Maintains a per-channel transcript state machine (partial merge / final commit, throttled partial rendering); on ASR failure, solidifies pending partials and auto-saves the meeting as `paused`, with resume support that only appends new segments.
- Performs speaker handling on final segments in two tiers: (1) asynchronous server-side CAM++ identification (matched names override the segment speaker), (2) browser-side 12-dim voiceprint clustering as fallback (RMS, F0 autocorrelation, spectral centroid/bandwidth/rolloff/flatness/flux, self-implemented Cooley-Tukey FFT).
- Buffers final sentences and triggers batched translation; renders minutes/translations with versioning; supports per-channel microphone mute and audio file upload transcription.

**ASR Gateway (`server/asr-gateway.mjs`, path `/asr`)**
- Single relay point between browser and ASR upstream; reads ASR config + hotwords through the database compatibility layer on connect.
- Normalizes DashScope-style protocol to local FunASR 2-pass protocol (`mode:"2pass"`, `chunk_size`, `chunk_interval`, `is_speaking`, `is_eof`) and synthesizes `task-started` / `task-finished` / `result-generated` events for the frontend.
- Strips SenseVoice tags (`<|lang|><|emotion|><|event|>`); resolves result text priority `text → text_2pass → asr_result`; `isFinal = is_final || is_eof || offline mode`.
- Persists raw ASR events into capture sessions (in-memory queue + batched flush, see §4.3).
- Origin whitelist validation; production requires a valid login session for WebSocket handshake.

**Application Server / API Routes**
- `admin-store.ts` is the single business/DB layer: meetings, LLM results, translation flows, settings, users/roles, audit logs.
- All LLM calls pass through the **global LLM queue** (in-process semaphore + FIFO; concurrency and queue capacity configurable; timeouts: summary 300 s, translate/test 30 s).
- Secrets (`asr:api_key`, `llm:api_key`, `mail:smtp_password`) are server-only and never returned to the frontend.
- `/api/voiceprint/*` proxies to the standalone voiceprint container (5 s timeout; identify for any logged-in user, register/speakers/config for `system_admin`); on service unavailability the client falls back to clustering with a 30 s cooldown.

**Data Layer**
- Business persistence is accessed through a database compatibility layer targeting SQLite, Microsoft SQL Server (MSSQL), and MySQL.
- The current SQLite adapter uses one `DatabaseSync` connection, WAL journal mode, and `synchronous=FULL`; these are SQLite-specific optimizations and are not imposed on MSSQL/MySQL adapters.
- Schema evolution uses versioned migrations (`schema_version` + ordered `MIGRATIONS`) with database-specific DDL isolated behind the compatibility layer.

**Voiceprint Service (deploy/voiceprint, standalone container)**
- Python stdlib HTTP server (`voiceprint-server.py`) embedding CAM++ (`speech_campplus_sv_zh-cn_16k-common`, 192-dim), with an independent voiceprint database currently implemented with SQLite and WAL mode.
- Endpoints: `/health`, `/embedding`, `/register` (multi-sample mean, normalized), `/identify` (1:N cosine + threshold, default 0.35), `/speakers`, `/config`.
- Two containers: zh (port 10097) and zh_en bilingual (port 10098) — each with an independent voiceprint DB; model switch via admin console.

---

## 3. Data Model

The logical relational schema is defined in `server/database-schema.mjs`. It contains 14 business tables plus `schema_version` for migration bookkeeping. The current physical implementation is SQLite-oriented; the compatibility work will preserve this logical model while providing SQLite, MSSQL, and MySQL adapters and dialect-specific migrations.

### 3.1 Entity-Relationship Diagram

```mermaid
erDiagram
    users ||--o{ user_roles : "has role assignments"
    roles ||--o{ user_roles : "assigned to"
    users ||--o{ auth_sessions : "login sessions"
    users ||--o{ meetings : "owns (created_by_user_id)"
    meetings ||--o{ meeting_asr_results : "contains ASR transcripts"
    meetings ||--o{ meeting_llm_results : "LLM results (summary/translation)"
    llm_prompt_templates ||--o{ meeting_llm_results : "prompt used"
    meeting_llm_results ||--o{ meeting_send_records : "delivered by email"
    users ||--o{ meeting_send_records : "sent by"
    asr_capture_sessions ||--o{ asr_capture_events : "raw events"

    users {
        text id PK
        text account_name UK
        text display_name
        text email
        text department
        text external_user_id
        text password_hash
        int must_change_password
        text last_login_at
        text status
        text created_at
        text updated_at
    }
    roles {
        text id PK
        text role_key UK
        text role_name
        text created_at
    }
    user_roles {
        text id PK
        text user_id FK
        text role_id FK
        text created_at
    }
    auth_sessions {
        text id PK
        text user_id FK
        text token_hash UK
        text expires_at
        text created_at
        text last_seen_at
    }
    meetings {
        text id PK
        text title
        text source_type
        text source_file_name
        int duration_seconds
        text status
        text status_updated_at
        text last_error_message
        text created_by_user_id FK
        text created_by_user_name
        text created_by_user_email
        text created_at
        text updated_at
    }
    meeting_asr_results {
        text id PK
        text meeting_id FK
        text asr_provider
        text asr_setting_mark
        text asr_config_snapshot
        text capture_session_id
        text result_format
        text raw_payload
        text normalized_text
        text created_at
    }
    meeting_llm_results {
        text id PK
        text meeting_id FK
        text input_transcript_snapshot
        text llm_setting_mark
        text prompt_template_id FK
        text generation_config_snapshot
        text generation_mode
        text status
        int version_no
        text result_type
        text result_title
        text raw_prompt
        text raw_response
        text result_markdown
        text error_message
        text created_at
    }
    meeting_send_records {
        text id PK
        text meeting_llm_result_id FK
        text mail_template_type
        text subject
        text to_recipients_json
        text cc_recipients_json
        text body_markdown
        text body_html
        text status
        text mail_setting_mark
        text mail_config_snapshot
        text provider_type
        text provider_message_id
        text error_message
        text sent_by_user_id FK
        text created_at
        text sent_at
    }
    app_settings {
        text item_section PK
        text item_mark PK
        text item_title
        text item_description
        text item_value
        text updated_at
    }
    llm_prompt_templates {
        text id PK
        text template_key UK
        text template_name
        text template_type
        text content
        text description
        text status
        int is_system
        text created_at
        text updated_at
    }
    asr_hotwords {
        text id PK
        text term UK
        int weight
        text status
        text note
        text created_at
        text updated_at
    }
    asr_capture_sessions {
        text capture_session_id PK
        text task_id
        text asr_provider
        text asr_config_snapshot
        text hotwords_json
        text status
        text created_at
        text updated_at
        text expires_at
    }
    asr_capture_events {
        text id PK
        text capture_session_id FK
        int sequence_no
        text event_json
        text received_at
    }
    audit_logs {
        text id PK
        text actor_user_id
        text actor_account_name
        text actor_display_name
        text action_type
        text resource_type
        text resource_id
        text resource_name
        text request_id
        text result
        text error_message
        text before_snapshot
        text after_snapshot
        text created_at
    }
    schema_version {
        int version PK
    }
```

### 3.2 Table Purpose

| Table | Purpose |
|---|---|
| `app_settings` | Key-value configuration (ASR / LLM / Mail / queue / translation triggers / voiceprint) |
| `llm_prompt_templates` | Prompt templates (system template `tpl-translate` included) |
| `asr_hotwords` | ASR hotwords (boost terms) |
| `users` | Users (scrypt password hash, forced password change flag) |
| `roles` | Roles (`user`, `system_admin`) |
| `user_roles` | User-role association |
| `auth_sessions` | Login sessions (cookie, token hash, TTL 7 days) |
| `meetings` | Meeting master records (owner-bound via `created_by_user_id`) |
| `meeting_asr_results` | Meeting ASR transcripts (raw payload = structured session summary) |
| `meeting_llm_results` | Versioned LLM results (summary / translation; `UNIQUE(meeting_id, version_no)`) |
| `meeting_send_records` | Email send records (audit trail of deliveries) |
| `asr_capture_sessions` | ASR capture sessions (runtime, TTL-expired) |
| `asr_capture_events` | Raw ASR event stream (batched write, per-session sequencing) |
| `audit_logs` | Audit logs (30-day retention, auto-cleanup) |
| `schema_version` | Migration version bookkeeping (versioned schema evolution via ordered `MIGRATIONS`) |

### 3.3 Key Design Decisions

- **Zero-schema-migration for translations**: translations reuse `meeting_llm_results` with `result_type='translation'` and a globally incrementing `version_no`; `input_transcript_snapshot` stores the source text, `generation_config_snapshot` stores `{targetLang, source}`.
- **Schema evolution is versioned and database-neutral**: table structure changes must go through the `schema_version` + ordered `MIGRATIONS` mechanism. Migration execution, transactions, indexes, upserts, pagination, timestamps, and JSON/text handling must be mapped by the selected SQLite/MSSQL/MySQL adapter; changing only a SQLite `CREATE TABLE IF NOT EXISTS` statement is not sufficient for existing databases.
- **`summary` derivation**: the meeting summary sub-query always picks the newest `succeeded` result **excluding** `result_type='translation'` to prevent translations replacing minutes in list views.
- **`raw_payload` is a structured session summary** `{captureSessionId, taskId, status, asrProvider, eventStats, speakerIds, transcriptSegments}` — individual raw events are **not** retained (no display value; approved product decision).
- **Data isolation**: every meeting read/update/delete goes through `ensureMeetingOwned`; non-owners receive 404 (no resource enumeration).
- **Read-path layering**: `getMeetingById` (full, detail) vs `getMeetingLightById` (no transcript, used for polling/lists).

---

## 4. Data Flows

### 4.1 Real-time ASR Transcription Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant B as Browser
    participant G as ASR Gateway (/asr)
    participant F as FunASR Upstream
    participant S as Next.js API Server
    participant D as Business Database

    U->>B: Start recording (select mics + system audio)
    B->>B: getUserMedia / getDisplayMedia<br/>create AudioContext per channel
    B->>G: WebSocket connect (svs_lang, session params)
    G->>G: Load ASR config + hotwords from DB
    G->>F: Initialize 2-pass session (chunk_size, is_speaking)
    F-->>G: session ready
    G-->>B: task-started

    loop while recording
        B->>G: PCM Int16 frames (per channel)
        G->>F: Forward audio chunks
        F-->>G: partial / final transcript events
        G->>G: Normalize (strip SenseVoice tags,<br/>text priority, isFinal resolve)
        G-->>B: result-generated (partial/final)
        G->>G: Enqueue raw event (in-memory, cap 10k/8MB)
        alt flush timer (500 ms) or batch full
            G->>D: Batch INSERT capture events
        end
        alt final segment
            B->>B: Commit transcript segment + clustering (fallback)<br/>extract sentence audio (≥0.2 s)
            B->>B: Async voiceprint identify (see 4.3)
            B->>S: POST /api/translate (buffered N sentences / 10 s)
            S->>S: LLM queue → translateSentences
            S-->>B: translation + elapsedMs
            B->>B: Render translation
        end
    end

    U->>B: Stop recording
    B->>G: Finish signal (is_eof)
    G->>F: End-of-stream message
    F-->>G: Final results
    G-->>B: task-finished
    B->>S: POST /api/meetings (save meeting + transcript)
    S->>D: Persist meeting / asr result / raw_payload
    S->>S: Release capture session, clear event rows
    S-->>B: meeting saved (light view)
```

### 4.2 LLM Minutes Generation Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant B as Browser
    participant A as API Route
    participant St as admin-store.ts
    participant Q as Global LLM Queue
    participant L as LLM Service
    participant D as Business Database

    U->>B: Click "Generate Minutes" (or select template)
    B->>A: POST /api/meetings/:id/llm-results
    A->>A: RBAC check (BUSINESS_ROLES)
    A->>St: createMeetingLlmResult
    St->>St: claimMeetingLlmGeneration (atomic claim,<br/>conflict → 409)
    St-->>A: Accepted (fire-and-forget)
    A-->>B: 202 / llm_processing
    St->>Q: llmQueue.enqueue(type=summary, timeout 300 s)
    Q->>L: OpenAI-compatible SSE request<br/>(stream:true, template + transcript)
    loop token stream
        L-->>Q: content / reasoning chunks
        Q->>Q: parse SSE (content, finish_reason)
    end
    Q->>St: Finalize result (status succeeded/failed,<br/>"possibly incomplete" marker on finish=length)
    St->>D: INSERT meeting_llm_results v+N<br/>UPDATE meeting status
    St->>D: Write audit log
    loop every 2 s until terminal
        B->>A: GET /api/meetings/:id?view=light
        A->>D: Query status
        A-->>B: llm_processing / succeeded / failed
    end
    B-->>U: Render minutes (markdown) + version list
```

### 4.3 Server-side Voiceprint Identification Flow

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant A as API Route /api/voiceprint
    participant P as Voiceprint Proxy (voiceprint-server.ts)
    participant V as Voiceprint Service (CAM++)
    participant D as Voiceprint DB (SQLite)

    Note over B: On transcript.final with audio ≥0.2 s (3200 samples)
    B->>A: POST /api/voiceprint/identify<br/>(Float32Array → int16 PCM base64)
    A->>A: RBAC check (BUSINESS_ROLES)
    A->>P: proxyVoiceprint('/identify', 5 s timeout)
    P->>V: POST /identify (16 kHz mono PCM)
    V->>V: CAM++ embedding (192-dim) → 1:N cosine + threshold (0.35)
    V-->>P: {matched, speaker, score, top}
    P-->>A: result
    A-->>B: 200

    alt matched
        B->>B: Override segment speaker with registered name<br/>(persisted with meeting)
    end

    alt service unreachable / timeout / 5xx
        A-->>B: VoiceprintUnavailableError
        B->>B: Cooldown 30 s (no further requests)<br/>fallback clustering result used
    end

    Note over B: Registration path (admin): POST /api/voiceprint/register<br/>records multi-sample mean embedding · voiceprint DBs are<br/>independent per model (zh / zh_en) — re-register after switch
```

### 4.4 Recording Resilience (Checkpoint & Resume) Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant B as Browser
    participant A as API Route
    participant St as admin-store.ts
    participant D as Business Database

    Note over B: ASR connection fails during recording
    B->>B: Stop all ASR sessions<br/>solidify pending partials (checkpoint)
    B->>A: POST /api/meetings (create if none) /<br/>PATCH append new segments
    A->>St: saveAsrCheckpoint (transcript + captureSessionId)
    St->>D: Persist meeting / segments
    A->>A: PATCH status=paused, last_error_message
    A-->>B: meeting (paused)
    B-->>U: Show "Paused" + error message

    U->>B: Click Resume
    B->>B: Wait for checkpoint save to complete
    B->>A: Reconnect ASR session (new capture)
    Note over B: Keeps existing transcript · only uploads segments<br/>newer than last persisted count (persistedSegmentCountRef)
    A-->>B: session.started
    B->>B: Continue recording → append-only persistence
```

### 4.5 Historical / Selection Translation Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant B as Browser
    participant A as API Route
    participant St as admin-store.ts
    participant Q as Global LLM Queue
    participant L as LLM Service
    participant D as Business Database

    U->>B: Choose target language → Translate meeting
    B->>A: POST /api/meetings/:id/llm-results (translation)
    A->>St: translateMeetingFlow
    loop batches of ≤5 sentences / ≤1000 chars
        St->>St: translateSentences (direct call,<br/>NO nested enqueue — outer slot held)
        St->>Q: enqueue? No — runs inside holder
        Q->>L: LLM request (translation template)
        L-->>Q: translation response
        Q-->>St: batch result
    end
    St->>D: Write meeting_llm_results (result_type=translation,<br/>version_no global, input snapshot)
    St->>D: status = succeeded (all batches) / failed (any batch)
    A-->>B: result
    B-->>U: Show translation tab + version buttons (V1/V2...)

    Note over B,D: Real-time translation path: POST /api/meetings/:id/live-translation<br/>(pure persistence, zero LLM call — final text already produced)
```

### 4.6 Authentication & Authorization Flow

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant B as Browser
    participant A as API Route /api/auth
    participant St as admin-store.ts
    participant D as Business Database

    U->>B: Enter credentials
    B->>A: POST /api/auth/login
    A->>St: verifyCredentials (async scrypt)
    St->>D: Read user + password hash
    St->>St: mustChangePassword? → create session, flag 403 on next API call
    St->>D: INSERT auth_sessions (token hash, expires 7 d)
    St-->>A: session token
    A-->>B: Set-Cookie (HttpOnly)

    Note over B,D: Subsequent requests carry session cookie
    B->>A: GET /api/meetings (business route)
    A->>A: authorizeAnyRole → BUSINESS_ROLES (user/system_admin)
    A->>St: getMeetingById (ensureMeetingOwned)
    St->>D: Query meeting WHERE owner = actor
    St-->>A: meeting row or null → 404
    A-->>B: 200 / 404 (no enumeration)

    Note over A: Admin routes require system_admin (ADMIN_ROLES),<br/>backend is the sole authorization authority
```

---

## 5. Security

| Area | Control |
|---|---|
| Authentication | Session-cookie based; passwords hashed with `scrypt` (async on interactive paths); 7-day session TTL; forced password change on first login / admin reset; reset invalidates all sessions |
| Authorization | RBAC: `user` / `system_admin`; backend-only enforcement; frontend role checks only hide entry points |
| Data isolation | Meetings strictly owner-bound (`created_by_user_id`); non-owners get 404; admins have **no** global meeting view |
| Secrets | API keys / SMTP password never returned to frontend; only non-sensitive config summaries exposed to regular users |
| WebSocket | Origin whitelist; production handshake requires valid session (rejects expired / forced-password-change / no-business-role) |
| Audit | `audit_logs` record who/what/when/result; 30-day retention with daily + startup cleanup; no content body in audit entries |
| Transport | HTTPS termination via reverse proxy (nginx, see `docs/nginx-meeting-asr.conf`) |
| LLM safety | Global queue prevents model saturation; queue capacity exceeded → fast reject ("LLM busy") |

---

## 6. Deployment

- **Single process**: unified HTTP + WebSocket server (`server/app-server.mjs`), custom Next.js server, default port `3123`.
- **Database compatibility**: business persistence targets SQLite, Microsoft SQL Server (MSSQL), and MySQL through a database compatibility layer. The current local deployment uses a SQLite file under `data/`; its single connection, WAL mode, and `synchronous=FULL` settings are SQLite-specific.
- **Docker**: `docker-compose.yml` bundles the app + optional local FunASR service (see `docs/funasr-deployment.md`, `docs/funasr-voiceprint-deployment.md`); the voiceprint service runs as independent containers (`deploy/voiceprint/`, zh :10097 / zh_en :10098).
- **Reverse proxy**: nginx config provided (`docs/nginx-meeting-asr.conf`) for HTTPS and multi-instance scaling.
- **ASR upstream options**: local FunASR 2-pass WebSocket (default, Paraformer / SenseVoice) or Alibaba Cloud DashScope (compatibility fallback), switchable at runtime via admin ASR config.

---

## 7. Known Boundaries & Future Direction

| Item | Status / Direction |
|---|---|
| Global LLM queue | In-process only; multi-instance deployment requires Redis-based coordination (not yet implemented) |
| Business database portability | Compatibility work in progress; the logical model must support SQLite, Microsoft SQL Server (MSSQL), and MySQL. SQLite is currently deployed locally; production adapter selection requires database-specific migration and integration validation |
| Service-side speaker recognition | Implemented (CAM++ standalone container). Constraints: must run as an isolated process (memory stability), ERES2NetV2 rejected (OOM), voiceprint DBs are independent per model — re-register after switching; audio is not persisted yet (future: audio persistence + offline re-identification) |
| English meetings | Supported end-to-end via SenseVoice multilingual ASR + bilingual CAM++ voiceprint + English prompt templates; the three layers can be enabled independently |
| Task/action-item tracking | Out of scope; separate product consuming this system's output |
| ASR event detail retention | Raw per-event details not persisted (memory stats summary only); replay capability would require separate design |
| Runtime config cache | In-process convention; multi-instance split requires a shared invalidation mechanism |

---

*Source documents (Chinese originals): `docs/technical-design.md`, `docs/design/` (asr-dual-channel, llm-generation-pipeline, llm-queue-and-translation, perf-and-storage, auth-permissions-and-tenant-isolation, funasr-voiceprint), `docs/auth-productization.md`, `docs/deployment-guide.md`.*
