/**
 * 共享实例红线复核（issue #55b）：mariadb / mssql 上不许残留 `meeting_asr_ci_*` 一次性库。
 *
 * 背景：三库脚手架只准建/删 `meeting_asr_ci_*`，且 DROP 放在 finally。但 `timeout` 杀进程
 * （SIGKILL）时 finally 不会执行 —— 所以收尾必须**独立复核一次**，不能只信「跑完都 DROP 了」。
 *
 * 目标与 `scripts/probe-db-targets.mjs` 同一套环境变量（CI_MYSQL_* / CI_MSSQL_*）。
 * 退出码：0 = 两个实例都干净；1 = 有残留（打印库名）。
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

let leftovers = 0;
for (const target of TARGETS) {
  const previous = { ...process.env };
  Object.assign(process.env, { DB_TYPE: target.dbType }, target.env);
  let knex = null;
  try {
    knex = createKnexInstance(target.dbType);
    let names = [];
    if (target.dbType === "mysql") {
      // 用 information_schema 而不是 `SHOW DATABASES LIKE ?`：后者在预处理语句下不可绑定
      const result = await knex.raw(
        "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE ?",
        ["meeting_asr_ci%"]
      );
      const rows = result?.[0] ?? result;
      names = (Array.isArray(rows) ? rows : []).map((row) => String(row.name ?? row.SCHEMA_NAME));
    } else {
      const result = await knex.raw("SELECT name FROM sys.databases WHERE name LIKE ?", ["meeting_asr_ci%"]);
      const rows = result?.rows ?? result;
      names = (Array.isArray(rows) ? rows : []).map((row) => String(row.name));
    }
    if (names.length > 0) {
      leftovers += names.length;
      console.error(`[leftover] ❌ ${target.label} 残留一次性库: ${names.join(", ")}`);
    } else {
      console.log(`[leftover] ✅ ${target.label} 无残留 meeting_asr_ci_* 库`);
    }
  } catch (error) {
    leftovers += 1;
    console.error(
      `[leftover] ❌ ${target.label} 无法复核（${target.env.DB_HOST}:${target.env.DB_PORT}）: ` +
        (error instanceof Error ? error.message.split("\n")[0] : String(error))
    );
  } finally {
    if (knex) await knex.destroy().catch(() => {});
    process.env = previous;
  }
}

if (leftovers > 0) {
  console.error(`[leftover] 存在 ${leftovers} 处残留/无法复核，共享实例红线要求人工清理`);
  process.exitCode = 1;
} else {
  console.log("[leftover] 两个共享实例都干净");
}
