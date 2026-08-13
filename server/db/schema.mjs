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
import { listTableColumns } from "./async-db.mjs";

/**
 * 幂等建表：hasTable 检查后 createTable。
 * 不用 knex 的 createTableIfNotExists——它在表已存在时会重复执行
 * unique 索引语句（CREATE UNIQUE INDEX ... IF NOT EXISTS 不受保护）而报错。
 */
async function createTableIfAbsent(db, tableName, builder) {
  if (await db.knex.schema.hasTable(tableName)) return;
  await db.knex.schema.createTable(tableName, builder);
}

// ---------- 建表定义（createTables 与迁移共用） ----------

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
  t.foreign("prompt_template_id").references("llm_prompt_templates.id").onDelete("RESTRICT");
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
  t.foreign("sent_by_user_id").references("users.id").onDelete("RESTRICT");
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
    t.foreign("created_by_user_id").references("users.id").onDelete("RESTRICT");
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

/**
 * 索引创建（迁移之后执行）
 *
 * 放在迁移后是因为：v1 迁移会重建 meeting_llm_results / meeting_send_records 表，
 * 旧表上的索引会随 RENAME+DROP 丢失；统一在迁移后重建（IF NOT EXISTS 幂等）。
 */
export async function createIndexes(db) {
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_meeting_asr_results_meeting_created ON meeting_asr_results(meeting_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_meeting_send_records_llm_created ON meeting_send_records(meeting_llm_result_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_asr_capture_sessions_expires ON asr_capture_sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id)",
    "CREATE INDEX IF NOT EXISTS idx_meetings_owner_created ON meetings(created_by_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_meeting_llm_results_meeting_version_created ON meeting_llm_results(meeting_id, version_no, created_at)",
  ];
  for (const sql of indexes) {
    await db.knex.raw(sql);
  }
}

// ---------- 迁移 ----------

const MIGRATIONS = [
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
 */
export async function initializeSchema(db) {
  await createTables(db);
  await runMigrations(db);
  await createIndexes(db);
}

async function runMigrations(db) {
  await createTableIfAbsent(db, "schema_version", (t) => {
    t.integer("version").notNullable();
  });

  const versionRow = await db.prepare("SELECT version FROM schema_version LIMIT 1").get();
  let currentVersion = versionRow ? Number(versionRow.version) : 0;

  const latestVersion = MIGRATIONS.length;
  if (currentVersion === 0 && versionRow === null) {
    // 无版本记录：探测结构是否已是最新（全新库直接标记最新；旧库从迁移 1 开始）
    const llmColumns = await listTableColumns(db, "meeting_llm_results");
    if (llmColumns.includes("meeting_id")) {
      currentVersion = latestVersion;
      await db.prepare("DELETE FROM schema_version").run();
      await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(latestVersion);
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
        await db.prepare("DELETE FROM schema_version").run();
        await db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
      });
      console.log(`[DB] Migration applied: v${migration.version} (${migration.name})`);
    }
  } finally {
    if (db.dbType === "sqlite") {
      await db.exec("PRAGMA foreign_keys = ON");
    }
  }
}
