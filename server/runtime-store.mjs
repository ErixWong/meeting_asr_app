import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { initializeDatabase } from "./database-schema.mjs";

const dataDir = join(process.cwd(), "data");
const dbPath = join(dataDir, "meeting-asr-app.db");

let db = null;
const MAX_CAPTURE_EVENTS = 10000;
const MAX_CAPTURE_EVENT_CHARS = 512 * 1024;
const MAX_CAPTURE_EVENT_CHARS_TOTAL = 8 * 1024 * 1024;
const ASR_GATEWAY_ROLE_KEYS = new Set(["user", "system_admin"]);

function nowIso() {
  return new Date().toISOString();
}

function getDb() {
  if (db) return db;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  seedAsrDefaults();
  return db;
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

export function getAsrRuntimeConfig() {
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
}

export function appendCaptureEvent(captureSessionId, event) {
  const database = getDb();
  const eventJson = JSON.stringify(event);
  if (typeof eventJson !== "string" || eventJson.length > MAX_CAPTURE_EVENT_CHARS) return false;

  database.exec("BEGIN IMMEDIATE");
  try {
    const session = database
      .prepare("SELECT expires_at as expiresAt FROM asr_capture_sessions WHERE capture_session_id = ?")
      .get(captureSessionId);
    if (!session || String(session.expiresAt) < nowIso()) {
      database.exec("ROLLBACK");
      return false;
    }

    const limits = database
      .prepare(`
        SELECT
          COUNT(*) as eventCount,
          COALESCE(SUM(length(event_json)), 0) as eventChars
        FROM asr_capture_events
        WHERE capture_session_id = ?
      `)
      .get(captureSessionId);
    if (Number(limits.eventCount) >= MAX_CAPTURE_EVENTS) {
      database.exec("ROLLBACK");
      return false;
    }
    if (Number(limits.eventChars) + eventJson.length > MAX_CAPTURE_EVENT_CHARS_TOTAL) {
      database.exec("ROLLBACK");
      return false;
    }

    const nextSequence = Number(
      database
        .prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 as nextSequence FROM asr_capture_events WHERE capture_session_id = ?")
        .get(captureSessionId)?.nextSequence ?? 1
    );
    const receivedAt = nowIso();
    database
      .prepare(`
        INSERT INTO asr_capture_events (
          id, capture_session_id, sequence_no, event_json, received_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(`${captureSessionId}-${nextSequence}`, captureSessionId, nextSequence, eventJson, receivedAt);

    database
      .prepare(`
        UPDATE asr_capture_sessions
        SET updated_at = ?
        WHERE capture_session_id = ?
      `)
      .run(receivedAt, captureSessionId);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original database error if rollback itself fails.
    }
    throw error;
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
