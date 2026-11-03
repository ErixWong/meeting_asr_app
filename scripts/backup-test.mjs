/**
 * 备份脚本单测（fix-261104-01 / issue #56，node --test）
 *
 * 全部在 os.tmpdir() 沙箱里跑：临时库、临时备份目录、临时音频目录，**绝不碰生产库**。
 * 钉住工单 §3 的 6 条 + 幂等 1 条：
 *   1. VACUUM INTO 产物 integrity_check = ok，且**内容可读**（能查到写入的行）
 *   2. 保留策略：16 份 → 留最新 14 份，删掉 2 份最旧
 *   3. KEEP=0 语义 = 只增不删
 *   4. 失败路径：备份目录创建失败 ⇒ RESULT: FAIL + 退出码 1 + 不留 0 字节假备份、不留 .tmp；
 *      完整性校验失败（DB_BACKUP_FAULT=integrity 注入）⇒ 不 rename 成正式备份
 *   5. 备份期间并发写入不失败（另一个连接持续 INSERT，验证 busy_timeout）
 *   6. DB_TYPE=mssql ⇒ 明确拒绝（退出码 1，不许静默成功）
 *   7. 幂等：同一秒内重复运行不覆盖已有好备份（加序号）
 *
 * 运行：npm run test:backup（= node --test scripts/backup-test.mjs）
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const sandbox = mkdtempSync(join(tmpdir(), "backup-test-"));
process.chdir(sandbox);

const scriptPath = new URL("./db-backup.mjs", import.meta.url).pathname;
const { pruneBackups, listBackups, parseBackupName, formatStamp } = await import(
  new URL("./db-backup.mjs", import.meta.url).href
);

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let seq = 0;
function sandboxDir(label) {
  seq += 1;
  const dir = join(sandbox, `${seq}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 造一个 WAL 模式的临时库并写入 rows 行 */
function makeDb(dbPath, rows = 3) {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT)");
    for (let i = 0; i < rows; i += 1) {
      db.prepare("INSERT OR REPLACE INTO meetings (id, title) VALUES (?, ?)").run(`m-${i}`, `会议 ${i}`);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function runCli(env, extraArgs = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: sandbox,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = result.stdout || "";
  const resultLine = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("RESULT:"))
    .pop();
  return { status: result.status, stdout, stderr: result.stderr || "", resultLine };
}

/** 解析 `RESULT: OK k=v ...` 为对象 */
function parseResultLine(line) {
  const fields = {};
  for (const part of line.replace(/^RESULT:\s*/, "").split(/\s+/).slice(1)) {
    const idx = part.indexOf("=");
    if (idx > 0) fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return fields;
}

function integrityOf(filePath) {
  const probe = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return probe.pragma("integrity_check")[0].integrity_check;
  } finally {
    probe.close();
  }
}

// ---------------------------------------------------------------------------
// 1. 产物完整性 + 内容可读
// ---------------------------------------------------------------------------

test("1. VACUUM INTO 产物 integrity_check=ok 且内容可读（WAL 库未 checkpoint 的写入也在）", () => {
  const dir = sandboxDir("content");
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 5);
  const out = join(dir, "backups");

  const run = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: out, DB_AUDIO_DIR: join(dir, "audio") });

  assert.equal(run.status, 0, `退出码应为 0，stderr=${run.stderr}`);
  assert.match(run.resultLine, /^RESULT: OK file=.* integrity=ok /);
  const fields = parseResultLine(run.resultLine);
  assert.ok(existsSync(fields.file), `备份文件应存在: ${fields.file}`);
  assert.ok(Number(fields.bytes) > 0, `bytes 应 > 0，实际 ${fields.bytes}`);
  assert.equal(Number(fields.bytes), statSync(fields.file).size);

  assert.equal(integrityOf(fields.file), "ok");

  const backup = new Database(fields.file, { readonly: true, fileMustExist: true });
  try {
    const count = backup.prepare("SELECT COUNT(*) AS c FROM meetings").get().c;
    assert.equal(count, 5, "备份里应能读到写入的 5 行");
    const first = backup.prepare("SELECT title FROM meetings WHERE id = ?").get("m-0");
    assert.equal(first.title, "会议 0");
  } finally {
    backup.close();
  }

  // 备份目录里不应残留 .tmp
  assert.deepEqual(
    readdirSync(out).filter((name) => name.endsWith(".tmp")),
    []
  );
});

// ---------------------------------------------------------------------------
// 2. 保留策略：16 → 14，删最旧 2 份
// ---------------------------------------------------------------------------

test("2. 保留策略：16 份 → 留最新 14 份，删掉 2 份最旧", () => {
  const dir = sandboxDir("retain");
  const prefix = "meeting-asr-app";

  // 造 16 份「旧备份」：时间戳逐秒递增，最旧两份是 stamps[0] / stamps[1]
  const stamps = [];
  for (let i = 0; i < 16; i += 1) {
    const d = new Date(Date.UTC(2026, 10, 3, 0, 0, i)); // 递增秒
    stamps.push(formatStamp(d));
  }
  const files = stamps.map((stamp, i) => {
    const name = `${prefix}-${stamp}.db`;
    writeFileSync(join(dir, name), `old-${i}`);
    return name;
  });
  assert.equal(listBackups(dir, prefix).length, 16);

  const pruned = pruneBackups(dir, prefix, 14);

  assert.equal(pruned.removed.length, 2, `应删 2 份，实际 ${pruned.removed.length}`);
  assert.equal(pruned.kept, 14);
  assert.deepEqual(pruned.removed, [files[0], files[1]], "删掉的必须是最旧的两份");
  assert.equal(listBackups(dir, prefix).length, 14);
  assert.ok(!existsSync(join(dir, files[0])), "最旧一份应已删除");
  assert.ok(!existsSync(join(dir, files[1])), "第二旧一份应已删除");
  assert.ok(existsSync(join(dir, files[15])), "最新一份必须保留");

  // CLI 侧：再跑一次备份（14 + 1 = 15 份）后仍收敛到 14 份，并在 RESULT 行报 kept/removed
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 2);
  const run = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: dir, DB_BACKUP_KEEP: "14" });
  assert.equal(run.status, 0, run.stderr);
  const fields = parseResultLine(run.resultLine);
  assert.equal(fields.kept, "14", `kept 应为 14，实际 ${fields.kept}`);
  assert.equal(fields.removed, "1", `removed 应为 1，实际 ${fields.removed}`);
  assert.equal(listBackups(dir, prefix).length, 14);
});

// ---------------------------------------------------------------------------
// 3. KEEP=0 = 只增不删
// ---------------------------------------------------------------------------

test("3. DB_BACKUP_KEEP=0 = 不做清理（只增不删）", () => {
  const dir = sandboxDir("keep0");
  const prefix = "meeting-asr-app";
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 2);

  for (let i = 0; i < 20; i += 1) {
    const stamp = formatStamp(new Date(Date.UTC(2026, 9, 1, 0, 0, i)));
    writeFileSync(join(dir, `${prefix}-${stamp}.db`), `old-${i}`);
  }
  assert.equal(listBackups(dir, prefix).length, 20);

  const pruned = pruneBackups(dir, prefix, 0);
  assert.deepEqual(pruned.removed, [], "KEEP=0 不许删任何文件");
  assert.equal(pruned.kept, 20);
  assert.equal(listBackups(dir, prefix).length, 20);

  // CLI 侧：KEEP=0 时新增一份、一份不删
  const run = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: dir, DB_BACKUP_KEEP: "0" });
  assert.equal(run.status, 0, run.stderr);
  const fields = parseResultLine(run.resultLine);
  assert.equal(fields.removed, "0", "KEEP=0 时 removed 必须为 0");
  assert.equal(fields.kept, "21", `KEEP=0 时 kept 应为 21，实际 ${fields.kept}`);
  assert.equal(listBackups(dir, prefix).length, 21);
});

// ---------------------------------------------------------------------------
// 4. 失败路径
// ---------------------------------------------------------------------------

test("4a. 备份目录创建失败 ⇒ RESULT: FAIL + 退出码 1 + 不留 0 字节假备份、不留 .tmp", () => {
  const dir = sandboxDir("faildir");
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 2);
  // 让「目录」的父级是个普通文件 ⇒ mkdir -p 必然 ENOTDIR
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  const badDir = join(blocker, "backups");

  const run = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: badDir });

  assert.equal(run.status, 1, `退出码必须为 1，实际 ${run.status}`);
  assert.equal(run.resultLine, "RESULT: FAIL code=backup_dir_create_failed");
  assert.ok(!existsSync(badDir), "失败后不应留下备份目录");

  // 目录里不能冒出任何像备份/临时文件的东西
  const leftovers = readdirSync(dir).filter((name) => name.endsWith(".db") || name.endsWith(".tmp"));
  assert.deepEqual(leftovers, ["meeting-asr-app.db"], `只应有源库，实际 ${leftovers.join(",")}`);
  assert.equal(statSync(dbPath).size > 0, true, "源库不能被破坏");
});

test("4b. 完整性校验不通过 ⇒ 不 rename 成正式备份（不留假备份、不留 .tmp）", () => {
  const dir = sandboxDir("failintegrity");
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 2);
  const out = join(dir, "backups");

  // DB_BACKUP_FAULT=integrity：注入「校验失败」，验证「校验通过才 rename」这道闸门真的在
  const run = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: out, DB_BACKUP_FAULT: "integrity" });

  assert.equal(run.status, 1, `退出码必须为 1，实际 ${run.status}`);
  assert.equal(run.resultLine, "RESULT: FAIL code=integrity_failed");
  assert.deepEqual(readdirSync(out), [], "校验失败后备份目录必须为空（无正式文件、无 .tmp）");
});

// ---------------------------------------------------------------------------
// 5. 并发写入
// ---------------------------------------------------------------------------

test("5. 备份期间并发写入不失败（busy_timeout 生效，双方都不报错）", async () => {
  const dir = sandboxDir("concurrent");
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 50);
  const out = join(dir, "backups");

  const writer = new Database(dbPath);
  writer.pragma("busy_timeout = 5000");
  let written = 0;
  const writing = (async () => {
    for (let i = 0; i < 200; i += 1) {
      writer.prepare("INSERT OR REPLACE INTO meetings (id, title) VALUES (?, ?)").run(`w-${i}`, `写入 ${i}`);
      written += 1;
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  })();

  const child = spawn(process.execPath, [scriptPath], {
    cwd: sandbox,
    env: { ...process.env, SQLITE_PATH: dbPath, DB_BACKUP_DIR: out },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  await writing;
  writer.close();

  assert.equal(exitCode, 0, `备份应与并发写共存（退出码 ${exitCode}），stderr=${stderr}`);
  assert.match(stdout, /RESULT: OK .* integrity=ok /);
  assert.ok(written >= 200, `并发写入应全部完成，实际 ${written}`);

  const files = readdirSync(out).filter((name) => name.endsWith(".db"));
  assert.equal(files.length, 1);
  assert.equal(integrityOf(join(out, files[0])), "ok");
  const backup = new Database(join(out, files[0]), { readonly: true, fileMustExist: true });
  try {
    const rows = backup.prepare("SELECT COUNT(*) AS c FROM meetings").get().c;
    assert.ok(rows >= 50, `备份内容应是完整快照（至少 50 行），实际 ${rows}`);
  } finally {
    backup.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 非 sqlite 明确拒绝
// ---------------------------------------------------------------------------

test("6. DB_TYPE=mssql ⇒ 明确拒绝，退出码 1（不许静默成功）", () => {
  const dir = sandboxDir("mssql");
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 2);
  const out = join(dir, "backups");

  // 故意给一个**完全合法**的 sqlite 环境：删掉守卫的话脚本会一路成功 ⇒ 测试必须 FAIL
  const run = runCli({ DB_TYPE: "mssql", SQLITE_PATH: dbPath, DB_BACKUP_DIR: out });

  assert.equal(run.status, 1, `退出码必须为 1，实际 ${run.status}`);
  assert.equal(run.resultLine, "RESULT: FAIL code=unsupported_db_type");
  assert.match(run.stderr, /#55|备份方式分叉/);
  assert.ok(!existsSync(out), "拒绝时不应创建备份目录");
});

// ---------------------------------------------------------------------------
// 7. 幂等：同一秒重复运行不覆盖
// ---------------------------------------------------------------------------

test("7. 同一秒内重复运行不覆盖已有备份（加序号）", () => {
  const dir = sandboxDir("idempotent");
  const dbPath = makeDb(join(dir, "meeting-asr-app.db"), 2);
  const out = join(dir, "backups");

  const first = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: out });
  assert.equal(first.status, 0, first.stderr);
  const firstFile = parseResultLine(first.resultLine).file;

  // 把第一份备份的 mtime 挪到「未来」，确保第二份的「同秒」判定不依赖真实时钟
  const future = new Date(Date.now() + 60_000);
  utimesSync(firstFile, future, future);

  const second = runCli({ SQLITE_PATH: dbPath, DB_BACKUP_DIR: out });
  assert.equal(second.status, 0, second.stderr);
  const secondFile = parseResultLine(second.resultLine).file;

  assert.notEqual(secondFile, firstFile, "第二份备份不能覆盖第一份");
  assert.ok(existsSync(firstFile), "第一份备份必须还在");
  assert.ok(existsSync(secondFile), "第二份备份必须存在");
  assert.equal(integrityOf(firstFile), "ok");
  assert.equal(integrityOf(secondFile), "ok");

  // 命名仍可被保留策略识别（前缀 + 时间戳 + 可选序号）
  assert.equal(parseBackupName(secondFile.split("/").pop(), "meeting-asr-app") !== null, true);
});
