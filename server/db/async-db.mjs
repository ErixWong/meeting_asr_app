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
import { AsyncLocalStorage } from "node:async_hooks";
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
 *
 * 并发语义（issue #54）：同一实例上的事务**串行化**（`_serialize`），事务深度
 * 记录在 AsyncLocalStorage 里（`_txContext`，按异步上下文隔离）。
 *
 * 为什么必须这样：`AsyncDb` 的事务状态原本是实例级可变状态（`this.knex = trx`、
 * `_txDepth`），同步驱动时代天然串行所以看不出来；改成异步之后，两个并发请求会在
 * 同一实例上同时开事务——后进入者会把 `this.knex` 改写成自己的 `trx`，先退出者又
 * 把它指回自己的 `outerKnex`，于是部分语句落在事务之外却仍然「成功」。串行化是
 * 今天同步运行时等价语义的最小实现；终解是把 `trx` 显式穿透到调用点（归 #55）。
 *
 * 另：SQLite（pool max=1，单连接）下事务未提交时，**其他请求的普通语句会落进这个
 * 事务**（同一个连接）。为了保持「同步驱动时代语句不会插进别人事务」的语义，
 * sqlite 的语句执行也走同一把锁（事务内直接放行，靠 `_txContext` 判重入）。
 */
export class AsyncDb {
  constructor(knex = getKnex(), dbType = getDbType()) {
    this.knex = knex;
    this.dbType = dbType;
    /** 事务/语句串行化队列尾（同一个 Promise 链，先进先执行） */
    this._lockTail = Promise.resolve();
    /** 当前异步上下文的事务深度（0/1/2…），替代原来的实例级 `_txDepth` */
    this._txContext = new AsyncLocalStorage();
  }

  /** 当前异步上下文的事务深度（0 = 不在事务里） */
  get transactionDepth() {
    return this._txContext.getStore() ?? 0;
  }

  /** 取实例级串行锁（先到先执行，后到排队） */
  async _serialize(fn) {
    const previous = this._lockTail;
    let release;
    this._lockTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 语句级串行化：只有 SQLite（单连接）需要；事务内的语句直接放行（同一连接，
   * 重入加锁会自锁）。mysql/mssql 连接池 > 1，语句不会落在别人的事务连接上。
   */
  async _serializeStatement(fn) {
    if (this.dbType !== "sqlite") return fn();
    if (this.transactionDepth > 0) return fn();
    return this._serialize(fn);
  }

  async exec(sql) {
    await this._serializeStatement(() => this.knex.raw(sql));
  }

  prepare(sql) {
    const knex = this.knex;
    const query = (params) =>
      this._serializeStatement(async () =>
        knex.raw(sql, params.length > 0 ? params : undefined)
      );
    return {
      all: async (...params) => extractRows(await query(params)),
      get: async (...params) => extractRows(await query(params))[0] ?? null,
      run: async (...params) => extractRunInfo(await query(params)),
    };
  }

  /**
   * 嵌套事务：顶层 BEGIN/COMMIT；嵌套层用 savepoint。
   * MSSQL 使用 SAVE/ROLLBACK TRANSACTION 语法，其余库用标准 SAVEPOINT。
   *
   * 顶层事务在同一实例上排队执行（串行化）；嵌套层不排队（它本来就在外层事务
   * 的异步上下文里，排队会和外层互锁），只按上下文深度取 savepoint 名。
   */
  async withTransaction(callback) {
    const depth = this.transactionDepth;
    if (depth > 0) {
      const name = `sp_${depth}`;
      await this._savepoint(name);
      try {
        const result = await this._txContext.run(depth + 1, () => callback());
        await this._releaseSavepoint(name);
        return result;
      } catch (error) {
        await this._rollbackToSavepoint(name);
        throw error;
      }
    }

    return this._serialize(() => this._txContext.run(1, () => this._runTopLevelTransaction(callback)));
  }

  /** 顶层事务本体（调用方已持有串行锁、上下文深度 = 1） */
  async _runTopLevelTransaction(callback) {
    if (this.dbType === "mssql") {
      // MSSQL 不能用 knex.raw("BEGIN")：knex 的 mssql 方言把语句交给 sp_executesql，
      // 语句内开启事务会让 SQL Server 在过程返回时发现 @@TRANCOUNT 前后不一致，
      // 直接报 `Msg 266 Transaction count after EXECUTE indicates a mismatching number
      // of BEGIN and COMMIT statements`（2026-11 实测）。
      // 因此 mssql 分支走驱动级事务 API（knex.transaction → tedious beginTransaction/
      // commitTransaction/rollbackTransaction），并在事务期间把 this.knex 换成 trx，
      // 使 AsyncDb 的 exec/prepare 与调用方的 db.knex.xxx 都落在同一条连接上
      // （knex.transaction 绑定单连接，池里另取连接会跑在事务之外）。
      // sqlite / mysql 分支不经过这里，下发的 SQL 文本与改动前逐字节一致。
      const outerKnex = this.knex;
      // 事务期间 this.knex 指向 trx，退出时在回调的 finally 里还原；串行锁保证同一
      // 实例同一时刻只有一个顶层事务，所以这里的还原不会覆盖别人的 trx。
      return await outerKnex.transaction(async (trx) => {
        this.knex = trx;
        try {
          return await callback();
        } finally {
          this.knex = outerKnex;
        }
      });
    }
    await this.knex.raw("BEGIN");
    try {
      const result = await callback();
      await this.knex.raw("COMMIT");
      return result;
    } catch (error) {
      await this.knex.raw("ROLLBACK");
      throw error;
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
