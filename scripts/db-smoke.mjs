/**
 * 跨库冒烟测试：验证 knex 工厂在三类数据库（sqlite/mysql/mssql）下的基础能力
 *
 * 用法：
 *   node scripts/db-smoke.mjs                    # 默认 sqlite（本地零配置）
 *   DB_TYPE=mysql  DB_HOST=... DB_NAME=... node scripts/db-smoke.mjs
 *   DB_TYPE=mssql  DB_HOST=... DB_NAME=... node scripts/db-smoke.mjs
 *
 * 验证项：
 *   1. 连接 + select 1
 *   2. 建临时表 / 插入 / 查询 / 更新
 *   3. upsert（onConflict().ignore()）—— knex 跨库方言的关键能力
 *   4. 删除临时表
 */
import { getDbType, createKnexInstance } from "../server/db/index.mjs";
import { insertIgnore } from "../server/db/insert-ignore.mjs";

const TABLE = "__smoke_test__";

async function main() {
  const dbType = getDbType();
  console.log(`[smoke] 开始冒烟测试, db_type=${dbType}`);
  const db = createKnexInstance(dbType);

  try {
    // 1. 连接（各驱动 raw 返回结构不同：[[row]] / [row] / { rows }, 统一提取）
    const one = await db.raw("select 1 as ok");
    const candidate = Array.isArray(one) ? (Array.isArray(one[0]) ? one[0][0] : one[0]) : one?.rows?.[0];
    const ok = candidate?.ok ?? Object.values(candidate ?? {})[0];
    if (Number(ok) !== 1) throw new Error(`select 1 结果异常: ${JSON.stringify(one)}`);
    console.log(`[smoke] 1. 连接 OK (select 1)`);

    // 2. 建表（UUID 风格主键 + 标准列）
    await db.schema.dropTableIfExists(TABLE);
    await db.schema.createTable(TABLE, (t) => {
      t.string("id", 64).primary();
      t.string("name", 128).notNullable();
      t.integer("seq").notNullable();
      t.string("note").nullable();
    });
    console.log(`[smoke] 2. 建表 OK`);

    // 3. 插入 / 查询
    await db(TABLE).insert([
      { id: "a-1", name: "alpha", seq: 1, note: null },
      { id: "a-2", name: "beta", seq: 2, note: "x" },
    ]);
    const rows = await db(TABLE).orderBy("seq");
    if (rows.length !== 2 || rows[0].name !== "alpha") {
      throw new Error(`插入/查询结果异常: ${JSON.stringify(rows)}`);
    }
    console.log(`[smoke] 3. 插入+查询 OK (${rows.length} 行)`);

    // 4. upsert 方言：重复插入应被忽略，不影响既有行
    //    注意：MSSQL 不支持 knex onConflict().ignore()，统一走 insertIgnore 工具
    const ignored = await insertIgnore(db, TABLE, [{ id: "a-1", name: "alpha2", seq: 99, note: null }], ["id"]);
    const after = await db(TABLE).where({ id: "a-1" }).first();
    if (after.seq !== 1) throw new Error(`upsert 未生效, 行被覆盖: ${JSON.stringify(after)}`);
    console.log(`[smoke] 4. insertIgnore(跨库 upsert) OK (affected=${ignored})`);

    // 5. 更新 + 受影响行数（跨库返回结构差异：SQLite/MySQL 返回 rowCount，MSSQL 返回 rowCount/affectedRows）
    const updated = await db(TABLE).where({ id: "a-2" }).update({ note: "updated" });
    const affected = Number(updated ?? 0);
    if (affected !== 1) throw new Error(`update 受影响行数异常: ${updated}`);
    console.log(`[smoke] 5. 更新 OK (affected=${affected})`);

    console.log(`[smoke] ✅ 全部通过 (db_type=${dbType})`);
  } finally {
    // 6. 清理
    await db.schema.dropTableIfExists(TABLE).catch(() => {});
    await db.destroy().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[smoke] ❌ 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
