/**
 * 事务句柄显式传递 + affected-rows 验证（issue #55 / PR-B③a，D7）
 *
 * 覆盖（三库同一套断言）：
 *   A 顶层事务提交：事务内的写入全部落库
 *   B 顶层事务回滚：事务内的写入全部不落库
 *   C 嵌套事务：内层 savepoint 抛错只回滚内层，外层继续提交（修 `no such savepoint: sp_1`）
 *   D **D2 运行期防线**：事务上下文中在普通 `db` 上调用 prepare / exec / withTransaction /
 *     listTableColumns 必须抛错；事务句柄 `tx` 不受影响（防线不破坏事务本身）
 *   E 并发两个顶层事务：都提交、互不丢写（#54 串行化语义保持）
 *   F affected-rows（D4）：INSERT/UPDATE/DELETE 的 `.run().changes` 在**三库**都必须准
 *     —— 删 1 条=1、删不存在=0、更新 1 条=1、更新不存在=0；事务内同样成立。
 *     这是 `deleteHotword()` / `updateMeetingStatus()` 判「目标是否存在」的唯一依据，
 *     mssql 上曾恒 0（#54 §4.8），会静默判错。
 *
 * 运行模式（未知参数一律报错退出）：
 *   node scripts/db-tx-test.mjs              # sqlite（默认，临时库）
 *   node scripts/db-tx-test.mjs --dialect    # 单方言，目标由 DB_TYPE / DB_HOST / DB_NAME 决定
 *   --allow-skip：目标库不可达时仍以退出码 0 结束（默认严格：SKIP ⇒ 退出码 3）
 *
 * 库生命周期：mysql / mssql 只建/删 `meeting_asr_ci_*` 一次性库（共享实例红线），
 * **DROP 放在 finally**（`timeout` 杀进程也不能漏 DROP 的写法：进程正常/异常退出都会走 finally，
 * 被 SIGKILL 时仍需人工复核 sys.databases）。
 *
 * 矩阵：`npm run db:test-parity`（scripts/db-schema-test.mjs --matrix）把本脚本作为一个 job
 * 挂进每个目标，语义与 schema/语义锁一致——**任何 SKIP 即失败**。
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { createKnexInstance, getDbType } from "../server/db/index.mjs";
import { AsyncDb, listTableColumns } from "../server/db/async-db.mjs";
import {
  CI_DB_PREFIX,
  createThrowawayDatabase,
  dropThrowawayDatabase,
} from "./db-schema-test.mjs";

const TABLE = "tx_suite_probe";
const PROBE_ID = "tx-suite";

/** 断言失败 = 用例失败（与 db-schema-test 同风格，直接抛出中断套件） */
function check(name, condition, detail) {
  if (!condition) {
    throw new Error(`${name} 失败: ${detail}`);
  }
  console.log(`✅ ${name}${detail ? ` — ${detail}` : ""}`);
}

const describeError = (error) => (error instanceof Error ? error.message : String(error));

async function ids(db) {
  return (await db.prepare(`SELECT id FROM ${TABLE} ORDER BY id`).all()).map((row) => String(row.id));
}

const insertSql = `INSERT INTO ${TABLE} (id, tag, weight) VALUES (?, ?, ?)`;

async function runSuite(db, dbType) {
  console.log(`[tx] 目标方言 db_type=${dbType}`);

  await db.knex.schema.dropTableIfExists(TABLE);
  await db.knex.schema.createTable(TABLE, (t) => {
    t.string("id", 64).primary();
    t.string("tag", 32).notNullable();
    t.integer("weight").notNullable();
  });

  try {
    // ---------- A. 顶层事务提交 ----------
    await db.prepare(`DELETE FROM ${TABLE}`).run();
    await db.withTransaction(async (tx) => {
      await tx.prepare(insertSql).run("a-1", "A", 1);
      await tx.prepare(insertSql).run("a-2", "A", 2);
    });
    check(
      "A 顶层事务提交：事务内写入全部落库",
      JSON.stringify(await ids(db)) === JSON.stringify(["a-1", "a-2"]),
      `行 ${JSON.stringify(await ids(db))}`
    );

    // ---------- B. 顶层事务回滚 ----------
    await db.prepare(`DELETE FROM ${TABLE}`).run();
    let rollbackThrew = false;
    try {
      await db.withTransaction(async (tx) => {
        await tx.prepare(insertSql).run("b-1", "B", 1);
        throw new Error("rollback-whole");
      });
    } catch {
      rollbackThrew = true;
    }
    check(
      "B 顶层事务回滚：事务内写入全部不落库",
      rollbackThrew && JSON.stringify(await ids(db)) === JSON.stringify([]),
      `抛错=${rollbackThrew} 行 ${JSON.stringify(await ids(db))}`
    );

    // ---------- C. 嵌套事务（savepoint） ----------
    await db.prepare(`DELETE FROM ${TABLE}`).run();
    await db.withTransaction(async (tx) => {
      await tx.prepare(insertSql).run("c-outer", "C", 1);
      try {
        await tx.withTransaction(async (tx2) => {
          await tx2.prepare(insertSql).run("c-inner", "C", 2);
          throw new Error("inner-rollback");
        });
      } catch {
        // 内层异常被外层吞掉 → 外层提交、内层回滚
      }
      await tx.prepare(insertSql).run("c-after", "C", 3);
    });
    const afterNested = await ids(db);
    check(
      "C 嵌套事务：内层抛错只回滚内层、外层继续提交（savepoint 发在事务连接上）",
      JSON.stringify(afterNested) === JSON.stringify(["c-after", "c-outer"]),
      `行 ${JSON.stringify(afterNested)}（c-inner 应被回滚）`
    );

    // ---------- D. D2 运行期防线 ----------
    await db.prepare(`DELETE FROM ${TABLE}`).run();
    const guardErrors = [];
    await db.withTransaction(async (tx) => {
      // D1: 普通 db 的 prepare（同步抛）
      try {
        db.prepare(`SELECT 1`);
      } catch (error) {
        guardErrors.push(["prepare", describeError(error)]);
      }
      // D2: 普通 db 的 exec（reject）
      try {
        await db.exec(`SELECT 1`);
      } catch (error) {
        guardErrors.push(["exec", describeError(error)]);
      }
      // D3: 普通 db 上再开事务（会开到池里的另一条连接）
      try {
        await db.withTransaction(async () => {});
      } catch (error) {
        guardErrors.push(["withTransaction", describeError(error)]);
      }
      // D4: 表结构探测工具同样受保护
      try {
        await listTableColumns(db, TABLE);
      } catch (error) {
        guardErrors.push(["listTableColumns", describeError(error)]);
      }
      // 事务句柄本身不受影响：继续用 tx 写一行，事务照常提交
      await tx.prepare(insertSql).run("d-guard", "D", 1);
    });
    const hint = "事务内请使用回调传入的 tx";
    check(
      "D D2 防线：事务上下文中 db.prepare / db.exec / db.withTransaction / listTableColumns(db) 全部抛错",
      guardErrors.length === 4 && guardErrors.every(([, message]) => message.includes(hint)),
      guardErrors.length === 4
        ? `4/4 抛错且文案含「${hint}」`
        : `只抛了 ${guardErrors.length} 处：${JSON.stringify(guardErrors)}`
    );
    check(
      "D 防线不破坏事务：抛错后 tx 仍可写、事务仍提交",
      JSON.stringify(await ids(db)) === JSON.stringify(["d-guard"]),
      `行 ${JSON.stringify(await ids(db))}`
    );
    // 事务外不受影响（防线只对「事务上下文里的普通 db」生效）
    const outside = await db.prepare(`SELECT COUNT(*) as n FROM ${TABLE}`).get();
    check(
      "D 防线只在事务上下文生效：事务外 db.prepare 正常工作",
      Number(outside?.n ?? -1) === 1,
      `COUNT(*) = ${outside?.n}`
    );

    // ---------- E. 并发两个顶层事务 ----------
    await db.prepare(`DELETE FROM ${TABLE}`).run();
    let concurrentError = null;
    try {
      await Promise.all([
        db.withTransaction(async (tx) => {
          await tx.prepare(insertSql).run("e-a1", "E", 1);
          await new Promise((resolve) => setTimeout(resolve, 20));
          await tx.prepare(insertSql).run("e-a2", "E", 2);
        }),
        db.withTransaction(async (tx) => {
          await tx.prepare(insertSql).run("e-b1", "E", 3);
          await new Promise((resolve) => setTimeout(resolve, 20));
          await tx.prepare(insertSql).run("e-b2", "E", 4);
        }),
      ]);
    } catch (error) {
      concurrentError = error;
    }
    const afterConcurrent = await ids(db);
    check(
      "E 并发两个顶层事务：都提交且互不丢写",
      concurrentError === null &&
        JSON.stringify(afterConcurrent) === JSON.stringify(["e-a1", "e-a2", "e-b1", "e-b2"]),
      concurrentError
        ? `抛错 ${describeError(concurrentError)}`
        : `行 ${JSON.stringify(afterConcurrent)}`
    );

    // ---------- F. affected-rows（D4）----------
    // 这组断言直接对应 deleteHotword() / updateMeetingStatus() 的判据：
    //   const deleted = Number(result.changes ?? 0) > 0;
    //   if (Number(result.changes ?? 0) === 0) throw new Error("状态已被改动");
    await db.prepare(`DELETE FROM ${TABLE}`).run();

    const insertInfo = await db.prepare(insertSql).run("f-1", "F", 1);
    check(
      "F1 INSERT 的 affected-rows = 1",
      Number(insertInfo.changes ?? -1) === 1,
      `changes=${insertInfo.changes}`
    );

    const updateInfo = await db.prepare(`UPDATE ${TABLE} SET weight = ? WHERE id = ?`).run(9, "f-1");
    check(
      "F2 UPDATE 命中 1 条 → affected-rows = 1",
      Number(updateInfo.changes ?? -1) === 1,
      `changes=${updateInfo.changes}`
    );

    const updateMiss = await db.prepare(`UPDATE ${TABLE} SET weight = ? WHERE id = ?`).run(9, "f-nope");
    check(
      "F3 UPDATE 不命中 → affected-rows = 0（deleteHotword 语义：0 即「不存在」）",
      Number(updateMiss.changes ?? -1) === 0,
      `changes=${updateMiss.changes}`
    );

    const deleteInfo = await db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run("f-1");
    check(
      "F4 DELETE 命中 1 条 → affected-rows = 1（updateMeetingStatus 语义：0 即「已被改动」）",
      Number(deleteInfo.changes ?? -1) === 1,
      `changes=${deleteInfo.changes}`
    );

    const deleteMiss = await db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run("f-1");
    check(
      "F5 DELETE 不命中 → affected-rows = 0",
      Number(deleteMiss.changes ?? -1) === 0,
      `changes=${deleteMiss.changes}`
    );

    // 事务连接上的 affected-rows 同样要准（mssql 的 @@ROWCOUNT 追加不能丢）
    await db.withTransaction(async (tx) => {
      const inTxInsert = await tx.prepare(insertSql).run("f-tx", "F", 1);
      check(
        "F6 事务内 INSERT 的 affected-rows = 1",
        Number(inTxInsert.changes ?? -1) === 1,
        `changes=${inTxInsert.changes}`
      );
      const inTxUpdate = await tx.prepare(`UPDATE ${TABLE} SET weight = ? WHERE id = ?`).run(3, "f-tx");
      check(
        "F7 事务内 UPDATE 命中 → affected-rows = 1",
        Number(inTxUpdate.changes ?? -1) === 1,
        `changes=${inTxUpdate.changes}`
      );
      const inTxMiss = await tx.prepare(`UPDATE ${TABLE} SET weight = ? WHERE id = ?`).run(3, "f-tx-nope");
      check(
        "F8 事务内 UPDATE 不命中 → affected-rows = 0",
        Number(inTxMiss.changes ?? -1) === 0,
        `changes=${inTxMiss.changes}`
      );
      const inTxDelete = await tx.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run("f-tx");
      check(
        "F9 事务内 DELETE 命中 → affected-rows = 1",
        Number(inTxDelete.changes ?? -1) === 1,
        `changes=${inTxDelete.changes}`
      );
      const inTxDeleteMiss = await tx.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run("f-tx");
      check(
        "F10 事务内 DELETE 不命中 → affected-rows = 0",
        Number(inTxDeleteMiss.changes ?? -1) === 0,
        `changes=${inTxDeleteMiss.changes}`
      );
    });

    // ---------- G. 回调签名兼容 ----------
    // 既有调用方可能写 `withTransaction(async () => ...)`（不接收 tx）——多一个参数不破坏它们。
    const compat = await db.withTransaction(async () => "ok");
    check("G 回调签名兼容：不接收 tx 的回调照常工作", compat === "ok", `返回值 ${JSON.stringify(compat)}`);
  } finally {
    await db.knex.schema.dropTableIfExists(TABLE).catch(() => {});
  }

  console.log(`🎉 事务套件全部通过（db_type=${dbType}）`);
}

async function mainDialect({ allowSkip = false } = {}) {
  const dbType = getDbType();
  let tempDir = null;
  let dbName = null;
  let knex = null;

  if (dbType === "sqlite") {
    tempDir = mkdtempSync(join(tmpdir(), "db-tx-test-"));
    process.env.SQLITE_PATH = join(tempDir, "tx.db");
    console.log(`[tx] sqlite 临时库: ${process.env.SQLITE_PATH}`);
  } else {
    dbName = `${CI_DB_PREFIX}tx_${Date.now().toString(36)}_${process.pid}`;
    process.env.DB_NAME = dbName;
    console.log(`[tx] 一次性库: ${dbName}`);
    try {
      await createThrowawayDatabase(dbType, dbName);
    } catch (error) {
      console.log(
        `SKIP: 目标库不可达或建库失败（db_type=${dbType}, db=${dbName}）: ${describeError(error)}`
      );
      console.log("RESULT: SKIP");
      process.exitCode = allowSkip ? 0 : 3;
      return;
    }
  }

  try {
    knex = createKnexInstance(dbType);
    const db = new AsyncDb(knex, dbType);
    await db.knex.raw("SELECT 1");
    await runSuite(db, dbType);
    console.log("RESULT: PASS");
  } catch (error) {
    console.error("❌", describeError(error));
    console.log("RESULT: FAIL");
    process.exitCode = 1;
  } finally {
    // 关池 + DROP 都放 finally：任何异常路径都不留悬挂句柄与一次性库
    if (knex) await knex.destroy().catch(() => {});
    if (dbName) {
      await dropThrowawayDatabase(dbType, dbName).catch((error) => {
        console.error(`[tx] DROP 失败: ${describeError(error)}`);
        process.exitCode = 1;
      });
      console.log(`[tx] 已 DROP 一次性库 ${dbName}`);
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

const KNOWN_FLAGS = new Map([
  ["--dialect", "单方言套件（目标由 DB_TYPE / DB_HOST / DB_NAME 等决定）"],
  ["--allow-skip", "存在 SKIP 项时仍以退出码 0 结束（默认：SKIP 即退出码 3）"],
]);

function parseArgs(argv) {
  const flags = new Set();
  const unknown = [];
  for (const arg of argv) {
    if (KNOWN_FLAGS.has(arg)) flags.add(arg);
    else unknown.push(arg);
  }
  return { flags, unknown };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { flags, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0) {
    console.error(`❌ 未知参数: ${unknown.join(" ")}`);
    console.error("[args] 可用参数：");
    for (const [flag, description] of KNOWN_FLAGS) console.error(`  ${flag.padEnd(14)} ${description}`);
    console.error("  （不带参数）    sqlite 套件（临时库）");
    console.log("RESULT: FAIL");
    process.exit(2);
  }
  mainDialect({ allowSkip: flags.has("--allow-skip") }).catch((error) => {
    console.error("❌", error);
    console.log("RESULT: FAIL");
    process.exit(1);
  });
}
