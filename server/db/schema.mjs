/**
 * 跨库 schema 定义与迁移（PR-B）
 *
 * 由 AsyncDb 驱动，knex schema builder 生成三库 DDL：
 *   - 主键统一 string(64)（UUID，无自增）——MSSQL 的 TEXT 类型不能作主键，
 *     必须用 varchar/nvarchar，这是放弃原生 DDL 字符串改用 builder 的根本原因
 *   - 时间统一 string(32) 存 ISO8601
 *   - 0/1 标志用 integer（MSSQL BIT 会返回布尔，跨库行为不一致，避免）
 *
 * 迁移机制沿用原 schema_version 表 + MIGRATIONS 数组，up 改为 async。
 */
import { extractRows, listTableColumns } from "./async-db.mjs";

/**
 * 幂等建表：hasTable 检查后 createTable。
 * 不用 knex 的 createTableIfNotExists——它在表已存在时会重复执行
 * unique 索引语句（CREATE UNIQUE INDEX ... IF NOT EXISTS 不受保护）而报错。
 *
 * `hasTable()` + `CREATE TABLE` 不是原子操作（legacy 的
 * `CREATE TABLE IF NOT EXISTS` 才是）。同一个进程里的两个模块图由
 * `server/db-shared.mjs` 的 globalThis single-flight 串起来；这里再兜一层
 * 「已经存在」的竞态（跨进程场景），避免启动期直接抛错。
 */
async function createTableIfAbsent(db, tableName, builder) {
  if (await db.knex.schema.hasTable(tableName)) return;
  try {
    await db.knex.schema.createTable(tableName, builder);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists|already an object named/i.test(message)) return;
    throw error;
  }
}

// ---------- 建表定义（createTables 与迁移共用） ----------

function defineMeetingAudioRecordingsTable(t) {
  t.string("id", 64).primary();
  t.string("capture_session_id", 64).notNullable().unique();
  t.string("meeting_id", 64).nullable();
  t.string("file_path", 500).nullable();
  t.string("raw_file_path", 500).nullable();
  t.string("format", 16).notNullable();
  t.string("status", 32).notNullable();
  t.bigInteger("bytes").notNullable().defaultTo(0);
  t.float("duration_seconds").notNullable().defaultTo(0);
  t.integer("sample_rate").notNullable().defaultTo(16000);
  t.integer("bitrate_kbps").nullable();
  t.text("error_message").nullable();
  t.string("created_at", 32).notNullable();
  t.string("updated_at", 32).notNullable();
  t.string("expires_at", 32).nullable();
  t.foreign("meeting_id").references("meetings.id").onDelete("CASCADE");
}

function defineMeetingLlmResultsTable(t) {
  t.string("id", 64).primary();
  t.string("meeting_id", 64).notNullable();
  t.text("input_transcript_snapshot").notNullable();
  t.string("llm_setting_mark", 64).notNullable();
  t.string("prompt_template_id", 64).notNullable();
  t.text("generation_config_snapshot").notNullable();
  t.string("generation_mode", 64).notNullable();
  t.string("status", 32).notNullable();
  t.integer("version_no").notNullable();
  t.string("result_type", 64).notNullable();
  t.string("result_title", 255).notNullable();
  t.text("raw_prompt").notNullable();
  t.text("raw_response").notNullable();
  t.text("result_markdown").notNullable();
  t.text("error_message").nullable();
  t.string("created_at", 32).notNullable();
  t.unique(["meeting_id", "version_no"]);
  t.foreign("meeting_id").references("meetings.id").onDelete("CASCADE");
  t.foreign("prompt_template_id").references("llm_prompt_templates.id").onDelete("NO ACTION");
}

function defineMeetingSendRecordsTable(t) {
  t.string("id", 64).primary();
  t.string("meeting_llm_result_id", 64).notNullable();
  t.string("mail_template_type", 64).notNullable();
  t.string("subject", 500).notNullable();
  t.text("to_recipients_json").notNullable();
  t.text("cc_recipients_json").notNullable();
  t.text("body_markdown").notNullable();
  t.text("body_html").notNullable();
  t.string("status", 32).notNullable();
  t.string("mail_setting_mark", 64).notNullable();
  t.text("mail_config_snapshot").notNullable();
  t.string("provider_type", 64).notNullable();
  t.string("provider_message_id", 255).nullable();
  t.text("error_message").nullable();
  t.string("sent_by_user_id", 64).notNullable();
  t.string("created_at", 32).notNullable();
  t.string("sent_at", 32).nullable();
  t.foreign("meeting_llm_result_id").references("meeting_llm_results.id").onDelete("CASCADE");
  t.foreign("sent_by_user_id").references("users.id").onDelete("NO ACTION");
}

// ---------- 初始化 ----------

/**
 * 建全部业务表（IF NOT EXISTS，幂等）
 */
export async function createTables(db) {
  const s = db.knex.schema;

  await createTableIfAbsent(db, "app_settings", (t) => {
    t.string("item_section", 64).notNullable();
    t.string("item_mark", 64).notNullable();
    t.string("item_title", 255).notNullable();
    t.string("item_description", 500).notNullable().defaultTo("");
    t.text("item_value").notNullable();
    t.string("updated_at", 32).notNullable();
    t.primary(["item_section", "item_mark"]);
  });

  await createTableIfAbsent(db, "llm_prompt_templates", (t) => {
    t.string("id", 64).primary();
    t.string("template_key", 64).notNullable().unique();
    t.string("template_name", 255).notNullable();
    t.string("template_type", 64).notNullable();
    t.text("content").notNullable();
    t.string("description", 500).notNullable().defaultTo("");
    t.string("status", 32).notNullable();
    t.integer("is_system").notNullable().defaultTo(0);
    t.string("created_at", 32).notNullable();
    t.string("updated_at", 32).notNullable();
  });

  await createTableIfAbsent(db, "asr_hotwords", (t) => {
    t.string("id", 64).primary();
    t.string("term", 255).notNullable().unique();
    t.integer("weight").notNullable();
    t.string("status", 32).notNullable();
    t.string("note", 500).notNullable().defaultTo("");
    t.string("created_at", 32).notNullable();
    t.string("updated_at", 32).notNullable();
  });

  await createTableIfAbsent(db, "users", (t) => {
    t.string("id", 64).primary();
    t.string("account_name", 255).notNullable().unique();
    t.string("display_name", 255).notNullable();
    t.string("email", 255).nullable();
    t.string("department", 255).nullable();
    t.string("external_user_id", 255).nullable();
    t.string("password_hash", 255).nullable();
    t.integer("must_change_password").notNullable().defaultTo(0);
    t.string("last_login_at", 32).nullable();
    t.string("status", 32).notNullable();
    t.string("created_at", 32).notNullable();
    t.string("updated_at", 32).notNullable();
  });

  await createTableIfAbsent(db, "roles", (t) => {
    t.string("id", 64).primary();
    t.string("role_key", 64).notNullable().unique();
    t.string("role_name", 255).notNullable();
    t.string("created_at", 32).notNullable();
  });

  await createTableIfAbsent(db, "user_roles", (t) => {
    t.string("id", 64).primary();
    t.string("user_id", 64).notNullable();
    t.string("role_id", 64).notNullable();
    t.string("created_at", 32).notNullable();
    t.unique(["user_id", "role_id"]);
    t.foreign("user_id").references("users.id").onDelete("CASCADE");
    t.foreign("role_id").references("roles.id").onDelete("CASCADE");
  });

  await createTableIfAbsent(db, "auth_sessions", (t) => {
    t.string("id", 64).primary();
    t.string("user_id", 64).notNullable();
    t.string("token_hash", 128).notNullable().unique();
    t.string("expires_at", 32).notNullable();
    t.string("created_at", 32).notNullable();
    t.string("last_seen_at", 32).notNullable();
    t.foreign("user_id").references("users.id").onDelete("CASCADE");
  });

  await createTableIfAbsent(db, "meetings", (t) => {
    t.string("id", 64).primary();
    t.string("title", 255).notNullable();
    t.string("source_type", 64).notNullable();
    t.string("source_file_name", 255).nullable();
    t.integer("duration_seconds").nullable();
    t.string("status", 32).notNullable();
    t.string("status_updated_at", 32).notNullable();
    t.text("last_error_message").nullable();
    t.string("created_by_user_id", 64).notNullable();
    t.string("created_by_user_name", 255).notNullable();
    t.string("created_by_user_email", 255).nullable();
    t.string("created_at", 32).notNullable();
    t.string("updated_at", 32).notNullable();
    t.foreign("created_by_user_id").references("users.id").onDelete("NO ACTION");
  });

  await createTableIfAbsent(db, "meeting_asr_results", (t) => {
    t.string("id", 64).primary();
    t.string("meeting_id", 64).notNullable();
    t.string("asr_provider", 64).notNullable();
    t.string("asr_setting_mark", 64).notNullable();
    t.text("asr_config_snapshot").notNullable();
    t.string("capture_session_id", 64).notNullable();
    t.string("result_format", 64).notNullable();
    t.text("raw_payload").notNullable();
    t.text("normalized_text").notNullable();
    t.string("created_at", 32).notNullable();
    t.foreign("meeting_id").references("meetings.id").onDelete("CASCADE");
  });

  await createTableIfAbsent(db, "meeting_llm_results", defineMeetingLlmResultsTable);

  await createTableIfAbsent(db, "meeting_audio_recordings", defineMeetingAudioRecordingsTable);

  await createTableIfAbsent(db, "meeting_send_records", defineMeetingSendRecordsTable);

  await createTableIfAbsent(db, "asr_capture_sessions", (t) => {
    t.string("capture_session_id", 64).primary();
    t.string("task_id", 64).notNullable();
    t.string("asr_provider", 64).notNullable();
    t.text("asr_config_snapshot").notNullable();
    t.text("hotwords_json").notNullable();
    t.string("status", 32).notNullable();
    t.string("created_at", 32).notNullable();
    t.string("updated_at", 32).notNullable();
    t.string("expires_at", 32).notNullable();
  });

  await createTableIfAbsent(db, "asr_capture_events", (t) => {
    t.string("id", 64).primary();
    t.string("capture_session_id", 64).notNullable();
    t.integer("sequence_no").notNullable();
    t.text("event_json").notNullable();
    t.string("received_at", 32).notNullable();
    t.unique(["capture_session_id", "sequence_no"]);
    t.foreign("capture_session_id").references("asr_capture_sessions.capture_session_id").onDelete("CASCADE");
  });

  await createTableIfAbsent(db, "audit_logs", (t) => {
    t.string("id", 64).primary();
    t.string("actor_user_id", 64).notNullable();
    t.string("actor_account_name", 255).notNullable();
    t.string("actor_display_name", 255).notNullable();
    t.string("action_type", 64).notNullable();
    t.string("resource_type", 64).notNullable();
    t.string("resource_id", 64).notNullable();
    t.string("resource_name", 255).nullable();
    t.string("request_id", 64).nullable();
    t.string("result", 32).notNullable();
    t.text("error_message").nullable();
    t.text("before_snapshot").nullable();
    t.text("after_snapshot").nullable();
    t.string("created_at", 32).notNullable();
  });
}

/** 索引清单（表 / 列 / 名）—— 与迁移解耦，供三库按方言建索引 */
export const INDEXES = [
  { name: "idx_meeting_asr_results_meeting_created", table: "meeting_asr_results", columns: ["meeting_id", "created_at"] },
  { name: "idx_meeting_send_records_llm_created", table: "meeting_send_records", columns: ["meeting_llm_result_id", "created_at"] },
  { name: "idx_asr_capture_sessions_expires", table: "asr_capture_sessions", columns: ["expires_at"] },
  { name: "idx_auth_sessions_expires", table: "auth_sessions", columns: ["expires_at"] },
  { name: "idx_user_roles_role", table: "user_roles", columns: ["role_id"] },
  { name: "idx_audit_logs_created", table: "audit_logs", columns: ["created_at"] },
  { name: "idx_audit_logs_resource", table: "audit_logs", columns: ["resource_type", "resource_id"] },
  { name: "idx_meetings_owner_created", table: "meetings", columns: ["created_by_user_id", "created_at"] },
  { name: "idx_auth_sessions_user", table: "auth_sessions", columns: ["user_id"] },
  { name: "idx_meeting_llm_results_meeting_version_created", table: "meeting_llm_results", columns: ["meeting_id", "version_no", "created_at"] },
  { name: "idx_meeting_audio_recordings_meeting", table: "meeting_audio_recordings", columns: ["meeting_id"] },
  { name: "idx_meeting_audio_recordings_expires", table: "meeting_audio_recordings", columns: ["expires_at"] },
];

/**
 * 幂等建索引（单条）
 *
 * SQLite / MySQL(MariaDB) 支持 `CREATE INDEX IF NOT EXISTS`，MSSQL 不支持
 * （`Msg 156 … Incorrect syntax near the keyword 'IF'`），所以 mssql 分支先查
 * sys.indexes 再建。sqlite/mysql 的 SQL 文本与改动前逐字一致（现网行为不变）。
 */
async function createIndexIfAbsent(db, { name, table, columns }) {
  if (db.dbType === "mssql") {
    const existing = extractRows(
      await db.knex.raw("SELECT name FROM sys.indexes WHERE name = ? AND object_id = OBJECT_ID(?)", [
        name,
        table,
      ])
    );
    if (existing.length > 0) return;
    await db.knex.raw(
      `CREATE INDEX [${name}] ON [${table}] (${columns.map((column) => `[${column}]`).join(", ")})`
    );
    return;
  }
  await db.knex.raw(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(", ")})`);
}

/**
 * 索引创建（迁移之后执行）
 *
 * 放在迁移后是因为：v1 迁移会重建 meeting_llm_results / meeting_send_records 表，
 * 旧表上的索引会随 RENAME+DROP 丢失；统一在迁移后重建（IF NOT EXISTS 幂等）。
 */
export async function createIndexes(db) {
  for (const index of INDEXES) {
    await createIndexIfAbsent(db, index);
  }
}

// ---------- 迁移 ----------

export const MIGRATIONS = [
  {
    version: 4,
    name: "schema-version-single-row",
    async up() {
      // fix-261101-02（issue #51）：治愈版本记账。
      // 真正的收敛动作由 runMigrations 的记账收尾统一完成（DELETE 全表 + INSERT 单行，
      // 三库通用、不依赖唯一键），本条迁移只负责把版本号推进到 SCHEMA_VERSION，
      // 使被污染的库（如 [2, 3, 3]）在升级时必然经过一次单行化写入。
    },
  },
  {
    version: 3,
    name: "meeting-audio-recordings",
    async up(db) {
      // feat-261101-01：会议录音表。新库走 createTables 的基线建表，旧库在此补建，
      // 两处共用同一个 defineMeetingAudioRecordingsTable（幂等）。
      await createTableIfAbsent(db, "meeting_audio_recordings", defineMeetingAudioRecordingsTable);
    },
  },
  {
    version: 2,
    name: "drop-capture-sessions-raw-events-json",
    async up(db) {
      const columns = await listTableColumns(db, "asr_capture_sessions");
      if (!columns.includes("raw_events_json")) return;
      await db.exec("ALTER TABLE asr_capture_sessions DROP COLUMN raw_events_json");
    },
  },
  {
    version: 1,
    name: "meeting-llm-results-meeting-id",
    async up(db) {
      const columns = await listTableColumns(db, "meeting_llm_results");
      if (!columns.length) return;
      if (columns.includes("meeting_id")) return;

      // 旧结构：把主表 RENAME 为 legacy（若 legacy 已存在说明上次迁移中断，跳过 RENAME）
      const sendCols = await listTableColumns(db, "meeting_send_records");
      if (
        sendCols.length > 0 &&
        (await listTableColumns(db, "meeting_send_records_legacy")).length === 0
      ) {
        await db.knex.schema.renameTable("meeting_send_records", "meeting_send_records_legacy");
      }
      if ((await listTableColumns(db, "meeting_llm_results_legacy")).length === 0) {
        await db.knex.schema.renameTable("meeting_llm_results", "meeting_llm_results_legacy");
      }

      await db.knex.schema.createTable("meeting_llm_results", defineMeetingLlmResultsTable);
      await db.knex.schema.createTable("meeting_send_records", defineMeetingSendRecordsTable);

      // 数据搬迁：标准 SQL + 窗口函数（三库均支持 ROW_NUMBER OVER PARTITION BY）
      await db.exec(`
        INSERT INTO meeting_llm_results (
          id, meeting_id, input_transcript_snapshot, llm_setting_mark, prompt_template_id,
          generation_config_snapshot, generation_mode, status, version_no, result_type,
          result_title, raw_prompt, raw_response, result_markdown, error_message, created_at
        )
        SELECT
          legacy.id,
          asr.meeting_id,
          COALESCE(asr.normalized_text, ''),
          legacy.llm_setting_mark,
          legacy.prompt_template_id,
          legacy.generation_config_snapshot,
          legacy.generation_mode,
          legacy.status,
          legacy.version_no,
          legacy.result_type,
          legacy.result_title,
          legacy.raw_prompt,
          legacy.raw_response,
          legacy.result_markdown,
          legacy.error_message,
          legacy.created_at
        FROM meeting_llm_results_legacy legacy
        INNER JOIN meeting_asr_results asr ON asr.id = legacy.meeting_asr_result_id
        WHERE legacy.id IN (
          SELECT id FROM (
            SELECT
              l2.id,
              ROW_NUMBER() OVER (
                PARTITION BY asr2.meeting_id, l2.version_no
                ORDER BY l2.created_at DESC, l2.id DESC
              ) AS rn
            FROM meeting_llm_results_legacy l2
            INNER JOIN meeting_asr_results asr2 ON asr2.id = l2.meeting_asr_result_id
          ) ranked
          WHERE ranked.rn = 1
        )
      `);

      await db.exec(`
        INSERT INTO meeting_send_records (
          id, meeting_llm_result_id, mail_template_type, subject,
          to_recipients_json, cc_recipients_json, body_markdown, body_html,
          status, mail_setting_mark, mail_config_snapshot, provider_type,
          provider_message_id, error_message, sent_by_user_id, created_at, sent_at
        )
        SELECT
          legacy.id, legacy.meeting_llm_result_id, legacy.mail_template_type, legacy.subject,
          legacy.to_recipients_json, legacy.cc_recipients_json, legacy.body_markdown, legacy.body_html,
          legacy.status, legacy.mail_setting_mark, legacy.mail_config_snapshot, legacy.provider_type,
          legacy.provider_message_id, legacy.error_message, legacy.sent_by_user_id,
          legacy.created_at, legacy.sent_at
        FROM meeting_send_records_legacy legacy
        INNER JOIN meeting_llm_results current_result
          ON current_result.id = legacy.meeting_llm_result_id
      `);

      const sendLegacyExists = (await listTableColumns(db, "meeting_send_records_legacy")).length > 0;
      if (sendLegacyExists) {
        await db.knex.schema.dropTableIfExists("meeting_send_records_legacy");
      }
      await db.knex.schema.dropTableIfExists("meeting_llm_results_legacy");
    },
  },
];

/**
 * 初始化 schema：建表 + 迁移 + 索引（幂等，可重复调用）
 *
 * single-flight：同一 AsyncDb 实例上并发调用共享同一个 in-flight promise，
 * 避免并发跑迁移（并发会让 AsyncDb 的 _txDepth/savepoint 链路相互交错）。
 */
export function initializeSchema(db) {
  const running = inFlightInitializations.get(db);
  if (running) return running;

  const promise = (async () => {
    await createTables(db);
    await runMigrations(db);
    await createIndexes(db);
  })().finally(() => {
    inFlightInitializations.delete(db);
  });

  inFlightInitializations.set(db, promise);
  return promise;
}

const inFlightInitializations = new WeakMap();

/** 当前代码期望的 schema 版本（= 迁移条数；版本号从 1 连续递增） */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * 版本记账写入：DELETE 全表 + INSERT 一行。
 * 不用 INSERT ... ON CONFLICT / INSERT OR REPLACE：schema_version 没有唯一键
 * （SQLite 也无法给已有表补主键），REPLACE 在没有约束冲突时就是普通 INSERT。
 * DELETE 全表 + INSERT 是 SQLite / MySQL / MSSQL 通用写法。
 */
async function writeSchemaVersion(db, version) {
  await db.prepare("DELETE FROM schema_version").run();
  await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
}

/**
 * 读版本：MAX(version)（不依赖无 ORDER BY 的隐式行序）+ 行数。
 * 行数 > 1 说明库被 issue #51 污染过，调用方负责收敛成单行。
 */
async function readSchemaVersion(db) {
  const row = await db
    .prepare("SELECT MAX(version) AS max_version, COUNT(*) AS row_count FROM schema_version")
    .get();
  return {
    maxVersion: row?.max_version == null ? 0 : Number(row.max_version),
    rowCount: Number(row?.row_count ?? 0),
  };
}

async function runMigrations(db) {
  await createTableIfAbsent(db, "schema_version", (t) => {
    t.integer("version").notNullable();
  });

  const latestVersion = SCHEMA_VERSION;
  const { maxVersion, rowCount } = await readSchemaVersion(db);
  let currentVersion = maxVersion;

  if (rowCount === 0) {
    // 无版本记录：探测结构是否已是最新（全新库直接标记最新；旧库从迁移 1 开始）
    const llmColumns = await listTableColumns(db, "meeting_llm_results");
    if (llmColumns.includes("meeting_id")) {
      currentVersion = latestVersion;
    }
  }

  // 记账收敛：行数 > 1（历史缺陷遗留）或「无记录但结构已是最新」→ 写成唯一一行。
  // 值取 MAX(现存) 而不是最新版本号：收敛只做去重，版本推进由下面的迁移循环负责。
  if (rowCount > 1 || (rowCount === 0 && currentVersion > 0)) {
    await db.withTransaction(async () => {
      await writeSchemaVersion(db, currentVersion);
    });
    if (rowCount > 1) {
      console.log(`[DB] schema_version 收敛为单行: ${rowCount} 行 → v${currentVersion}`);
    }
  }

  if (currentVersion >= latestVersion) return;

  // SQLite 迁移期间关闭外键（RENAME/DROP COLUMN 受限）；MySQL/MSSQL 无此限制
  if (db.dbType === "sqlite") {
    await db.exec("PRAGMA foreign_keys = OFF");
  }
  try {
    // 按版本升序执行（MIGRATIONS 声明顺序是新的在前，不能直接依赖）
    const sortedMigrations = [...MIGRATIONS].sort((a, b) => a.version - b.version);
    for (const migration of sortedMigrations) {
      if (migration.version <= currentVersion) continue;
      await db.withTransaction(async () => {
        await migration.up(db);
        await writeSchemaVersion(db, migration.version);
      });
      console.log(`[DB] Migration applied: v${migration.version} (${migration.name}) [knex]`);
    }
  } finally {
    if (db.dbType === "sqlite") {
      await db.exec("PRAGMA foreign_keys = ON");
    }
  }
}
