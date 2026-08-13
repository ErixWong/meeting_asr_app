/**
 * 多数据库 knex 工厂（PR-A 基建）
 *
 * 通过环境变量 DB_TYPE 切换数据库：
 *   - sqlite（默认）：better-sqlite3 驱动，文件存储，零配置
 *   - mysql：mysql2 驱动，连接外部实例（生产）
 *   - mssql：tedious 驱动，连接外部实例（生产）
 *
 * 外部实例连接参数（DB_TYPE=mysql|mssql 时必填）：
 *   DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
 *
 * 说明：本模块是 PR-A 新增的独立基建，尚未接入业务代码。
 * PR-B 将把 database-schema.mjs / db-shared.mjs 切换到本工厂，
 * 届时 getKnex() 成为唯一数据库入口。
 */
import knex from "knex";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const SUPPORTED_DB_TYPES = ["sqlite", "mysql", "mssql"];

let instance = null;

function required(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `[DB] 缺少环境变量 ${name}（DB_TYPE=${getDbType()} 时必填，请检查部署配置）`
    );
  }
  return value;
}

export function getDbType() {
  const type = String(process.env.DB_TYPE || "sqlite").trim().toLowerCase();
  if (!SUPPORTED_DB_TYPES.includes(type)) {
    throw new Error(
      `[DB] 不支持的 DB_TYPE=${type}，支持：${SUPPORTED_DB_TYPES.join(" / ")}`
    );
  }
  return type;
}

function sqliteConfig() {
  const dataDir = join(process.cwd(), "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const dbPath =
    process.env.SQLITE_PATH || join(dataDir, "meeting-asr-app.db");
  return {
    client: "better-sqlite3",
    connection: { filename: dbPath },
    useNullAsDefault: true,
    // SQLite 单写者：单连接避免并发写锁；WAL 由工厂初始化时开启
    pool: { min: 1, max: 1 },
  };
}

function mysqlConfig() {
  return {
    client: "mysql2",
    connection: {
      host: required("DB_HOST", "127.0.0.1"),
      port: Number(required("DB_PORT", "3306")),
      database: required("DB_NAME", "meeting_asr"),
      user: required("DB_USER", "root"),
      password: process.env.DB_PASSWORD || "",
      // 与现有 TEXT ISO8601 存储对齐：日期以字符串返回，不做本地时区转换
      dateStrings: true,
      timezone: "Z",
      charset: "utf8mb4",
    },
    pool: { min: 2, max: 10 },
  };
}

function mssqlConfig() {
  return {
    client: "mssql",
    connection: {
      server: required("DB_HOST", "127.0.0.1"),
      port: Number(required("DB_PORT", "1433")),
      database: required("DB_NAME", "meeting_asr"),
      user: required("DB_USER", "sa"),
      password: process.env.DB_PASSWORD || "",
      options: {
        // 外部内网实例默认不开 TLS；如启用请设 DB_ENCRYPT=true
        encrypt: String(process.env.DB_ENCRYPT || "false").toLowerCase() === "true",
        trustServerCertificate: true,
      },
    },
    pool: { min: 2, max: 10 },
  };
}

const CONFIG_BUILDERS = { sqlite: sqliteConfig, mysql: mysqlConfig, mssql: mssqlConfig };

/**
 * 创建 knex 实例（可注入 dbType 便于测试）
 */
export function createKnexInstance(dbType = getDbType()) {
  const db = knex(CONFIG_BUILDERS[dbType]());

  if (dbType === "sqlite") {
    // SQLite 连接级优化：WAL + busy_timeout
    db.raw("PRAGMA journal_mode = WAL").catch((error) => {
      console.error(
        `[DB] WAL mode 开启失败（${error instanceof Error ? error.message : String(error)}），` +
          "若在 Docker bind mount 下运行请改用 named volume。"
      );
    });
    db.raw("PRAGMA busy_timeout = 5000").catch(() => {});
  }

  console.log(`[DB] knex 工厂就绪: db_type=${dbType}`);
  return db;
}

/**
 * 获取全局单例 knex 实例
 */
export function getKnex() {
  if (!instance) {
    instance = createKnexInstance();
  }
  return instance;
}

/**
 * 关闭连接池（测试/优雅退出用）
 */
export async function closeKnex() {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}

export { SUPPORTED_DB_TYPES };
