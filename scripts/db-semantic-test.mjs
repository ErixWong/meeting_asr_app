/**
 * 方言语义锁测试（PR-B① / issue #53）
 *
 * 目的：把「换库会改变语义」的三件事用断言钉死，并在三种方言目标上各跑一遍：
 *   A. 等值比较的大小写语义（account_name 建 admin / Admin 是否可共存、`=` 命中几行）
 *   B. LIKE 检索语义（SQLite 对 ASCII 不敏感；大小写敏感排序规则下敏感）+ 可移植写法验证
 *   C. schema_version 版本记账单行语义（#52：MAX(version)+COUNT(*) / DELETE+INSERT /
 *      v4 治愈迁移）在三方言下都成立
 *
 * 本测试**不改业务 SQL**：它只记录差异并给出可移植写法建议，业务侧改动归 #54/#55。
 *
 * 用法：
 *   node scripts/db-semantic-test.mjs                        # sqlite（临时库文件，零配置）
 *   DB_TYPE=mysql DB_HOST=mariadb DB_USER=root DB_PASSWORD=... \
 *     node scripts/db-semantic-test.mjs                      # mariadb（自动建/删 meeting_asr_ci_* 库）
 *   DB_TYPE=mssql DB_HOST=host.docker.internal DB_PORT=1433 DB_USER=sa DB_PASSWORD=... \
 *     node scripts/db-semantic-test.mjs                      # SQL Server（同上）
 *
 * 安全边界：mysql/mssql 目标只允许建/删名字以 `meeting_asr_ci_` 开头的一次性库
 * （共享实例上还有别的项目的库，见工单红线）。DB_NAME 可显式指定，但同样受前缀约束。
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败；3 = 目标库不可达（明确 SKIP，不是假绿）。
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createKnexInstance, getDbType } from "../server/db/index.mjs";
import { AsyncDb, extractRows } from "../server/db/async-db.mjs";
import { initializeSchema, SCHEMA_VERSION } from "../server/db/schema.mjs";

/** 一次性测试库命名前缀（共享实例红线） */
const CI_DB_PREFIX = "meeting_asr_ci_";

const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function assert(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

/** 断言抛错即失败，用于「必须成功」的步骤 */
async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
    return true;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    return false;
  }
}

// ---------- 一次性库生命周期（mysql / mssql） ----------

function assertSafeDbName(name) {
  if (!name.startsWith(CI_DB_PREFIX)) {
    throw new Error(
      `拒绝操作库 ${name}：本测试只允许建/删 ${CI_DB_PREFIX}* 的一次性库（共享实例红线）`
    );
  }
}

/** 用同一套连接参数连到管理库（mssql: master / mysql: mysql）执行一句 DDL */
async function withAdminKnex(dbType, fn) {
  const target = process.env.DB_NAME;
  const adminDbName = dbType === "mysql" ? "mysql" : "master";
  process.env.DB_NAME = adminDbName;
  const adminKnex = createKnexInstance(dbType);
  try {
    return await fn(adminKnex);
  } finally {
    process.env.DB_NAME = target;
    await adminKnex.destroy().catch(() => {});
  }
}

async function createThrowawayDatabase(dbType, dbName) {
  assertSafeDbName(dbName);
  await withAdminKnex(dbType, (knex) =>
    knex.raw(
      dbType === "mysql"
        ? `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`
        : `CREATE DATABASE [${dbName}]`
    )
  );
}

async function dropThrowawayDatabase(dbType, dbName) {
  if (!dbName.startsWith(CI_DB_PREFIX)) return;
  await withAdminKnex(dbType, (knex) =>
    knex.raw(
      dbType === "mysql"
        ? `DROP DATABASE IF EXISTS \`${dbName}\``
        : `DROP DATABASE IF EXISTS [${dbName}]`
    )
  );
}

// ---------- 方言 DDL 片段 ----------

/**
 * 大小写敏感排序规则方案（本单选定，见 docs/design/db-dialect-portability.md）：
 *   - sqlite：默认 BINARY 排序规则天然大小写敏感，无需声明
 *   - mysql ：列级 `COLLATE utf8mb4_bin`（utf8mb4 的二进制排序规则）
 *   - mssql ：列级 `COLLATE Latin1_General_100_BIN2`（二进制比较，不区分重音/大小写）
 */
function caseSensitiveDdl(dbType) {
  if (dbType === "mysql") {
    return {
      // 注意：id 主键也必须显式 utf8mb4_bin —— 否则继承库默认的 *_ai_ci，
      // 'u-admin' 与 'u-Admin' 在唯一键上视为同一个值（实测 Duplicate entry，见 A4）。
      create: (table) =>
        `CREATE TABLE \`${table}\` (
           \`id\` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
           \`account_name\` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
           UNIQUE KEY \`uq_${table}_account\` (\`account_name\`)
         ) DEFAULT CHARSET=utf8mb4`,
    };
  }
  if (dbType === "mssql") {
    return {
      create: (table) =>
        `CREATE TABLE [${table}] (
           [id] NVARCHAR(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
           [account_name] NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL,
           CONSTRAINT [uq_${table}_account] UNIQUE ([account_name])
         )`,
    };
  }
  return {
    create: (table) =>
      `CREATE TABLE ${table} (
         id TEXT NOT NULL PRIMARY KEY,
         account_name TEXT NOT NULL
       )`,
  };
}

/** 默认（未显式声明 collation）的对照表：sqlite 默认 BINARY、mssql 默认 SQL_Latin1_General_CP1_CI_AS、mariadb 默认 *_ai_ci */
function defaultCollationDdl(dbType) {
  if (dbType === "mysql") {
    return {
      create: (table) =>
        `CREATE TABLE \`${table}\` (
           \`id\` VARCHAR(64) NOT NULL PRIMARY KEY,
           \`account_name\` VARCHAR(255) NOT NULL,
           UNIQUE KEY \`uq_${table}_account\` (\`account_name\`)
         ) DEFAULT CHARSET=utf8mb4`,
    };
  }
  if (dbType === "mssql") {
    return {
      create: (table) =>
        `CREATE TABLE [${table}] (
           [id] NVARCHAR(64) NOT NULL PRIMARY KEY,
           [account_name] NVARCHAR(255) NOT NULL,
           CONSTRAINT [uq_${table}_account] UNIQUE ([account_name])
         )`,
    };
  }
  return {
    create: (table) =>
      `CREATE TABLE ${table} (
         id TEXT NOT NULL PRIMARY KEY,
         account_name TEXT NOT NULL,
         UNIQUE (account_name)
       )`,
  };
}

async function dropTableIfExists(db, table) {
  try {
    await db.knex.raw(`DROP TABLE ${table}`);
  } catch {
    // 表不存在时忽略
  }
}

async function insertUser(db, table, id, accountName) {
  await db.prepare(`INSERT INTO ${table} (id, account_name) VALUES (?, ?)`).run(id, accountName);
}

// ---------- A. 等值比较的大小写语义 ----------

async function assertCaseSensitiveEquality(db, dbType) {
  const table = "sem_users_cs";
  await dropTableIfExists(db, table);
  await db.knex.raw(caseSensitiveDdl(dbType).create(table));

  await insertUser(db, table, "u-admin", "admin");
  const coexist = await step("A1 admin / Admin 在大小写敏感排序规则下可共存", async () => {
    await insertUser(db, table, "u-Admin", "Admin");
    const rows = await db.prepare(`SELECT id FROM ${table} ORDER BY id`).all();
    if (rows.length !== 2) throw new Error(`期望 2 行，实际 ${rows.length} 行`);
    return `2 行: ${rows.map((row) => row.id).join(", ")}`;
  });
  if (!coexist) return;

  await step("A2 account_name = 'admin' 只命中 1 行（二进制比较，不折叠大小写）", async () => {
    const rows = await db.prepare(`SELECT id FROM ${table} WHERE account_name = ?`).all("admin");
    if (rows.length !== 1) throw new Error(`期望命中 1 行，实际 ${rows.length} 行`);
    if (String(rows[0].id) !== "u-admin") throw new Error(`命中了 ${rows[0].id}，应为 u-admin`);
    return "命中 u-admin";
  });

  // 对照组：不声明 collation 时的默认语义
  const defaultTable = "sem_users_default";
  await dropTableIfExists(db, defaultTable);
  await db.knex.raw(defaultCollationDdl(dbType).create(defaultTable));
  await insertUser(db, defaultTable, "d-admin", "admin");
  let secondInsertRejected = false;
  try {
    await insertUser(db, defaultTable, "d-Admin", "Admin");
  } catch {
    secondInsertRejected = true;
  }
  const defaultRows = await db.prepare(`SELECT id FROM ${defaultTable}`).all();
  if (dbType === "sqlite") {
    assert(
      "A3 对照：SQLite 默认 BINARY → admin/Admin 共存（现网语义 = 区分大小写）",
      !secondInsertRejected && defaultRows.length === 2,
      `插入未被拒=${!secondInsertRejected}，行数=${defaultRows.length}`
    );
  } else {
    assert(
      `A3 对照：${dbType} 默认排序规则不区分大小写 → admin/Admin 撞唯一键`,
      secondInsertRejected && defaultRows.length === 1,
      `第二条被拒=${secondInsertRejected}，行数=${defaultRows.length}`
    );
  }
  await dropTableIfExists(db, defaultTable);

  // 主键列的大小写语义：应用侧 ID 是「不透明字符串」，SQLite 按字节比较；
  // mysql/mssql 默认排序规则下 'u-1' 与 'U-1' 会被判成同一主键（冲突/覆盖风险）。
  const pkTable = "sem_pk_default";
  await dropTableIfExists(db, pkTable);
  await db.knex.raw(
    dbType === "mysql"
      ? `CREATE TABLE \`${pkTable}\` (\`id\` VARCHAR(64) NOT NULL PRIMARY KEY) DEFAULT CHARSET=utf8mb4`
      : dbType === "mssql"
        ? `CREATE TABLE [${pkTable}] ([id] NVARCHAR(64) NOT NULL PRIMARY KEY)`
        : `CREATE TABLE ${pkTable} (id TEXT NOT NULL PRIMARY KEY)`
  );
  await db.prepare(`INSERT INTO ${pkTable} (id) VALUES (?)`).run("u-1");
  let pkSecondRejected = false;
  try {
    await db.prepare(`INSERT INTO ${pkTable} (id) VALUES (?)`).run("U-1");
  } catch {
    pkSecondRejected = true;
  }
  const pkRows = await db.prepare(`SELECT id FROM ${pkTable}`).all();
  if (dbType === "sqlite") {
    assert(
      "A4 对照：SQLite 主键按字节比较 → 'u-1' 与 'U-1' 是两条记录",
      !pkSecondRejected && pkRows.length === 2,
      `第二条被拒=${pkSecondRejected}，行数=${pkRows.length}`
    );
  } else {
    assert(
      `A4 对照：${dbType} 默认排序规则下主键 'u-1' / 'U-1' 撞键（ID 列需显式二进制排序规则）`,
      pkSecondRejected && pkRows.length === 1,
      `第二条被拒=${pkSecondRejected}，行数=${pkRows.length}`
    );
  }
  await dropTableIfExists(db, pkTable);
}

// ---------- B. LIKE 检索语义 ----------

async function assertLikeSemantics(db, dbType) {
  const table = "sem_users_cs"; // 复用 A 段的表（admin / Admin 两行）
  const likeRows = await db.prepare(`SELECT id FROM ${table} WHERE account_name LIKE ?`).all("admin");
  const matched = likeRows.map((row) => String(row.id)).sort();
  // SQLite 的 LIKE 对 ASCII 一律不敏感（与列排序规则无关）→ 'admin' 同时命中 'admin' 与 'Admin'；
  // utf8mb4_bin / Latin1_General_100_BIN2 下 LIKE 跟随列的二进制排序规则 → 只命中 'admin'。
  const expectedLike = dbType === "sqlite" ? ["u-Admin", "u-admin"] : ["u-admin"];
  assert(
    "B1 LIKE 行为已记录（ASCII 大小写敏感性随方言不同）",
    JSON.stringify(matched) === JSON.stringify(expectedLike),
    `LIKE 'admin' 命中 ${matched.join(",") || "(无)"}（sqlite 不敏感=2 行；bin/BIN2 敏感=1 行 u-admin）`
  );

  await step("B2 可移植写法 LOWER(col) LIKE LOWER(?) 三库命中 2 行", async () => {
    const rows = await db
      .prepare(`SELECT id FROM ${table} WHERE LOWER(account_name) LIKE LOWER(?)`)
      .all("ADMIN");
    if (rows.length !== 2) throw new Error(`期望 2 行，实际 ${rows.length} 行`);
    return "2 行";
  });

  await step("B3 中文不受 LOWER() 影响（三库一致）", async () => {
    await insertUser(db, table, "u-cn", "管理员");
    const rows = await db.prepare(`SELECT id FROM ${table} WHERE account_name LIKE ?`).all("%管理%");
    if (rows.length !== 1) throw new Error(`LIKE '%管理%' 期望 1 行，实际 ${rows.length} 行`);
    const lowered = await db.prepare(`SELECT LOWER(?) AS v`).get("管理员");
    if (String(lowered.v) !== "管理员") throw new Error(`LOWER('管理员') = ${lowered.v}，应保持不变`);
    return "LIKE '%管理%' 命中 1 行、LOWER('管理员') 不变";
  });

  // 已知差异登记：SQLite 的 lower() 只折叠 ASCII，MySQL/MSSQL 折叠 Unicode
  const folded = await db.prepare(`SELECT LOWER(?) AS v`).get("Ä");
  const expected = dbType === "sqlite" ? "Ä" : "ä";
  assert(
    "B4 LOWER() 的非 ASCII 折叠范围已记录（sqlite 只折叠 ASCII）",
    String(folded.v) === expected,
    `LOWER('Ä') = '${folded.v}'（sqlite 期望 'Ä'，mysql/mssql 期望 'ä'）`
  );
}

// ---------- C. 版本记账单行语义 ----------

async function readVersionRow(db) {
  const row = await db
    .prepare("SELECT MAX(version) AS max_version, COUNT(*) AS row_count FROM schema_version")
    .get();
  return { maxVersion: Number(row.max_version), rowCount: Number(row.row_count) };
}

async function assertVersionBookkeeping(db) {
  await step("C1 全新库 initializeSchema → schema_version 单行 = SCHEMA_VERSION", async () => {
    await initializeSchema(db);
    const { maxVersion, rowCount } = await readVersionRow(db);
    if (rowCount !== 1) throw new Error(`期望 1 行，实际 ${rowCount} 行`);
    if (maxVersion !== SCHEMA_VERSION) throw new Error(`期望 v${SCHEMA_VERSION}，实际 v${maxVersion}`);
    return `MAX(version)=${maxVersion}, COUNT(*)=${rowCount}`;
  });

  await step("C2 被污染库 [2,3,3] → 收敛单行 = SCHEMA_VERSION（v4 治愈迁移）", async () => {
    await db.prepare("DELETE FROM schema_version").run();
    for (const version of [2, 3, 3]) {
      await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    }
    const polluted = await readVersionRow(db);
    if (polluted.rowCount !== 3) throw new Error(`污染构造失败: ${polluted.rowCount} 行`);
    await initializeSchema(db);
    const { maxVersion, rowCount } = await readVersionRow(db);
    if (rowCount !== 1) throw new Error(`期望收敛成 1 行，实际 ${rowCount} 行`);
    if (maxVersion !== SCHEMA_VERSION) throw new Error(`期望 v${SCHEMA_VERSION}，实际 v${maxVersion}`);
    return `3 行 → 单行 v${maxVersion}`;
  });

  await step("C3 MAX(version)+COUNT(*) 读取语义三库一致（不依赖隐式行序）", async () => {
    const { maxVersion, rowCount } = await readVersionRow(db);
    if (!Number.isInteger(maxVersion) || rowCount !== 1) {
      throw new Error(`读取结果异常: max=${maxVersion} count=${rowCount}`);
    }
    return `max=${maxVersion} count=${rowCount}`;
  });
}

// ---------- 入口 ----------

async function main() {
  const dbType = getDbType();
  const started = Date.now();
  let cleanup = () => {};
  let dbName = process.env.DB_NAME;
  let tempDir = null;

  console.log(`[semantic] 目标方言 db_type=${dbType}`);

  if (dbType === "sqlite") {
    tempDir = mkdtempSync(join(tmpdir(), "db-semantic-test-"));
    process.env.SQLITE_PATH = join(tempDir, "semantic.db");
    console.log(`[semantic] sqlite 临时库: ${process.env.SQLITE_PATH}`);
  } else {
    if (!dbName) {
      dbName = `${CI_DB_PREFIX}sem_${Date.now().toString(36)}_${process.pid}`;
      process.env.DB_NAME = dbName;
    }
    assertSafeDbName(dbName);
    console.log(`[semantic] 一次性库: ${dbName}`);
    try {
      await createThrowawayDatabase(dbType, dbName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`SKIP: 目标库不可达或建库失败（db_type=${dbType}, db=${dbName}）: ${message}`);
      console.log("RESULT: SKIP");
      process.exitCode = 3;
      return;
    }
    cleanup = () => dropThrowawayDatabase(dbType, dbName);
  }

  const knex = createKnexInstance(dbType);
  const db = new AsyncDb(knex, dbType);

  try {
    await db.knex.raw("SELECT 1");
    await assertCaseSensitiveEquality(db, dbType);
    await assertLikeSemantics(db, dbType);
    await assertVersionBookkeeping(db);
  } finally {
    await knex.destroy().catch(() => {});
    await Promise.resolve()
      .then(() => cleanup())
      .catch((error) => {
        console.error(`[semantic] 清理失败: ${error.message}`);
        process.exitCode = 1;
      });
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.ok);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[semantic] ${checks.length - failed.length}/${checks.length} 项通过，用时 ${seconds}s（db_type=${dbType}）`
  );
  if (failed.length > 0) {
    console.log(`RESULT: FAIL`);
    process.exitCode = 1;
  } else {
    console.log("RESULT: PASS");
  }
}

main().catch((error) => {
  console.error("❌", error);
  console.log("RESULT: FAIL");
  process.exit(1);
});
