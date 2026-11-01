/**
 * 数据库入口（生产唯一入口）
 *
 * issue #54（PR-B②）：运行时不再走 legacy 的 `node:sqlite` 同步驱动，而是
 * `getKnex()`（better-sqlite3 / mysql2 / tedious）+ `AsyncDb`（Promise 化）。
 * 方言由 `DB_TYPE` 决定（默认 sqlite），连接参数见 `server/db/index.mjs`。
 *
 * 形态变化（调用方需要跟着改）：
 *   旧：const db = getDb();  db.prepare(sql).all()      （同步）
 *   新：const db = await getDb();  await db.prepare(sql).all()   （异步）
 *
 * 初始化（建表 + 迁移 + 索引）由 `server/db/schema.mjs` 的 `initializeSchema()`
 * 承担，single-flight（同一 AsyncDb 实例上并发调用共享同一个 in-flight promise）。
 * legacy 的 `server/database-schema.mjs`（手写 DDL + 迁移）已在本单退役。
 */
import { AsyncDb } from "./db/async-db.mjs";
import { closeKnex, getKnex, getDbType, sqliteFilePath } from "./db/index.mjs";
import { initializeSchema } from "./db/schema.mjs";

/**
 * 初始化 single-flight 挂在 globalThis 上，而不是模块作用域。
 *
 * 为什么：生产是**一个进程两个模块图** —— `server/app-server.mjs`（node 侧）与 Next
 * 打包出来的服务端代码各自 import 一份本模块，两个模块作用域互不可见。若只在模块
 * 作用域里做 single-flight，两边会在同一秒各自建表/跑迁移，knex 的
 * `hasTable()` + `CREATE TABLE` 不是原子操作，会撞 `table ... already exists`。
 * 挂到 globalThis 后两个模块图共享同一个初始化 promise，第二个图等第一个跑完再用
 * 自己的 knex 句柄（knex 实例仍然各自独立，不共享连接池）。
 */
const globalForDb = globalThis;

/**
 * 取数据库句柄（单例，首次调用时初始化 schema）。
 *
 * 失败时清掉缓存的 promise，允许下一次调用重试（与 legacy「初始化成功才缓存句柄」
 * 一致）；并发首调共享同一个初始化 promise，不会重复跑迁移。
 */
export function getDb() {
  if (!globalForDb.__meetingAsrDbPromise) {
    globalForDb.__meetingAsrDbPromise = openDatabase().catch((error) => {
      globalForDb.__meetingAsrDbPromise = undefined;
      throw error;
    });
  }
  return globalForDb.__meetingAsrDbPromise;
}

async function openDatabase() {
  const dbType = getDbType();
  const db = new AsyncDb(getKnex(), dbType);
  await applySqlitePragmas(db);
  await initializeSchema(db);
  return db;
}

/**
 * SQLite 专属 PRAGMA：**只在 DB_TYPE=sqlite 时下发**。
 *
 * mysql / mssql 没有 `PRAGMA` 语法（实测 mssql 报 `Incorrect syntax near 'PRAGMA'`），
 * 所以这条 `dbType` 判断是必需的，不是优化。
 *
 * `PRAGMA journal_mode = WAL` 的返回值要复核：Docker Desktop 的 bind mount 上
 * WAL 不可用，此时必须**显式告警**（保留 legacy 的原文案），不许静默降级。
 */
async function applySqlitePragmas(db) {
  if (db.dbType !== "sqlite") return;

  await db.prepare("PRAGMA foreign_keys = ON").run();
  await db.prepare("PRAGMA busy_timeout = 5000").run();

  const row = await db.prepare("PRAGMA journal_mode = WAL").get();
  const mode = String(row?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    console.error(
      `[DB] WAL mode unavailable (journal_mode=${mode || "unknown"}). ` +
        "If running under Docker Desktop bind mount, switch data dir to a named volume and restart."
    );
  } else {
    console.log(`[DB] SQLite ready: ${sqliteFilePath()} (journal_mode=${mode})`);
  }
}

/**
 * 关闭连接池并清空单例缓存（脚本 / 优雅退出用）。
 *
 * 为什么必须有：better-sqlite3 / mysql2 / tedious 的连接池会一直持有句柄，
 * 脚本跑完不 destroy 就不会自己退出（`node scripts/db-smoke.mjs` 会挂住，靠外部
 * kill 才结束）。生产进程不需要调它（进程退出即释放），但**所有脚本入口必须调**。
 */
export async function closeDb() {
  const pending = globalForDb.__meetingAsrDbPromise;
  globalForDb.__meetingAsrDbPromise = undefined;
  if (pending) {
    await pending.catch(() => undefined);
  }
  await closeKnex();
}

/** 审计日志保留清理（定时任务调用） */
export async function cleanupExpiredAuditLogs(retentionDays = 30) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const db = await getDb();
  const result = await db.prepare("DELETE FROM audit_logs WHERE created_at < ?").run(cutoff);
  return Number(result.changes ?? 0);
}
