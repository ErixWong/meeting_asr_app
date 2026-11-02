/**
 * 跨库 "INSERT ... IGNORE" / "UPSERT" 工具（PR-A 基建，#55b 扩展）
 *
 * 背景：业务代码里的 SQLite 方言 `INSERT OR IGNORE` / `INSERT ... ON CONFLICT ... DO UPDATE`
 * 无法直接迁移到 MSSQL（knex 的 onConflict() 不支持 mssql 客户端，见
 * `node_modules/knex/lib/dialects/mssql/` 里没有 onConflict 实现），MariaDB 的 upsert
 * 语法（`ON DUPLICATE KEY UPDATE`）与 SQLite（`ON CONFLICT ... DO UPDATE`）也不同。
 *
 * 两条路径：
 *   1. `insertIgnore()`：冲突即丢弃（`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`）
 *      - sqlite / mysql：knex 原生 onConflict(keys).ignore()
 *        （SQLite → INSERT OR IGNORE；MySQL → INSERT IGNORE）
 *      - mssql：标准 SQL 模式 INSERT INTO t SELECT ... WHERE NOT EXISTS(...)
 *   2. `upsert()`：冲突即覆盖指定列（`ON CONFLICT ... DO UPDATE` / `ON DUPLICATE KEY UPDATE` / MERGE）
 *      - sqlite：`ON CONFLICT(keys) DO UPDATE SET col = excluded.col`
 *      - mysql ：`ON DUPLICATE KEY UPDATE col = ?`（**不用 `VALUES(col)`**：MySQL 8.0.20 起已弃用）
 *      - mssql ：`UPDATE ... WHERE keys; IF @@ROWCOUNT = 0 INSERT ...`（单 batch，同一连接，
 *        与 `INSERT ... SELECT ... WHERE NOT EXISTS` 一样属于 mssql 侧的等价模拟）
 *
 * 用法：
 *   const affected = await insertIgnore(db, "user_roles", row, ["user_id", "role_id"]);
 *   const affected = await upsert(db, "app_settings", row, ["item_section", "item_mark"],
 *     ["item_title", "item_description", "item_value", "updated_at"]);
 *   // 覆盖列里需要 SQL 字面量（不是绑定值）时用 { column, literal }：
 *   await upsert(db, "meeting_audio_recordings", row, ["capture_session_id"], [
 *     "raw_file_path",
 *     { column: "status", literal: "'recording'" },
 *     { column: "error_message", literal: "NULL" },
 *   ]);
 *
 * 参数 `db` 既可以是 knex 实例，也可以是 `AsyncDb` / 事务句柄 `tx`（内部取 `.knex`），
 * 方言取 `db.dbType`（没有则回落到 `DB_TYPE` 环境变量）。
 */
import { getDbType } from "./index.mjs";
import { appendRowCountSelect, extractRunInfo } from "./async-db.mjs";

/** 归一化句柄：knex 实例（可调用）或 AsyncDb / 事务句柄（取 .knex） */
function resolveKnex(db) {
  if (typeof db === "function") return db;
  if (db && typeof db.knex === "function") return db.knex;
  throw new TypeError("[DB] insertIgnore/upsert 需要 knex 实例或 AsyncDb 句柄");
}

/** 方言：优先取句柄上的 dbType（事务句柄也带），回落到环境变量 */
function resolveDbType(db) {
  const fromHandle = typeof db?.dbType === "string" ? db.dbType : null;
  return fromHandle ?? getDbType();
}

/** 按方言加标识符引号（sqlite `"x"` / mysql `` `x` `` / mssql `[x]`） */
function quote(knex, identifier) {
  return knex.ref(identifier).toQuery();
}

/**
 * 冲突即丢弃（`INSERT OR IGNORE` / `INSERT IGNORE` / `WHERE NOT EXISTS`）。
 *
 * 三个方言都走**裸 SQL**（不用 knex 的 `onConflict().ignore()`）：
 *   - knex 的 insert 返回值是 `[insertId]` 而不是受影响行数，拿不到「是否真的插进去了」；
 *   - 裸 SQL 的受影响行数三库都能拿到（`extractRunInfo` 统一），矩阵断言可以逐条较真。
 *
 *   sqlite → `INSERT OR IGNORE INTO "t" (...) VALUES (...)`
 *   mysql  → `INSERT IGNORE INTO \`t\` (...) VALUES (...)`
 *   mssql  → `INSERT INTO [t] (...) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM [t] WHERE k = ?)`
 *
 * ⚠ 语义注记：`INSERT IGNORE`（MySQL）与 `INSERT OR IGNORE`（SQLite）除了唯一键冲突外，
 * 也会跳过 NOT NULL 等约束报错；mssql 分支只等价于「唯一键冲突则跳过」。当前四个调用点
 * 传入的都是完整行，不存在依赖「跳过 NOT NULL 报错」的路径。
 *
 * @returns {Promise<number>} 真正插入的行数（三库统一，0 = 全部被忽略）
 */
export async function insertIgnore(db, table, rows, conflictKeys) {
  const knex = resolveKnex(db);
  const dbType = resolveDbType(db);
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return 0;

  let affected = 0;
  for (const row of list) {
    const columns = Object.keys(row);
    const insertList = columns.map((column) => quote(knex, column)).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const rowValues = columns.map((column) => row[column]);
    const tableRef = quote(knex, table);

    let sql;
    let params;
    if (dbType === "mssql") {
      // SQL Server 没有 `INSERT IGNORE`，等价写法是「带 WHERE NOT EXISTS 的 INSERT ... SELECT」
      const whereList = conflictKeys.map((key) => `${quote(knex, key)} = ?`).join(" AND ");
      sql =
        `INSERT INTO ${tableRef} (${insertList}) ` +
        `SELECT ${placeholders} WHERE NOT EXISTS (SELECT 1 FROM ${tableRef} WHERE ${whereList})`;
      params = [...rowValues, ...conflictKeys.map((key) => row[key])];
    } else if (dbType === "mysql") {
      sql = `INSERT IGNORE INTO ${tableRef} (${insertList}) VALUES (${placeholders})`;
      params = rowValues;
    } else {
      sql = `INSERT OR IGNORE INTO ${tableRef} (${insertList}) VALUES (${placeholders})`;
      params = rowValues;
    }

    // mssql 的 knex.raw 不透传 rowsAffected（§4.8），同 batch 追加 SELECT @@ROWCOUNT 才拿得到
    const text = dbType === "mssql" ? appendRowCountSelect(sql) : sql;
    affected += Number(extractRunInfo(await knex.raw(text, params)).changes ?? 0);
  }
  return affected;
}

/**
 * 冲突即覆盖（UPSERT）。
 *
 * @param {object} db knex 实例 / AsyncDb / 事务句柄
 * @param {string} table 表名
 * @param {object} row 整行（列名 → 值）
 * @param {string[]} conflictKeys 冲突判定列（sqlite 的 ON CONFLICT 目标 / mssql UPDATE 的 WHERE）
 * @param {Array<string|{column: string, value?: any, literal?: string}>} [updateColumns]
 *        命中冲突时要覆盖的列；字符串表示「取 row[col]」，`{column, literal}` 表示直接用
 *        SQL 字面量（如 `NULL` / `'recording'`）。缺省 = row 里除 conflictKeys 外的全部列。
 * @returns {Promise<number>} 受影响行数（**仅供诊断**：mysql 的 `affectedRows` 在「命中但值未变」
 *          时是 0、真更新时是 2；调用方一律以读回为准，不要用它判断「是否命中冲突」）。
 */
export async function upsert(db, table, row, conflictKeys, updateColumns) {
  const knex = resolveKnex(db);
  const dbType = resolveDbType(db);
  const columns = Object.keys(row);
  const targets = (updateColumns ?? columns.filter((column) => !conflictKeys.includes(column))).map(
    (entry) => (typeof entry === "string" ? { column: entry, value: row[entry] } : entry)
  );
  if (targets.length === 0) {
    throw new Error(`[DB] upsert(${table}) 没有任何要覆盖的列，改用 insertIgnore()`);
  }

  const insertList = columns.map((column) => quote(knex, column)).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const rowValues = columns.map((column) => row[column]);
  const tableRef = quote(knex, table);

  if (dbType === "sqlite") {
    // SQLite：excluded.<col> 指代「本应插入的那一行」的值
    const setList = targets
      .map((target) =>
        target.literal !== undefined
          ? `${quote(knex, target.column)} = ${target.literal}`
          : `${quote(knex, target.column)} = excluded.${quote(knex, target.column)}`
      )
      .join(", ");
    const keyList = conflictKeys.map((key) => quote(knex, key)).join(", ");
    const sql =
      `INSERT INTO ${tableRef} (${insertList}) VALUES (${placeholders}) ` +
      `ON CONFLICT(${keyList}) DO UPDATE SET ${setList}`;
    return Number(extractRunInfo(await knex.raw(sql, rowValues)).changes ?? 0);
  }

  if (dbType === "mysql") {
    // MariaDB / MySQL：冲突判定是「任意唯一键」，与 SQLite 的 ON CONFLICT(keys) 语义等价
    // （业务表上除主键外只有被指定的那个唯一键）。
    const setList = targets
      .map((target) =>
        target.literal !== undefined
          ? `${quote(knex, target.column)} = ${target.literal}`
          : `${quote(knex, target.column)} = ?`
      )
      .join(", ");
    const sql = `INSERT INTO ${tableRef} (${insertList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${setList}`;
    const params = [...rowValues, ...targets.filter((t) => t.literal === undefined).map((t) => t.value)];
    return Number(extractRunInfo(await knex.raw(sql, params)).changes ?? 0);
  }

  // mssql：UPDATE 命中即覆盖；未命中（@@ROWCOUNT = 0）再 INSERT。单 batch 下发，
  // 与 `insertIgnore` 的 `INSERT ... WHERE NOT EXISTS` 属同一类「等价模拟」（非 MERGE，
  // 避免 MERGE 的已知语义坑，也避免同一批参数被重复绑定）。
  const setList = targets
    .map((target) =>
      target.literal !== undefined
        ? `${quote(knex, target.column)} = ${target.literal}`
        : `${quote(knex, target.column)} = ?`
    )
    .join(", ");
  const whereList = conflictKeys.map((key) => `${quote(knex, key)} = ?`).join(" AND ");
  const sql =
    `UPDATE ${tableRef} SET ${setList} WHERE ${whereList};\n` +
    `IF @@ROWCOUNT = 0\n` +
    `  INSERT INTO ${tableRef} (${insertList}) VALUES (${placeholders});`;
  const params = [
    ...targets.filter((t) => t.literal === undefined).map((t) => t.value),
    ...conflictKeys.map((key) => row[key]),
    ...rowValues,
  ];
  // mssql 的 knex.raw 不透传 rowsAffected（§4.8），同 batch 追加 SELECT @@ROWCOUNT 才拿得到
  const result = await knex.raw(appendRowCountSelect(sql), params);
  return Number(extractRunInfo(result).changes ?? 0);
}
