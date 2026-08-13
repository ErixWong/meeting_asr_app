/**
 * AsyncDb：knex 之上的 Promise 化数据访问层（PR-B 基建）
 *
 * 目标：最大程度保留现有 SQL 字符串调用形态，仅把同步 API 变为异步，
 * 从而把 database-schema / runtime-store / admin-store 的迁移成本降到最低：
 *
 *   旧（node:sqlite 同步）          新（AsyncDb 异步）
 *   database.prepare(sql).all()  →  await database.prepare(sql).all()
 *   database.prepare(sql).get()  →  await database.prepare(sql).get()
 *   database.prepare(sql).run(p) →  await database.prepare(sql).run(p)
 *   database.exec(sql)           →  await database.exec(sql)
 *
 * 内部通过 knex.raw() 执行，`?` 占位符由 knex 自动翻译为各库绑定语法
 * （SQLite ? / MySQL ? / MSSQL @p0），结果形态差异在此统一消化。
 */
import { getKnex, getDbType } from "./index.mjs";

/** 从 knex.raw 返回结果中提取行数组（三库结构差异统一） */
export function extractRows(result) {
  if (result == null) return [];
  if (Array.isArray(result)) {
    // sqlite: [...rows] / mysql2: [rows, fields]
    return Array.isArray(result[0]) ? result[0] : result;
  }
  // mssql: { rows: [...] } 或 { recordsets: [[...]] }
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result.recordsets) && result.recordsets[0]) return result.recordsets[0];
  return [];
}

/** 从写操作结果中提取 { changes, lastInsertRowid }（与 node:sqlite run() 对齐） */
export function extractRunInfo(result) {
  let info = result;
  if (Array.isArray(result)) info = result[0] ?? {};
  if (Array.isArray(info?.rowsAffected)) {
    return {
      changes: Number(info.rowsAffected[0] ?? 0),
      lastInsertRowid: info.lastInsertRowid ?? null,
    };
  }
  return {
    changes: Number(info?.changes ?? info?.rowCount ?? info?.affectedRows ?? 0),
    lastInsertRowid: info?.lastInsertRowid ?? null,
  };
}

/**
 * Promise 化 prepared-statement 风格的数据库句柄。
 * 每个实例绑定一个 knex 连接池，支持嵌套事务（savepoint，分方言）。
 */
export class AsyncDb {
  constructor(knex = getKnex(), dbType = getDbType()) {
    this.knex = knex;
    this.dbType = dbType;
    this._txDepth = 0;
  }

  async exec(sql) {
    await this.knex.raw(sql);
  }

  prepare(sql) {
    const knex = this.knex;
    return {
      all: async (...params) =>
        extractRows(await knex.raw(sql, params.length > 0 ? params : undefined)),
      get: async (...params) =>
        extractRows(await knex.raw(sql, params.length > 0 ? params : undefined))[0] ?? null,
      run: async (...params) =>
        extractRunInfo(await knex.raw(sql, params.length > 0 ? params : undefined)),
    };
  }

  /**
   * 嵌套事务：顶层 BEGIN/COMMIT；嵌套层用 savepoint。
   * MSSQL 使用 SAVE/ROLLBACK TRANSACTION 语法，其余库用标准 SAVEPOINT。
   */
  async withTransaction(callback) {
    if (this._txDepth > 0) {
      const name = `sp_${this._txDepth}`;
      await this._savepoint(name);
      try {
        const result = await callback();
        await this._releaseSavepoint(name);
        return result;
      } catch (error) {
        await this._rollbackToSavepoint(name);
        throw error;
      }
    }

    this._txDepth = 1;
    await this.knex.raw("BEGIN");
    try {
      const result = await callback();
      await this.knex.raw("COMMIT");
      return result;
    } catch (error) {
      await this.knex.raw("ROLLBACK");
      throw error;
    } finally {
      this._txDepth = 0;
    }
  }

  async _savepoint(name) {
    await this.knex.raw(
      this.dbType === "mssql" ? `SAVE TRANSACTION ${name}` : `SAVEPOINT ${name}`
    );
  }

  async _releaseSavepoint(name) {
    if (this.dbType === "mssql") {
      await this.knex.raw(`COMMIT TRANSACTION ${name}`);
    } else {
      await this.knex.raw(`RELEASE SAVEPOINT ${name}`);
    }
  }

  async _rollbackToSavepoint(name) {
    await this.knex.raw(
      this.dbType === "mssql" ? `ROLLBACK TRANSACTION ${name}` : `ROLLBACK TO SAVEPOINT ${name}`
    );
  }
}

/**
 * 跨库表结构探测（替代 SQLite 专属 PRAGMA table_info）
 * 返回列名字符串数组。
 */
export async function listTableColumns(db, tableName) {
  if (db.dbType === "sqlite") {
    const rows = await db.knex.raw(`PRAGMA table_info(${tableName})`);
    return extractRows(rows).map((row) => String(row.name));
  }
  if (db.dbType === "mysql") {
    const rows = await db.knex.raw(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [tableName]
    );
    return extractRows(rows).map((row) => String(row.name));
  }
  const rows = await db.knex.raw(
    `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`,
    [tableName]
  );
  return extractRows(rows).map((row) => String(row.name));
}
