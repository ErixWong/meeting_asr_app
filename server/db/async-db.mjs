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
 *
 * ---------------------------------------------------------------------------
 * 事务（issue #55 / PR-B③a）：**事务句柄显式传递**，不再有实例级可变状态
 * ---------------------------------------------------------------------------
 * 旧实现（#54 之前）把事务连接写进实例字段 `this.knex = trx`，靠串行锁保证
 * 「同一实例同一时刻只有一个顶层事务」。那是实例级可变状态：并发请求会互踩
 * （后进入者改写 `this.knex`，先退出者又指回去），语句可能落在事务连接之外却
 * 仍然「成功」。现在改成：
 *
 *   await db.withTransaction(async (tx) => {
 *     await tx.prepare("INSERT ...").run(...);   // 只认 tx
 *   });
 *
 * - `tx` 是**绑定在该事务连接上的 AsyncDb 视图**：同样有 `.prepare().all/get/run`、
 *   `.exec`、`.knex`、`.dbType`，可直接交给 `listTableColumns(tx, ...)` 这类工具函数。
 * - 事务深度（0/1/2…）记在 `AsyncLocalStorage`（按异步上下文隔离，不是实例字段），
 *   只用于**运行期防线**与嵌套判定。
 * - **运行期防线（D2）**：处于事务上下文中（`transactionDepth > 0`）时，在**非事务句柄**
 *   （即普通的 `db`）上调用 `prepare()` / `exec()` / `withTransaction()` 会**直接抛错**。
 *   这条是「漏改一处就静默写错库」的唯一硬闸——宁可抛错，也不要让语句跑到事务连接之外。
 * - 嵌套事务：`tx.withTransaction(async (tx2) => …)`。三库统一走 knex 的嵌套事务实现
 *   （sqlite/mysql → `SAVEPOINT` / mssql → `SAVE TRANSACTION`），**savepoint 一定发在
 *   事务连接上**，因此不再有 `no such savepoint: sp_1`（#55 修）。
 * - 串行锁（`_serialize`）职责收窄为**跨事务互斥**：同一实例上的顶层事务排队执行
 *   （等价于同步驱动时代的串行语义，避免 sqlite 单连接上的 BEGIN 撞车）。SQLite 的
 *   语句级锁保留：单连接下，事务未提交时其他请求的普通语句会落进这个事务，必须排队。
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
 * mssql 的 affected-rows 兜底（issue #55 D4，实测依据见
 * `docs/tasks/active/feat-261101-06-db-tx-explicit/report.md` 的探针原始输出）：
 *
 * knex 的 mssql 方言**不透传** tedious 的 `rowsAffected`，`knex.raw("INSERT/UPDATE/DELETE ...")`
 * 的返回值是**空数组 `[]`**（builder 的 update/delete 才返回 number）。因此
 * `extractRunInfo()` 只能拿到 `{}` → `changes` 恒 0，`deleteHotword()` /
 * `updateMeetingStatus()` 这类「按 changes 判目标是否存在」的业务路径会**静默判错**。
 *
 * 实测可行解：同一 batch 末尾追加 `SELECT @@ROWCOUNT AS changes`，返回值变成
 * `[{ changes: 1 }]` / `[{ changes: 0 }]`。追加时必须**先换行**——SQL 末尾若有
 * `-- 行注释`，同行的 SELECT 会被注释吞掉（探针实测：不换行 → `[]`，换行 → `[{changes:1}]`）。
 * 语句本身以 `;` 结尾也没问题（探针实测 `... VALUES (?, ?);\n; SELECT @@ROWCOUNT` → `[{changes:1}]`）。
 */
export function appendRowCountSelect(sql) {
  return `${sql}\n; SELECT @@ROWCOUNT AS changes`;
}

/**
 * 子查询取单行的方言片段（issue #55b）。SQL Server 不支持 `LIMIT`，只能把 `TOP n` 放到
 * SELECT 列表前面；SQLite / MariaDB 则把 `LIMIT n` 放到语句尾部。
 *
 *   `(SELECT ${top}col FROM ... ORDER BY ... ${limit})`
 *   → sqlite/mysql: top=""      limit="LIMIT 1"
 *   → mssql:        top="TOP 1 " limit=""
 */
export function singleRowFragment(dbType, count) {
  const n = normalizeRowLimit(count);
  if (dbType === "mssql") return { top: `TOP ${n} `, limit: "" };
  return { top: "", limit: `LIMIT ${n}` };
}

/**
 * 列表分页的方言后缀（issue #55b）：SQLite / MariaDB 用 `LIMIT n`；SQL Server 用
 * `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`（要求语句本身带 `ORDER BY`）。
 */
export function limitFragment(dbType, count) {
  const n = normalizeRowLimit(count);
  if (dbType === "mssql") return `OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  return `LIMIT ${n}`;
}

/** 行数一律走白名单化的正整数，避免把外部输入直接拼进 SQL 文本 */
function normalizeRowLimit(count) {
  const n = Math.trunc(Number(count));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(n, 100000);
}

const TRANSACTION_GUARD_HINT =
  "事务内请使用回调传入的 tx，否则语句会落在事务连接之外（事务回滚后不会生效，或被并发事务污染）";

export class AsyncDb {
  /**
   * @param {object} knex 绑定的 knex 实例（事务句柄下是该事务的 trx）
   * @param {string} dbType sqlite / mysql / mssql
   * @param {{ txContext?: AsyncLocalStorage<number>, transactionHandle?: boolean }} [internal]
   *        内部参数：事务句柄共享父实例的 AsyncLocalStorage（深度按异步上下文隔离）。
   */
  constructor(knex = getKnex(), dbType = getDbType(), internal = {}) {
    this.knex = knex;
    this.dbType = dbType;
    /** 事务串行化队列尾（同一个 Promise 链，先进先执行） */
    this._lockTail = Promise.resolve();
    /** 当前异步上下文的事务深度（0/1/2…） */
    this._txContext = internal.txContext ?? new AsyncLocalStorage();
    /** 本实例是否是 `withTransaction(cb)` 交给回调的事务句柄（绑定事务连接） */
    this._transactionHandle = internal.transactionHandle === true;
  }

  /** 当前异步上下文的事务深度（0 = 不在事务里） */
  get transactionDepth() {
    return this._txContext.getStore() ?? 0;
  }

  /** 是否是事务句柄（`withTransaction` 的回调参数 tx） */
  get isTransactionHandle() {
    return this._transactionHandle;
  }

  /**
   * 运行期防线（D2）：事务上下文中，普通 `db` 上的语句/事务入口一律抛错。
   * 只有 `withTransaction(cb)` 交给回调的 `tx`（`isTransactionHandle === true`）才放行。
   */
  _assertTransactionHandle(operation) {
    if (this.transactionDepth > 0 && !this._transactionHandle) {
      throw new Error(
        `[DB] ${operation}() 在事务上下文里被调用，但用的是普通 db 句柄：${TRANSACTION_GUARD_HINT}。` +
          "正确写法：await db.withTransaction(async (tx) => { await tx." +
          `${operation}(...); });`
      );
    }
  }

  /** 基于事务连接创建事务句柄（共享事务深度上下文，标记为事务句柄） */
  _makeTransactionHandle(trx) {
    return new AsyncDb(trx, this.dbType, {
      txContext: this._txContext,
      transactionHandle: true,
    });
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
    this._assertTransactionHandle("exec");
    await this._serializeStatement(() => this.knex.raw(sql));
  }

  prepare(sql) {
    // 同步抛错：调用点 `await db.prepare(...)` 会立刻 reject，不会「先拿到语句对象再静默执行」
    this._assertTransactionHandle("prepare");
    const knex = this.knex;
    const dbType = this.dbType;
    const query = (text, params) =>
      this._serializeStatement(async () =>
        knex.raw(text, params.length > 0 ? params : undefined)
      );
    return {
      all: async (...params) => extractRows(await query(sql, params)),
      get: async (...params) => extractRows(await query(sql, params))[0] ?? null,
      run: async (...params) => {
        // mssql 拿不到 affected-rows（见 appendRowCountSelect 注释），同 batch 追加 @@ROWCOUNT
        const text = dbType === "mssql" ? appendRowCountSelect(sql) : sql;
        return extractRunInfo(await query(text, params));
      },
    };
  }

  /**
   * 事务：顶层开事务、嵌套开 savepoint；**事务句柄通过回调参数显式传递**。
   *
   *   await db.withTransaction(async (tx) => { await tx.prepare(...).run(...); });
   *   await db.withTransaction(async (tx) => {
   *     await tx.withTransaction(async (tx2) => { ... });   // 嵌套 = savepoint
   *   });
   *
   * 顶层事务在同一实例上排队执行（串行锁，跨事务互斥）；嵌套层不排队（它本来就在外层
   * 事务的连接上，排队会和外层互锁）。
   */
  async withTransaction(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("[DB] withTransaction(callback) 需要一个回调函数");
    }
    const depth = this.transactionDepth;
    if (depth > 0) {
      // 事务内再开事务必须用 tx.withTransaction（事务句柄），否则会开在池里的另一条连接上
      this._assertTransactionHandle("withTransaction");
      // this.knex 是外层事务的 trx → knex 自动用 savepoint 实现嵌套（三库各自语法）
      return await this.knex.transaction(async (nested) => {
        const tx = this._makeTransactionHandle(nested);
        return await this._txContext.run(depth + 1, () => callback(tx));
      });
    }

    return await this._serialize(() =>
      this.knex.transaction(async (trx) => {
        const tx = this._makeTransactionHandle(trx);
        return await this._txContext.run(1, () => callback(tx));
      })
    );
  }
}

/**
 * 跨库表结构探测（替代 SQLite 专属 PRAGMA table_info）
 * 返回列名字符串数组。`db` 可以是普通 AsyncDb，也可以是事务句柄（tx）。
 */
export async function listTableColumns(db, tableName) {
  if (typeof db?.transactionDepth === "number" && db.transactionDepth > 0 && !db.isTransactionHandle) {
    throw new Error(
      `[DB] listTableColumns() 在事务上下文里被调用，但用的是普通 db 句柄：${TRANSACTION_GUARD_HINT}`
    );
  }
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

/**
 * 方言列定义（issue #55b）：业务侧沿用 SQLite 的类型写法，这里按方言翻译。
 *
 * MSSQL 不认 `INTEGER`（`Incorrect syntax near 'INTEGER'`），`TEXT` 也是已弃用的 legacy
 * 类型（用 `NVARCHAR(MAX)`）。其余方言**原样返回**，保证 sqlite/mysql 的 DDL 文本与
 * 改动前逐字一致。
 */
export function dialectColumnDefinition(dbType, definition) {
  if (dbType !== "mssql") return definition;
  return definition
    .replace(/\bINTEGER\b/gi, "INT")
    .replace(/\bTEXT\b/gi, "NVARCHAR(MAX)")
    .replace(/\bREAL\b/gi, "FLOAT")
    .replace(/\bBLOB\b/gi, "VARBINARY(MAX)");
}

/**
 * 跨库「幂等补列」（issue #55b）：列已存在则什么都不做，缺失才 `ALTER TABLE ... ADD`。
 *
 * 三处方言差异：
 *   1. 列探测：`PRAGMA table_info` 只有 SQLite 有 → 统一走 `listTableColumns()`；
 *   2. `ADD COLUMN` 的 `COLUMN` 关键字：MSSQL 不认（`ALTER TABLE t ADD c ...`）；
 *   3. 列类型：`INTEGER` / `TEXT` 在 MSSQL 上非法 → `dialectColumnDefinition()`。
 *
 * `db` 可以是普通 AsyncDb，也可以是事务句柄 `tx`（事务内必须传 tx，否则被 D2 防线抛错）。
 */
export async function addColumnIfAbsent(db, tableName, columnName, definition) {
  const columns = await listTableColumns(db, tableName);
  if (columns.includes(columnName)) return false;
  const columnKeyword = db.dbType === "mssql" ? "" : " COLUMN";
  await db.exec(
    `ALTER TABLE ${tableName} ADD${columnKeyword} ${columnName} ${dialectColumnDefinition(db.dbType, definition)}`
  );
  return true;
}
