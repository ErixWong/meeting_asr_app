import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { initializeDatabase } from "./database-schema.mjs";

const dataDir = join(process.cwd(), "data");
const dbPath = join(dataDir, "meeting-asr-app.db");

let db = null;

export function getDb() {
  if (db) return db;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);
  initializeDatabase(db);

  const row = db.prepare("PRAGMA journal_mode = WAL").get();
  const mode = String(row?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    console.error(`[DB] WAL mode unavailable (journal_mode=${mode || "unknown"}). ` +
      "If running under Docker Desktop bind mount, switch data dir to a named volume and restart.");
  } else {
    console.log(`[DB] SQLite ready: ${dbPath} (journal_mode=${mode})`);
  }

  return db;
}

export function cleanupExpiredAuditLogs(retentionDays = 30) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = getDb()
    .prepare("DELETE FROM audit_logs WHERE created_at < ?")
    .run(cutoff);
  return Number(result.changes ?? 0);
}
