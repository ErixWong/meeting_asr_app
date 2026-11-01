import { createHash, randomUUID } from "crypto";
import { existsSync, unlinkSync } from "fs";
import { getDb as getSharedDb } from "./db-shared.mjs";
import { resolveStoredPath } from "./audio-paths.mjs";

const MAX_CAPTURE_EVENTS = 10000;
const MAX_CAPTURE_EVENT_CHARS = 512 * 1024;
const MAX_CAPTURE_EVENT_CHARS_TOTAL = 8 * 1024 * 1024;
const ASR_GATEWAY_ROLE_KEYS = new Set(["user", "system_admin"]);

// 录音默认值（后台 app_settings 的 audio:* 三项，缺行时按这些兜底）
const AUDIO_DEFAULT_BITRATE_KBPS = 48;
const AUDIO_DEFAULT_ORPHAN_TTL_HOURS = 72;
const AUDIO_ALLOWED_BITRATES = [32, 48, 64, 96, 128];
const AUDIO_DEFAULT_SAMPLE_RATE = 16000;

let dbSeeded = false;
let seedPromise = null;

function nowIso() {
  return new Date().toISOString();
}

/**
 * 取数据库句柄（异步）。
 *
 * 与 legacy 的差异：legacy 用 `dbSeeded` 布尔值保证只 seed 一次；异步化后首次 seed
 * 本身要 await，用 single-flight promise 代替布尔值，避免并发首调重复 seed。
 */
async function getDb() {
  const database = await getSharedDb();
  if (!seedPromise) {
    seedPromise = seedAsrDefaults(database).catch((error) => {
      seedPromise = null;
      throw error;
    });
  }
  await seedPromise;
  return database;
}

async function insertMissingSetting(database, section, mark, title, description, value) {
  await database
    .prepare(`
      INSERT INTO app_settings (item_section, item_mark, item_title, item_description, item_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_section, item_mark) DO NOTHING
    `)
    .run(section, mark, title, description, value, nowIso());
}

async function seedAsrDefaults(database) {
  await insertMissingSetting(database, "asr", "provider", "ASR Provider", "当前 ASR 提供方", "local_funasr");
  await insertMissingSetting(database, "asr", "endpoint", "FunASR Endpoint", "FunASR 服务地址", "ws://funasr.local:10095/ws");
  await insertMissingSetting(database, "asr", "api_key", "ASR API Key", "DashScope API Key", "");
  await insertMissingSetting(database, "asr", "workspace_id", "ASR Workspace ID", "DashScope Workspace ID", "");
  await insertMissingSetting(database, "audio", "record_enabled", "录音落盘开关", "是否在转写的同时旁路录制原始音频", "1");
  await insertMissingSetting(database, "audio", "bitrate_kbps", "录音码率（kbps）", "会议结束后转码 MP3 的码率，默认 48", String(AUDIO_DEFAULT_BITRATE_KBPS));
  await insertMissingSetting(database, "audio", "orphan_ttl_hours", "孤儿录音保留（小时）", "未绑定会议的录音保留时长，默认 72", String(AUDIO_DEFAULT_ORPHAN_TTL_HOURS));
}

function settingValue(settings, section, mark) {
  return settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function authorizeAsrGatewaySession(sessionToken, devAccountName = "") {
  const normalizedToken = String(sessionToken || "").trim();
  const normalizedDevAccount = String(devAccountName || "").trim();
  if (!normalizedToken && !normalizedDevAccount) {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  const database = await getDb();
  const session = normalizedToken
    ? await database
      .prepare(`
        SELECT
          s.user_id as userId,
          u.account_name as accountName,
          u.display_name as displayName,
          u.status,
          u.must_change_password as mustChangePassword
        FROM auth_sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `)
      .get(hashSessionToken(normalizedToken), nowIso())
    : await database
      .prepare(`
        SELECT
          id as userId,
          account_name as accountName,
          display_name as displayName,
          status,
          must_change_password as mustChangePassword
        FROM users
        WHERE account_name = ?
      `)
      .get(normalizedDevAccount);

  if (!session || session.status !== "active") {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  if (Boolean(session.mustChangePassword)) {
    return { ok: false, status: 403, error: "Password change required" };
  }

  const roleKeys = (
    await database
      .prepare(`
        SELECT r.role_key as roleKey
        FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?
      `)
      .all(session.userId)
  ).map((row) => String(row.roleKey));

  if (!roleKeys.some((roleKey) => ASR_GATEWAY_ROLE_KEYS.has(roleKey))) {
    return { ok: false, status: 403, error: "ASR access is not allowed for this role" };
  }

  if (normalizedToken) {
    await database
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(nowIso(), hashSessionToken(normalizedToken));
  }

  return {
    ok: true,
    actor: {
      id: session.userId,
      accountName: session.accountName,
      displayName: session.displayName,
      roles: roleKeys,
    },
  };
}

function normalizeFunasrUrl(rawUrl) {
  if (!rawUrl) return "";

  const normalized = rawUrl.startsWith("ws://") || rawUrl.startsWith("wss://")
    ? rawUrl
    : rawUrl.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");

  const url = new URL(normalized);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/ws";
  }

  return url.toString();
}

let cachedRuntimeConfig = null;

async function loadAsrRuntimeConfig() {
  const database = await getDb();
  const settings = await database
    .prepare(`
      SELECT
        item_section as itemSection,
        item_mark as itemMark,
        item_value as itemValue
      FROM app_settings
    `)
    .all();

  const hotwordRows = await database
    .prepare(`
      SELECT term, weight
      FROM asr_hotwords
      WHERE status = 'active'
      ORDER BY created_at ASC
    `)
    .all();

  const providerType = settingValue(settings, "asr", "provider") || "local_funasr";
  const endpoint = settingValue(settings, "asr", "endpoint");
  const apiKey = settingValue(settings, "asr", "api_key");
  const workspaceId = settingValue(settings, "asr", "workspace_id");
  const hotwords = hotwordRows.reduce((acc, item) => {
    acc[item.term] = Number(item.weight);
    return acc;
  }, {});

  const isLocalFunasr = providerType === "local_funasr";
  const isDashScope = providerType === "dashscope";
  const targetWsUrl = isDashScope
    ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
    : normalizeFunasrUrl(endpoint);

  return {
    providerType,
    endpoint,
    apiKey,
    workspaceId,
    hotwords,
    targetWsUrl,
    isLocalFunasr,
    isDashScope,
  };
}

export async function getAsrRuntimeConfig() {
  if (!cachedRuntimeConfig) {
    cachedRuntimeConfig = await loadAsrRuntimeConfig();
  }
  return cachedRuntimeConfig;
}

export function invalidateAsrRuntimeConfig() {
  cachedRuntimeConfig = null;
}

export async function createCaptureSession(input) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const database = await getDb();
  await database
    .prepare(`
      INSERT INTO asr_capture_sessions (
        capture_session_id, task_id, asr_provider, asr_config_snapshot,
        hotwords_json, status, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capture_session_id) DO UPDATE SET
        task_id = excluded.task_id,
        asr_provider = excluded.asr_provider,
        asr_config_snapshot = excluded.asr_config_snapshot,
        hotwords_json = excluded.hotwords_json,
        status = excluded.status,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `)
    .run(
      input.captureSessionId,
      input.taskId,
      input.asrProvider,
      JSON.stringify(input.asrConfigSnapshot),
      JSON.stringify(input.hotwords),
      "capturing",
      createdAt,
      createdAt,
      expiresAt
    );

  captureStats.set(input.captureSessionId, {
    totalEvents: 0,
    onlineEvents: 0,
    offlineEvents: 0,
    finalSegmentsCount: 0,
    firstEventAt: null,
    lastEventAt: null,
    speakerIds: new Set(),
  });
}

// ---------------------------------------------------------------------------
// In-memory capture event queue (hot path: no synchronous DB I/O per event)
// ---------------------------------------------------------------------------

const pendingQueues = new Map();
const captureStats = new Map();

function collectEventStats(captureSessionId, event, receivedAt) {
  const stats = captureStats.get(captureSessionId);
  if (!stats) return;

  stats.totalEvents++;
  const mode = String(event?.payload?.mode ?? "");
  if (mode.includes("2pass-online")) stats.onlineEvents++;
  if (mode.includes("2pass-offline")) stats.offlineEvents++;

  const result = event?.payload?.result ?? event?.payload;
  if (Boolean(result?.is_final)) {
    const segments = Array.isArray(result?.segments) ? result.segments : [];
    stats.finalSegmentsCount += segments.length > 0 ? segments.length : 1;
    for (const segment of segments) {
      if (Number.isFinite(Number(segment?.spk))) {
        stats.speakerIds.add(Number(segment.spk));
      }
    }
  }
  if (Number.isFinite(Number(result?.spk))) {
    stats.speakerIds.add(Number(result.spk));
  }

  if (!stats.firstEventAt) stats.firstEventAt = receivedAt;
  stats.lastEventAt = receivedAt;
}

/**
 * Snapshot of in-memory capture session statistics (see round07-audit).
 * Null when the session is unknown.
 */
export function getCaptureSessionStats(captureSessionId) {
  const stats = captureStats.get(captureSessionId);
  if (!stats) return null;
  return {
    totalEvents: stats.totalEvents,
    onlineEvents: stats.onlineEvents,
    offlineEvents: stats.offlineEvents,
    finalSegmentsCount: stats.finalSegmentsCount,
    firstEventAt: stats.firstEventAt,
    lastEventAt: stats.lastEventAt,
    speakerIds: [...stats.speakerIds],
  };
}

/**
 * Release in-memory state (stats + pending queue) for a capture session.
 * Called after the session row is deleted by meeting save (round04).
 */
export function releaseCaptureSession(captureSessionId) {
  captureStats.delete(captureSessionId);
  pendingQueues.delete(captureSessionId);
}

// 语句包装器不再跨调用缓存：`AsyncDb.prepare()` 现在只是闭包工厂（无真实 prepared
// statement 开销），而缓存会把语句钉在创建时的那条连接上。issue #55 起事务连接由
// `withTransaction(cb)` 交给回调的 `tx` 句柄承载（不再有实例级的 `this.knex = trx`），
// 每次调用重新 `statementsFor(tx)` 即可让语句与事务同连接。
function statementsFor(database) {
  return {
    sessionExpires: database.prepare(
      "SELECT expires_at as expiresAt FROM asr_capture_sessions WHERE capture_session_id = ?"
    ),
    nextSequence: database.prepare(
      "SELECT COALESCE(MAX(sequence_no), 0) + 1 as nextSequence FROM asr_capture_events WHERE capture_session_id = ?"
    ),
    insertEvent: database.prepare(`
      INSERT INTO asr_capture_events (
        id, capture_session_id, sequence_no, event_json, received_at
      ) VALUES (?, ?, ?, ?, ?)
    `),
    updateSession: database.prepare(
      "UPDATE asr_capture_sessions SET updated_at = ? WHERE capture_session_id = ?"
    ),
  };
}

async function getQueueState(captureSessionId) {
  let state = pendingQueues.get(captureSessionId);
  if (state) return state;

  const database = await getDb();
  const session = await statementsFor(database).sessionExpires.get(captureSessionId);
  if (!session) return null;

  state = {
    expiresAt: String(session.expiresAt),
    events: [],
    bytes: 0,
  };
  pendingQueues.set(captureSessionId, state);
  return state;
}

/**
 * Enqueue one ASR upstream event for a capture session. Pure in-memory on the
 * hot path; the database is only touched by flushCaptureEvents().
 * Returns false when the session is missing/expired or a limit is exceeded
 * (same semantics as the previous synchronous insert).
 */
export async function appendCaptureEvent(captureSessionId, event) {
  const eventJson = JSON.stringify(event);
  if (typeof eventJson !== "string" || eventJson.length > MAX_CAPTURE_EVENT_CHARS) return false;

  const state = await getQueueState(captureSessionId);
  if (!state || String(state.expiresAt) < nowIso()) {
    if (state) {
      pendingQueues.delete(captureSessionId);
      captureStats.delete(captureSessionId);
    }
    return false;
  }

  if (state.events.length >= MAX_CAPTURE_EVENTS) return false;
  if (state.bytes + eventJson.length > MAX_CAPTURE_EVENT_CHARS_TOTAL) return false;

  state.events.push({ eventJson, receivedAt: nowIso() });
  state.bytes += eventJson.length;
  collectEventStats(captureSessionId, event, state.events[state.events.length - 1].receivedAt);
  return true;
}

async function flushQueueState(database, captureSessionId, state) {
  const events = state.events;
  state.events = [];
  state.bytes = 0;

  try {
    return await database.withTransaction(async (tx) => {
      // 事务内一律走 tx（issue #55 D1/D2）：用外层 database 会落在事务连接之外，
      // 且被 AsyncDb 的运行期防线直接抛错。
      const txStatements = statementsFor(tx);
      const session = await txStatements.sessionExpires.get(captureSessionId);
      if (!session || String(session.expiresAt) < nowIso()) {
        pendingQueues.delete(captureSessionId);
        captureStats.delete(captureSessionId);
        // legacy 这里是 BEGIN → ROLLBACK；此时还没写入任何行，提交空事务与回滚
        // 的数据效果相同（见报告「行为差异清单」）。
        return 0;
      }

      let sequenceNo = Number(
        (await txStatements.nextSequence.get(captureSessionId))?.nextSequence ?? 1
      );
      for (const item of events) {
        await txStatements.insertEvent.run(
          `${captureSessionId}-${sequenceNo}`,
          captureSessionId,
          sequenceNo,
          item.eventJson,
          item.receivedAt
        );
        sequenceNo++;
      }

      await txStatements.updateSession.run(events[events.length - 1].receivedAt, captureSessionId);
      return events.length;
    });
  } catch (error) {
    // Batching is best-effort by design (analysis.md C4: loss window <= flush
    // interval is acceptable for capture/replay data). Never throw into the
    // gateway hot path.
    console.error("[Capture Store] batch flush failed, dropping events:", error);
    return 0;
  }
}

/**
 * Persist queued capture events. With an argument, flushes only that capture
 * session (used as drain before reading events for a saved meeting).
 */
export async function flushCaptureEvents(captureSessionId) {
  const database = await getDb();

  if (captureSessionId) {
    const state = pendingQueues.get(captureSessionId);
    if (!state || state.events.length === 0) return 0;
    return flushQueueState(database, captureSessionId, state);
  }

  let flushed = 0;
  for (const [sessionId, state] of pendingQueues) {
    if (state.events.length === 0) continue;
    flushed += await flushQueueState(database, sessionId, state);
  }
  return flushed;
}

export function drainCaptureEvents(captureSessionId) {
  return flushCaptureEvents(captureSessionId);
}

let flushTimer = null;

export function startCaptureFlushTimer(intervalMs = 500) {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushCaptureEvents().catch((error) => {
      console.error("[Capture Store] timer flush failed:", error);
    });
  }, intervalMs);
  flushTimer.unref();
}

export async function closeCaptureStore() {
  try {
    await flushCaptureEvents();
  } catch (error) {
    console.error("[Capture Store] final flush failed:", error);
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export async function finishCaptureSession(captureSessionId, status = "completed") {
  const database = await getDb();
  await database
    .prepare(`
      UPDATE asr_capture_sessions
      SET status = ?, updated_at = ?
      WHERE capture_session_id = ?
    `)
    .run(status, nowIso(), captureSessionId);
}

export async function cleanupExpiredCaptureSessions() {
  const database = await getDb();
  await database
    .prepare("DELETE FROM asr_capture_sessions WHERE expires_at < ?")
    .run(nowIso());
}

// ---------------------------------------------------------------------------
// Meeting audio recordings (feat-261101-01)
//
// 表 meeting_audio_recordings 的 node 侧读写，风格照 createCaptureSession /
// finishCaptureSession / cleanupExpiredCaptureSessions 这一组。
// 主键沿用本项目现状 `aud-<uuid>`（见工单 §4 与设计文档）。
// ---------------------------------------------------------------------------

const AUDIO_ROW_COLUMNS = `
  id,
  capture_session_id as captureSessionId,
  meeting_id as meetingId,
  file_path as filePath,
  raw_file_path as rawFilePath,
  format,
  status,
  bytes,
  duration_seconds as durationSeconds,
  sample_rate as sampleRate,
  bitrate_kbps as bitrateKbps,
  error_message as errorMessage,
  created_at as createdAt,
  updated_at as updatedAt,
  expires_at as expiresAt
`;

function normalizeAudioRow(row) {
  if (!row) return null;
  return {
    ...row,
    bytes: Number(row.bytes ?? 0),
    durationSeconds: Number(row.durationSeconds ?? 0),
    sampleRate: Number(row.sampleRate ?? AUDIO_DEFAULT_SAMPLE_RATE),
    bitrateKbps: row.bitrateKbps === null || row.bitrateKbps === undefined
      ? null
      : Number(row.bitrateKbps),
    meetingId: row.meetingId ?? null,
    filePath: row.filePath ?? null,
    rawFilePath: row.rawFilePath ?? null,
    errorMessage: row.errorMessage ?? null,
    expiresAt: row.expiresAt ?? null,
  };
}

function normalizeBitrateKbps(value) {
  const parsed = Number(String(value ?? "").trim());
  if (Number.isFinite(parsed) && AUDIO_ALLOWED_BITRATES.includes(parsed)) return parsed;
  return AUDIO_DEFAULT_BITRATE_KBPS;
}

function normalizeOrphanTtlHours(value) {
  const parsed = Number(String(value ?? "").trim());
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 24 * 365) return Math.round(parsed);
  return AUDIO_DEFAULT_ORPHAN_TTL_HOURS;
}

function parseBooleanSetting(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return true;
}

let cachedAudioRuntimeConfig = null;

async function loadAudioRuntimeConfig() {
  const database = await getDb();
  const settings = await database
    .prepare(`
      SELECT
        item_section as itemSection,
        item_mark as itemMark,
        item_value as itemValue
      FROM app_settings
      WHERE item_section = 'audio'
    `)
    .all();

  return {
    recordEnabled: parseBooleanSetting(settingValue(settings, "audio", "record_enabled"), true),
    bitrateKbps: normalizeBitrateKbps(settingValue(settings, "audio", "bitrate_kbps")),
    orphanTtlHours: normalizeOrphanTtlHours(settingValue(settings, "audio", "orphan_ttl_hours")),
    sampleRate: AUDIO_DEFAULT_SAMPLE_RATE,
  };
}

/**
 * 录音配置（带缓存）。ASR 网关在会话开始时取一次，**不在 PCM 帧回调里查库**；
 * 后台改设置后由 invalidateAudioRuntimeConfig() 失效。
 */
export async function getAudioRuntimeConfig() {
  if (!cachedAudioRuntimeConfig) {
    cachedAudioRuntimeConfig = await loadAudioRuntimeConfig();
  }
  return cachedAudioRuntimeConfig;
}

export function invalidateAudioRuntimeConfig() {
  cachedAudioRuntimeConfig = null;
}

/** 开关关闭期间不登记行；capture_session_id unique，重复登记走 upsert。 */
export async function registerAudioRecording(input) {
  const createdAt = nowIso();
  const ttlHours = normalizeOrphanTtlHours(
    input?.orphanTtlHours ?? (await getAudioRuntimeConfig()).orphanTtlHours
  );
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  const sampleRate = Number(input?.sampleRate) > 0 ? Number(input.sampleRate) : AUDIO_DEFAULT_SAMPLE_RATE;

  const database = await getDb();
  await database
    .prepare(`
      INSERT INTO meeting_audio_recordings (
        id, capture_session_id, meeting_id, file_path, raw_file_path, format, status,
        bytes, duration_seconds, sample_rate, bitrate_kbps, error_message,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, NULL, NULL, ?, 'mp3', 'recording', 0, 0, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(capture_session_id) DO UPDATE SET
        raw_file_path = excluded.raw_file_path,
        sample_rate = excluded.sample_rate,
        status = 'recording',
        error_message = NULL,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `)
    .run(
      `aud-${randomUUID()}`,
      input.captureSessionId,
      input.rawFilePath ?? null,
      sampleRate,
      createdAt,
      createdAt,
      expiresAt
    );

  return getAudioRecording(input.captureSessionId);
}

export async function getAudioRecording(captureSessionId) {
  if (!captureSessionId) return null;
  const database = await getDb();
  const row = await database
    .prepare(`SELECT ${AUDIO_ROW_COLUMNS} FROM meeting_audio_recordings WHERE capture_session_id = ?`)
    .get(captureSessionId);
  return normalizeAudioRow(row);
}

export async function getAudioRecordingById(id) {
  if (!id) return null;
  const database = await getDb();
  const row = await database
    .prepare(`SELECT ${AUDIO_ROW_COLUMNS} FROM meeting_audio_recordings WHERE id = ?`)
    .get(id);
  return normalizeAudioRow(row);
}

export async function listAudioRecordingsForMeeting(meetingId, db) {
  if (!meetingId) return [];
  const database = db ?? (await getDb());
  const rows = await database
    .prepare(`
      SELECT ${AUDIO_ROW_COLUMNS}
      FROM meeting_audio_recordings
      WHERE meeting_id = ?
      ORDER BY created_at ASC, id ASC
    `)
    .all(meetingId);
  return rows.map(normalizeAudioRow);
}

/**
 * 会话终态（finish / fail / 断连 close 三处都会调，必须幂等）。
 * 有字节 → 保持 recording（pcm 已落盘、mp3 待转码），无字节/写失败 → failed。
 */
export async function finishAudioRecording(input) {
  const existing = await getAudioRecording(input?.captureSessionId);
  if (!existing) return null;

  const bytes = Number(input?.bytes ?? 0);
  const durationSeconds = Number(input?.durationSeconds ?? 0);
  const hasAudio = Boolean(input?.ok) && bytes > 0;
  const status = hasAudio ? "recording" : "failed";
  const errorMessage = hasAudio
    ? null
    : String(input?.errorMessage || "no audio data recorded");

  const database = await getDb();
  await database
    .prepare(`
      UPDATE meeting_audio_recordings
      SET raw_file_path = ?, bytes = ?, duration_seconds = ?, status = ?,
          error_message = ?, updated_at = ?
      WHERE capture_session_id = ?
    `)
    .run(
      input?.rawFilePath ?? existing.rawFilePath,
      bytes,
      durationSeconds,
      status,
      errorMessage,
      nowIso(),
      input.captureSessionId
    );

  return getAudioRecording(input.captureSessionId);
}

export async function markAudioRecordingReady(input) {
  const database = await getDb();
  await database
    .prepare(`
      UPDATE meeting_audio_recordings
      SET file_path = ?, bytes = ?, duration_seconds = ?, status = 'ready',
          bitrate_kbps = ?, raw_file_path = NULL, error_message = NULL, updated_at = ?
      WHERE capture_session_id = ?
    `)
    .run(
      input.filePath,
      Number(input.bytes ?? 0),
      Number(input.durationSeconds ?? 0),
      Number(input.bitrateKbps ?? AUDIO_DEFAULT_BITRATE_KBPS),
      nowIso(),
      input.captureSessionId
    );
  return getAudioRecording(input.captureSessionId);
}

export async function markAudioRecordingFailed(input) {
  const database = await getDb();
  await database
    .prepare(`
      UPDATE meeting_audio_recordings
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE capture_session_id = ?
    `)
    .run(String(input.errorMessage || "transcode failed").slice(0, 2000), nowIso(), input.captureSessionId);
  return getAudioRecording(input.captureSessionId);
}

/**
 * 会议落定时把录音绑定到会议：meeting_id 写上、expires_at 置 NULL（永久）。
 * 同时接受单数 captureSessionId（旧前端）与复数 captureSessionIds，取并集去重。
 */
export async function bindAudioRecordingsToMeeting(input, db) {
  const ids = collectCaptureSessionIds(input);
  if (ids.length === 0) return [];

  const database = db ?? (await getDb());
  const updatedAt = nowIso();
  const statement = database.prepare(`
    UPDATE meeting_audio_recordings
    SET meeting_id = ?, expires_at = NULL, updated_at = ?
    WHERE capture_session_id = ?
  `);
  for (const captureSessionId of ids) {
    await statement.run(input.meetingId, updatedAt, captureSessionId);
  }
  return listAudioRecordingsForMeeting(input.meetingId, db);
}

/** 单数/复数入参归一：去空、去重、保持首次出现顺序。 */
export function collectCaptureSessionIds(input) {
  const candidates = [];
  if (Array.isArray(input?.captureSessionIds)) {
    for (const value of input.captureSessionIds) candidates.push(value);
  }
  if (input?.captureSessionId) candidates.push(input.captureSessionId);

  const seen = new Set();
  const ids = [];
  for (const candidate of candidates) {
    const id = String(candidate ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function removeAudioFile(storedPath) {
  if (!storedPath) return 0;
  try {
    const absolutePath = resolveStoredPath(storedPath);
    if (!absolutePath || !existsSync(absolutePath)) return 0;
    unlinkSync(absolutePath);
    return 1;
  } catch (error) {
    console.error("[Audio Store] failed to remove audio file:", storedPath, error);
    return 0;
  }
}

/** 删除磁盘文件（row 的 mp3 + 残留 pcm）。供事务提交后调用。 */
export function removeAudioFilesForRows(rows) {
  let files = 0;
  for (const row of rows ?? []) {
    files += removeAudioFile(row.filePath);
    files += removeAudioFile(row.rawFilePath);
  }
  return { files };
}

/** 只删行，返回被删行（文件由调用方在事务提交后删，避免回滚丢文件）。 */
export async function deleteAudioRecordingRowsForMeeting(meetingId, db) {
  if (!meetingId) return [];
  const rows = await listAudioRecordingsForMeeting(meetingId, db);
  if (rows.length === 0) return [];
  const database = db ?? (await getDb());
  await database
    .prepare("DELETE FROM meeting_audio_recordings WHERE meeting_id = ?")
    .run(meetingId);
  return rows;
}

/**
 * 孤儿录音清理：meeting_id IS NULL 且 expires_at 已过期 → 删行 + 删文件
 * （raw 与 mp3 都删）。已绑定会议的 expires_at 为 NULL，永远不在此集合里。
 */
export async function cleanupExpiredAudioRecordings() {
  const database = await getDb();
  const now = nowIso();
  const rows = (
    await database
      .prepare(`
        SELECT ${AUDIO_ROW_COLUMNS}
        FROM meeting_audio_recordings
        WHERE meeting_id IS NULL AND expires_at IS NOT NULL AND expires_at < ?
      `)
      .all(now)
  ).map(normalizeAudioRow);

  if (rows.length === 0) return { rows: 0, files: 0 };

  await database
    .prepare("DELETE FROM meeting_audio_recordings WHERE meeting_id IS NULL AND expires_at IS NOT NULL AND expires_at < ?")
    .run(now);

  const { files } = removeAudioFilesForRows(rows);
  return { rows: rows.length, files };
}
