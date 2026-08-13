/**
 * 跨库 "INSERT ... IGNORE" 工具（PR-A 基建）
 *
 * 背景：业务代码中的 SQLite 方言 INSERT OR IGNORE 无法直接迁移到 MSSQL
 * （knex 的 onConflict() 不支持 mssql 客户端）。
 *
 * 策略：
 *   - sqlite / mysql：knex 原生 onConflict(keys).ignore()
 *     （SQLite → INSERT OR IGNORE；MySQL → INSERT IGNORE）
 *   - mssql：标准 SQL 模式 INSERT INTO t SELECT ... WHERE NOT EXISTS(...)，
 *     逐行执行（MSSQL 无单语句多行 ignore 插入的等价写法）
 *
 * 用法：
 *   const affected = await insertIgnore(db, "user_roles", row, ["user_id", "role_id"]);
 *   row 可为单对象或对象数组；conflictKeys 为冲突判定列。
 *   返回受影响行数（跨库统一）。
 */
import { getDbType } from "./index.mjs";

export async function insertIgnore(db, table, rows, conflictKeys) {
  const dbType = getDbType();
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return 0;

  if (dbType === "mssql") {
    let affected = 0;
    for (const row of list) {
      // SELECT 字面量行（列名 → 值），配合 WHERE NOT EXISTS 实现条件插入
      const literal = db(table).select(
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value]))
      );
      const sub = literal.whereNotExists(
        db(table).where((builder) => {
          for (const key of conflictKeys) builder.where(key, row[key]);
        })
      );
      const result = await db(table).insert(sub);
      affected += Number(result?.rowCount ?? result?.affectedRows ?? 0);
    }
    return affected;
  }

  const result = await db(table).insert(list).onConflict(conflictKeys).ignore();
  return Number(result?.rowCount ?? result?.affectedRows ?? 0);
}
