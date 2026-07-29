import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const dataDir = join(process.cwd(), "data");
const dbPath = join(dataDir, "meeting-asr-app.db");

let db = null;

function nowIso() {
  return new Date().toISOString();
}

function getDb() {
  if (db) return db;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      item_section TEXT NOT NULL,
      item_mark TEXT NOT NULL,
      item_title TEXT NOT NULL,
      item_description TEXT NOT NULL DEFAULT '',
      item_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_section, item_mark)
    );

    CREATE TABLE IF NOT EXISTS asr_hotwords (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL UNIQUE,
      weight INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asr_capture_sessions (
      capture_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      asr_provider TEXT NOT NULL,
      asr_config_snapshot TEXT NOT NULL,
      hotwords_json TEXT NOT NULL,
      raw_events_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

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
        hotwords_json, raw_events_json, status, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capture_session_id) DO UPDATE SET
        task_id = excluded.task_id,
        asr_provider = excluded.asr_provider,
        asr_config_snapshot = excluded.asr_config_snapshot,
        hotwords_json = excluded.hotwords_json,
        raw_events_json = excluded.raw_events_json,
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
      "[]",
      "capturing",
      createdAt,
      createdAt,
      expiresAt
    );
}

export function appendCaptureEvent(captureSessionId, event) {
  const database = getDb();
  const row = database
    .prepare("SELECT raw_events_json as rawEventsJson FROM asr_capture_sessions WHERE capture_session_id = ?")
    .get(captureSessionId);

  if (!row) return;

  let events = [];
  try {
    events = JSON.parse(row.rawEventsJson || "[]");
  } catch {
    events = [];
  }

  events.push({
    receivedAt: nowIso(),
    event,
  });

  database
    .prepare(`
      UPDATE asr_capture_sessions
      SET raw_events_json = ?, updated_at = ?
      WHERE capture_session_id = ?
    `)
    .run(JSON.stringify(events), nowIso(), captureSessionId);
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
