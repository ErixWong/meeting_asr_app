import { createHash } from "crypto";
import { getDb as getSharedDb } from "./db-shared.mjs";

const MAX_CAPTURE_EVENTS = 10000;
const MAX_CAPTURE_EVENT_CHARS = 512 * 1024;
const MAX_CAPTURE_EVENT_CHARS_TOTAL = 8 * 1024 * 1024;
const ASR_GATEWAY_ROLE_KEYS = new Set(["user", "system_admin"]);

let dbSeeded = false;

function nowIso() {
  return new Date().toISOString();
}

function getDb() {
  const database = getSharedDb();
  if (!dbSeeded) {
    dbSeeded = true;
    seedAsrDefaults();
  }
  return database;
}

function insertMissingSetting(section, mark, title, description, value) {
  getDb()
    .prepare(`
      INSERT INTO app_settings (item_section, item_mark, item_title, item_description, item_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_section, item_mark) DO NOTHING
    `)
    .run(section, mark, title, description, value, nowIso());
}

function seedAsrDefaults() {
  insertMissingSetting("asr", "provider", "ASR Provider", "当前 ASR 提供方", "local_funasr");
  insertMissingSetting("asr", "endpoint", "FunASR Endpoint", "FunASR 服务地址", "ws://funasr.local:10095/ws");
  insertMissingSetting("asr", "api_key", "ASR API Key", "DashScope API Key", "");
  insertMissingSetting("asr", "workspace_id", "ASR Workspace ID", "DashScope Workspace ID", "");
}

function settingValue(settings, section, mark) {
  return settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function authorizeAsrGatewaySession(sessionToken, devAccountName = "") {
  const normalizedToken = String(sessionToken || "").trim();
  const normalizedDevAccount = String(devAccountName || "").trim();
  if (!normalizedToken && !normalizedDevAccount) {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  const database = getDb();
  const session = normalizedToken
    ? database
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
    : database
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

  const roleKeys = database
    .prepare(`
      SELECT r.role_key as roleKey
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `)
    .all(session.userId)
    .map((row) => String(row.roleKey));

  if (!roleKeys.some((roleKey) => ASR_GATEWAY_ROLE_KEYS.has(roleKey))) {
    return { ok: false, status: 403, error: "ASR access is not allowed for this role" };
  }

  if (normalizedToken) {
    database
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

function loadAsrRuntimeConfig() {
  const database = getDb();
  const settings = database
    .prepare(`
      SELECT
        item_section as itemSection,
        item_mark as itemMark,
        item_value as itemValue
      FROM app_settings
    `)
    .all();

  const hotwordRows = database
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

export function getAsrRuntimeConfig() {
  if (!cachedRuntimeConfig) {
    cachedRuntimeConfig = loadAsrRuntimeConfig();
  }
  return cachedRuntimeConfig;
}

export function invalidateAsrRuntimeConfig() {
  cachedRuntimeConfig = null;
}

export function createCaptureSession(input) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  getDb()
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

let prepared = null;

function getPreparedStatements() {
  const database = getDb();
  if (prepared) return prepared;

  prepared = {
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

  return prepared;
}

function getQueueState(captureSessionId) {
  let state = pendingQueues.get(captureSessionId);
  if (state) return state;

  const session = getPreparedStatements().sessionExpires.get(captureSessionId);
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
export function appendCaptureEvent(captureSessionId, event) {
  const eventJson = JSON.stringify(event);
  if (typeof eventJson !== "string" || eventJson.length > MAX_CAPTURE_EVENT_CHARS) return false;

  const state = getQueueState(captureSessionId);
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

function flushQueueState(database, captureSessionId, state) {
  const events = state.events;
  state.events = [];
  state.bytes = 0;

  const statements = getPreparedStatements();

  database.exec("BEGIN IMMEDIATE");
  try {
    const session = statements.sessionExpires.get(captureSessionId);
    if (!session || String(session.expiresAt) < nowIso()) {
      database.exec("ROLLBACK");
      pendingQueues.delete(captureSessionId);
      captureStats.delete(captureSessionId);
      return 0;
    }

    let sequenceNo = Number(
      statements.nextSequence.get(captureSessionId)?.nextSequence ?? 1
    );
    for (const item of events) {
      statements.insertEvent.run(
        `${captureSessionId}-${sequenceNo}`,
        captureSessionId,
        sequenceNo,
        item.eventJson,
        item.receivedAt
      );
      sequenceNo++;
    }

    statements.updateSession.run(events[events.length - 1].receivedAt, captureSessionId);
    database.exec("COMMIT");
    return events.length;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error if rollback itself fails.
    }
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
export function flushCaptureEvents(captureSessionId) {
  const database = getDb();

  if (captureSessionId) {
    const state = pendingQueues.get(captureSessionId);
    if (!state || state.events.length === 0) return 0;
    return flushQueueState(database, captureSessionId, state);
  }

  let flushed = 0;
  for (const [sessionId, state] of pendingQueues) {
    if (state.events.length === 0) continue;
    flushed += flushQueueState(database, sessionId, state);
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
    try {
      flushCaptureEvents();
    } catch (error) {
      console.error("[Capture Store] timer flush failed:", error);
    }
  }, intervalMs);
  flushTimer.unref();
}

export function closeCaptureStore() {
  try {
    flushCaptureEvents();
  } catch (error) {
    console.error("[Capture Store] final flush failed:", error);
  }
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export function finishCaptureSession(captureSessionId, status = "completed") {
  getDb()
    .prepare(`
      UPDATE asr_capture_sessions
      SET status = ?, updated_at = ?
      WHERE capture_session_id = ?
    `)
    .run(status, nowIso(), captureSessionId);
}

export function cleanupExpiredCaptureSessions() {
  getDb()
    .prepare("DELETE FROM asr_capture_sessions WHERE expires_at < ?")
    .run(nowIso());
}
