/**
 * CI 探活（issue #55b）：mariadb / mssql 两个靶子必须都能 `SELECT 1`。
 *
 * 目标来自与 `db:test-parity` 同一套环境变量（CI_MYSQL_* / CI_MSSQL_*），
 * 所以本地与 CI 用的是同一份口径：
 *   本机（docker 网络 prod）: CI_MYSQL_HOST=mariadb CI_MSSQL_HOST=host.docker.internal
 *   GitHub Actions（services）: 两者都是 127.0.0.1（端口发布在 localhost）
 *
 * 退出码：0 = 两个都通；1 = 有不通的（逐个打印原因）。
 * 为什么单独一个脚本：CI 里要能把「service 没起来」和「代码坏了」分开，
 * 并且需要一个可重试的探针（SQL Server 启动要几十秒）。
 */
import { createKnexInstance } from "../server/db/index.mjs";

const TARGETS = [
  {
    dbType: "mysql",
    label: "mariadb",
    env: {
      DB_HOST: process.env.CI_MYSQL_HOST || "mariadb",
      DB_PORT: process.env.CI_MYSQL_PORT || "3306",
      DB_USER: process.env.CI_MYSQL_USER || "root",
      DB_PASSWORD: process.env.CI_MYSQL_PASSWORD || "",
      DB_NAME: process.env.CI_MYSQL_ADMIN_DB || "mysql",
    },
  },
  {
    dbType: "mssql",
    label: "mssql",
    env: {
      DB_HOST: process.env.CI_MSSQL_HOST || "host.docker.internal",
      DB_PORT: process.env.CI_MSSQL_PORT || "1433",
      DB_USER: process.env.CI_MSSQL_USER || "sa",
      DB_PASSWORD: process.env.CI_MSSQL_PASSWORD || "",
      DB_NAME: process.env.CI_MSSQL_ADMIN_DB || "master",
    },
  },
];

let failed = 0;
for (const target of TARGETS) {
  const previous = { ...process.env };
  Object.assign(process.env, { DB_TYPE: target.dbType }, target.env);
  let knex = null;
  try {
    knex = createKnexInstance(target.dbType);
    const result = await knex.raw("SELECT 1 AS ok");
    const rows = result?.rows ?? (Array.isArray(result) ? (Array.isArray(result[0]) ? result[0] : result) : result);
    const ok = Number(Array.isArray(rows) ? rows[0]?.ok : rows?.ok) === 1;
    if (!ok) throw new Error(`SELECT 1 返回值异常: ${JSON.stringify(result).slice(0, 120)}`);
    console.log(`[probe] ✅ ${target.label} 可达（${target.env.DB_HOST}:${target.env.DB_PORT}）`);
  } catch (error) {
    failed += 1;
    console.error(
      `[probe] ❌ ${target.label} 不可达（${target.env.DB_HOST}:${target.env.DB_PORT}）: ` +
        (error instanceof Error ? error.message.split("\n")[0] : String(error))
    );
  } finally {
    if (knex) await knex.destroy().catch(() => {});
    process.env = previous;
  }
}

if (failed > 0) {
  console.error(`[probe] ${failed} 个靶子不可达`);
  process.exitCode = 1;
} else {
  console.log("[probe] 两个靶子都就绪");
}
