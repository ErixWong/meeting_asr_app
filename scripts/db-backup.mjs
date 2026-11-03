#!/usr/bin/env node
/**
 * SQLite 在线备份脚本（fix-261104-01 / issue #56）
 *
 * 为什么不能用 `cp`：生产库是 **WAL** 模式（同目录有 `-wal` / `-shm`），
 * 直接 `cp meeting-asr-app.db` 会漏掉 WAL 里未 checkpoint 的事务 ⇒ 拿到不一致快照。
 * 本脚本用 `VACUUM INTO`（SQLite 3.27+，本机 3.53.4）让 **SQLite 自己**导出一份
 * 事务一致的完整副本，再用 `PRAGMA integrity_check` 验，验过才改名成正式备份。
 *
 * 流程（顺序即安全边界，别调换）：
 *   1. DB_TYPE != sqlite ⇒ 明确拒绝（`RESULT: FAIL code=unsupported_db_type`，退出码 1）。
 *      **不静默跳过**：跳过会被 cron 当成「今天备份成功」。
 *   2. 目标目录 `DB_BACKUP_DIR`（默认 `/app/data/backups`；宿主等价 `.docker/data/backups`，
 *      compose 已把 `./.docker/data` 挂到 `/app/data` ⇒ 零 compose 改动），不存在则创建。
 *   3. `better-sqlite3` 打开生产库，**先 `PRAGMA busy_timeout = 5000`**（独立进程、独立连接，
 *      不继承应用侧的 busy_timeout）。
 *   4. `VACUUM INTO '<dir>/.<name>.tmp'`（**先写临时名**）——半途失败的产物不能长得像一份好备份。
 *   5. `PRAGMA integrity_check`（只读、也是 `better-sqlite3`；⚠ 同一库文件禁止混用
 *      `node:sqlite` 与 `better-sqlite3`，会 SQLITE_IOERR_SHORT_READ）必须返回 `ok`。
 *   6. 才 rename 成正式名 `<prefix>-YYYYMMDD-HHMMSS.db`（**固定 UTC+8**，与进程 TZ 无关，
 *      容器内 TZ=UTC 也不会把名字写成 UTC）。同一秒重复运行不覆盖已有备份，加序号 `-2`/`-3`。
 *   7. 保留 `DB_BACKUP_KEEP`（默认 14）份，按文件名里的时间戳 + 序号排序保留最新 N 份。
 *      **`KEEP=0` = 不做清理（只增不删）**，这是显式定义，测试里钉住了。
 *   8. 只读统计 `data/audio` 的字节数与文件数（不拷贝、不删除），供文档/运维看趋势。
 *   9. 收尾打**机器可读一行**：
 *      `RESULT: OK file=<path> bytes=<n> integrity=ok kept=<n> removed=<n> elapsed_ms=<n>`
 *      任何失败：`RESULT: FAIL code=<码>`，退出码 1（cron / 监控按退出码与非 OK 行告警）。
 *
 * 用法：
 *   node scripts/db-backup.mjs
 *   DB_BACKUP_DIR=/tmp/bk DB_BACKUP_KEEP=3 SQLITE_PATH=data/meeting-asr-app.db node scripts/db-backup.mjs
 *   DB_TYPE=mssql node scripts/db-backup.mjs      # ⇒ RESULT: FAIL code=unsupported_db_type，exit 1
 *
 * 环境变量：
 *   DB_TYPE            sqlite（默认）| mysql | mssql；非 sqlite 直接拒绝
 *   SQLITE_PATH        生产库路径，默认 <cwd>/data/meeting-asr-app.db
 *   DB_BACKUP_DIR      备份目录，默认 /app/data/backups
 *   DB_BACKUP_KEEP     保留份数，默认 14；0 = 只增不删
 *   DB_BACKUP_PREFIX   文件名前缀，默认取库文件名去掉 `.db`
 *   DB_AUDIO_DIR       音频目录（只统计），默认 <cwd>/data/audio
 *   DB_BACKUP_FAULT    仅供单测注入故障（"integrity" = 假装完整性校验失败），生产不要设
 *
 * ⚠ 备份文件里含 `app_settings.llm.api_key` 等**明文密钥**，备份目录必须按密钥对待。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const DEFAULT_BACKUP_DIR = "/app/data/backups";
const DEFAULT_KEEP = 14;
const BUSY_TIMEOUT_MS = 5000;
const STAMP_PATTERN = /^(\d{8})-(\d{6})(?:-(\d+))?$/;

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 配置解析（全部可 env 覆盖，便于单测指向临时目录）
// ---------------------------------------------------------------------------

export function resolveDbType() {
  return String(process.env.DB_TYPE || "sqlite").trim().toLowerCase();
}

export function resolveDbPath() {
  return process.env.SQLITE_PATH || join(process.cwd(), "data", "meeting-asr-app.db");
}

export function resolveBackupDir() {
  return process.env.DB_BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

export function resolveAudioDir() {
  return process.env.DB_AUDIO_DIR || join(process.cwd(), "data", "audio");
}

/** 返回保留份数；非法值返回 NaN（调用方据此报 invalid_keep） */
export function resolveKeep() {
  const raw = process.env.DB_BACKUP_KEEP;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_KEEP;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) return Number.NaN;
  return value;
}

export function resolvePrefix(dbPath) {
  if (process.env.DB_BACKUP_PREFIX) return process.env.DB_BACKUP_PREFIX;
  const base = basename(dbPath);
  return base.toLowerCase().endsWith(".db") ? base.slice(0, -3) : base;
}

// ---------------------------------------------------------------------------
// 时间戳 / 文件名
// ---------------------------------------------------------------------------

/**
 * 固定 UTC+8 的 `YYYYMMDD-HHMMSS`。
 * 刻意不用 `toLocaleString()` / `new Date().getHours()`：容器内 TZ 通常是 UTC，
 * 那样文件名会比本机时间（UTC+8）慢 8 小时，运维对不上「今天那份」。
 */
export function formatStamp(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
  const iso = shifted.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ（已偏移 ⇒ 取字面量）
  const day = iso.slice(0, 10).replace(/-/g, "");
  const clock = iso.slice(11, 19).replace(/:/g, "");
  return `${day}-${clock}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析备份文件名 → { stamp, seq }；不是本脚本命名的返回 null */
export function parseBackupName(name, prefix) {
  if (!name.startsWith(`${prefix}-`) || !name.endsWith(".db")) return null;
  const middle = name.slice(prefix.length + 1, -3);
  const matched = STAMP_PATTERN.exec(middle);
  if (!matched) return null;
  return { stamp: `${matched[1]}-${matched[2]}`, seq: matched[3] ? Number(matched[3]) : 1 };
}

/**
 * 列出目录里本脚本命名的备份，按（时间戳, 序号）升序 —— 最后一项是最新。
 * 排序刻意不直接用字符串比较：`...-031520.db` 与 `...-031520-2.db` 的
 * `'.'`(0x2E) > `'-'`(0x2D)，纯字典序会把「序号备份」错判成更旧。
 */
export function listBackups(dir, prefix) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseBackupName(name, prefix);
    if (!parsed) continue;
    entries.push({ name, ...parsed });
  }
  entries.sort((a, b) => {
    if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
    return a.seq - b.seq;
  });
  return entries;
}

/**
 * 保留最新 `keep` 份，删更旧的。
 * keep <= 0 ⇒ **不做清理**（0 = 只增不删，显式语义），返回 removed: []。
 */
export function pruneBackups(dir, prefix, keep) {
  const all = listBackups(dir, prefix);
  if (keep <= 0) return { kept: all.length, removed: [] };
  if (all.length <= keep) return { kept: all.length, removed: [] };
  const stale = all.slice(0, all.length - keep);
  const removed = [];
  for (const entry of stale) {
    try {
      rmSync(join(dir, entry.name), { force: true });
      removed.push(entry.name);
    } catch (error) {
      console.error(`[backup] 删除旧备份失败 ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kept: all.length - removed.length, removed };
}

/** 只读统计目录用量（递归，不跟随符号链接以外的花活；失败只降级为 0） */
export function collectAudioUsage(dir) {
  const usage = { dir, files: 0, bytes: 0 };
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          usage.bytes += statSync(full).size;
          usage.files += 1;
        } catch {
          /* 统计不上就算了，不影响备份 */
        }
      }
    }
  };
  walk(dir);
  return usage;
}

// ---------------------------------------------------------------------------
// 备份主体
// ---------------------------------------------------------------------------

function uniqueFinalPath(dir, prefix, stamp) {
  let candidate = join(dir, `${prefix}-${stamp}.db`);
  let seq = 1;
  while (existsSync(candidate)) {
    seq += 1;
    candidate = join(dir, `${prefix}-${stamp}-${seq}.db`);
  }
  return candidate;
}

function verifyIntegrity(filePath) {
  const probe = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const rows = probe.pragma("integrity_check");
    const value = Array.isArray(rows) && rows.length > 0 ? Object.values(rows[0])[0] : undefined;
    return String(value ?? "unknown");
  } finally {
    probe.close();
  }
}

/**
 * 跑一次备份。成功返回 { file, bytes, kept, removed, elapsedMs, audio }；
 * 失败抛 BackupError（code 即 RESULT 行里的码），且**保证不留 tmp、不留假备份**。
 */
export function runBackup(options = {}) {
  const startedAt = Date.now();
  const dbPath = options.dbPath || resolveDbPath();
  const dir = options.backupDir || resolveBackupDir();
  const prefix = options.prefix || resolvePrefix(dbPath);
  const keep = options.keep ?? resolveKeep();
  const now = options.now instanceof Date ? options.now : new Date();

  if (!Number.isInteger(keep) || keep < 0) {
    throw new BackupError("invalid_keep", `DB_BACKUP_KEEP 必须是非负整数，实际为 ${process.env.DB_BACKUP_KEEP}`);
  }
  if (!existsSync(dbPath)) {
    throw new BackupError("db_missing", `生产库不存在: ${dbPath}`);
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new BackupError(
      "backup_dir_create_failed",
      `备份目录不可用: ${dir}（${error instanceof Error ? error.message : String(error)}）`
    );
  }

  const stamp = formatStamp(now);
  const tmpPath = join(dir, `.${prefix}-${stamp}.tmp`);
  rmSync(tmpPath, { force: true }); // 清掉上次崩溃残留，避免 VACUUM INTO 撞「文件已存在」

  let db;
  try {
    db = new Database(dbPath);
  } catch (error) {
    throw new BackupError("db_open_failed", `打开生产库失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    // 独立进程的独立连接：busy_timeout 不会从应用侧继承，必须自己设
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    try {
      db.prepare("VACUUM INTO ?").run(tmpPath);
    } catch (error) {
      throw new BackupError("vacuum_failed", `VACUUM INTO 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    db.close();
  }

  // 走到这里 tmp 已存在；后续任何失败都要把 tmp 清掉，不能留半成品
  try {
    if (!existsSync(tmpPath)) {
      throw new BackupError("vacuum_failed", `VACUUM INTO 未产生文件: ${tmpPath}`);
    }
    const tmpBytes = statSync(tmpPath).size;
    if (tmpBytes === 0) {
      throw new BackupError("vacuum_empty", `VACUUM INTO 产物为 0 字节: ${tmpPath}`);
    }

    let integrity = verifyIntegrity(tmpPath);
    // 故障注入（仅单测用，见文件头 env 说明）：让「校验通过才 rename」这条闸门可被验证
    if (process.env.DB_BACKUP_FAULT === "integrity") integrity = "corrupt (injected by DB_BACKUP_FAULT)";
    if (integrity !== "ok") {
      throw new BackupError("integrity_failed", `备份完整性校验未通过: ${integrity}`);
    }

    const finalPath = uniqueFinalPath(dir, prefix, stamp);
    try {
      renameSync(tmpPath, finalPath);
    } catch (error) {
      throw new BackupError("rename_failed", `重命名失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    const pruned = pruneBackups(dir, prefix, keep);
    for (const name of pruned.removed) {
      console.log(`[backup] 删除旧备份 ${name}（保留 ${keep} 份）`);
    }

    return {
      file: finalPath,
      bytes: statSync(finalPath).size,
      kept: pruned.kept,
      removed: pruned.removed.length,
      elapsedMs: Date.now() - startedAt,
      audio: collectAudioUsage(options.audioDir || resolveAudioDir()),
    };
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function emit(line) {
  process.stdout.write(`${line}\n`);
}

function main() {
  const dbType = resolveDbType();
  if (dbType !== "sqlite") {
    // 明确拒绝：静默跳过会被 cron 当成「今天备份成功」
    console.error(
      `[backup] 拒绝执行：DB_TYPE=${dbType}，本脚本只处理 SQLite。` +
        "MSSQL/MySQL 备份方式分叉（原生 BACKUP DATABASE / mysqldump），见 issue #55 与 docs/deployment-guide.md §5。"
    );
    emit("RESULT: FAIL code=unsupported_db_type");
    process.exit(1);
  }

  let result;
  try {
    result = runBackup();
  } catch (error) {
    const code = error instanceof BackupError ? error.code : "unexpected_error";
    console.error(`[backup] 失败(${code}): ${error instanceof Error ? error.message : String(error)}`);
    emit(`RESULT: FAIL code=${code}`);
    process.exit(1);
  }

  console.log(
    `[backup] 音频用量（只统计不拷贝）: files=${result.audio.files} bytes=${result.audio.bytes} dir=${result.audio.dir}`
  );
  emit(
    `RESULT: OK file=${result.file} bytes=${result.bytes} integrity=ok ` +
      `kept=${result.kept} removed=${result.removed} elapsed_ms=${result.elapsedMs}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
