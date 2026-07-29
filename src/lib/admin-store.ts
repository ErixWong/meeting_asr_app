import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  escapeHtml,
  newId,
  normalizeStatus,
  nowIso,
  parseJsonOr,
  requireNonEmpty,
} from "@/lib/store-utils";

type SettingRow = {
  itemSection: string;
  itemMark: string;
  itemTitle: string;
  itemDescription: string;
  itemValue: string;
};

type PromptTemplateRow = {
  id: string;
  templateKey: string;
  templateName: string;
  templateType: string;
  content: string;
  description: string;
  status: string;
  isSystem: boolean;
};

type HotwordRow = {
  id: string;
  term: string;
  weight: number;
  status: string;
  note: string;
};

type UserRow = {
  id: string;
  accountName: string;
  displayName: string;
  email: string;
  department: string;
  status: string;
};

type RoleRow = {
  id: string;
  roleKey: string;
  roleName: string;
};

type MeetingInput = {
  title: string;
  sourceType: string;
  sourceFileName: string | null;
  durationSeconds: number | null;
  captureSessionId: string;
  transcriptSegments: Array<{
    id: string;
    speaker: string;
    speakerId?: number | null;
    text: string;
    time: string;
    timeSeconds: number;
    isFinal: boolean;
  }>;
};

type MeetingLlmResultRow = {
  id: string;
  meetingAsrResultId: string;
  llmSettingMark: string;
  promptTemplateId: string;
  generationConfigSnapshot: string;
  generationMode: string;
  status: string;
  versionNo: number;
  resultType: string;
  resultTitle: string;
  rawPrompt: string;
  rawResponse: string;
  resultMarkdown: string;
  errorMessage: string | null;
};

type MeetingSendRecordRow = {
  id: string;
  meetingLlmResultId: string;
  mailTemplateType: string;
  subject: string;
  toRecipientsJson: string;
  ccRecipientsJson: string;
  bodyMarkdown: string;
  bodyHtml: string;
  status: string;
  mailSettingMark: string;
  mailConfigSnapshot: string;
  providerType: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  sentByUserId: string;
};

type AsrCaptureSessionRow = {
  captureSessionId: string;
  taskId: string;
  asrProvider: string;
  asrConfigSnapshot: string;
  hotwordsJson: string;
  rawEventsJson: string;
  status: string;
};

type ActorContext = {
  id: string;
  accountName: string;
  displayName: string;
  status: string;
  mustChangePassword?: boolean;
};

type PasswordVerificationResult = {
  ok: boolean;
  needsRehash: boolean;
};

const PASSWORD_SCHEME = "scrypt-v1";
const SESSION_TTL_DAYS = 7;

const dataDir = join(process.cwd(), "data");
const dbPath = join(dataDir, "meeting-asr-app.db");

let db: DatabaseSync | null = null;
const actorContext = new AsyncLocalStorage<ActorContext>();

function getDb() {
  if (db) return db;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      item_section TEXT NOT NULL,
      item_mark TEXT NOT NULL,
      item_title TEXT NOT NULL,
      item_description TEXT NOT NULL DEFAULT '',
      item_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_section, item_mark)
    );

    CREATE TABLE IF NOT EXISTS llm_prompt_templates (
      id TEXT PRIMARY KEY,
      template_key TEXT NOT NULL UNIQUE,
      template_name TEXT NOT NULL,
      template_type TEXT NOT NULL,
      content TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asr_hotwords (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL UNIQUE,
      weight INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_file_name TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL,
      status_updated_at TEXT NOT NULL,
      last_error_message TEXT,
      created_by_user_id TEXT NOT NULL,
      created_by_user_name TEXT NOT NULL,
      created_by_user_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_asr_results (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      asr_provider TEXT NOT NULL,
      asr_setting_mark TEXT NOT NULL,
      asr_config_snapshot TEXT NOT NULL,
      capture_session_id TEXT NOT NULL,
      result_format TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_llm_results (
      id TEXT PRIMARY KEY,
      meeting_asr_result_id TEXT NOT NULL,
      llm_setting_mark TEXT NOT NULL,
      prompt_template_id TEXT NOT NULL,
      generation_config_snapshot TEXT NOT NULL,
      generation_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      result_type TEXT NOT NULL,
      result_title TEXT NOT NULL,
      raw_prompt TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      result_markdown TEXT NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_send_records (
      id TEXT PRIMARY KEY,
      meeting_llm_result_id TEXT NOT NULL,
      mail_template_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      to_recipients_json TEXT NOT NULL,
      cc_recipients_json TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      body_html TEXT NOT NULL,
      status TEXT NOT NULL,
      mail_setting_mark TEXT NOT NULL,
      mail_config_snapshot TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_message_id TEXT,
      error_message TEXT,
      sent_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS asr_capture_sessions (
      capture_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      asr_provider TEXT NOT NULL,
      asr_config_snapshot TEXT NOT NULL,
      hotwords_json TEXT NOT NULL,
      raw_events_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT,
      department TEXT,
      external_user_id TEXT,
      password_hash TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      role_key TEXT NOT NULL UNIQUE,
      role_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      actor_account_name TEXT NOT NULL,
      actor_display_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      resource_name TEXT,
      request_id TEXT,
      result TEXT NOT NULL,
      error_message TEXT,
      before_snapshot TEXT,
      after_snapshot TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);

  migrateAuthSchema(db);
  seedDefaults(db);
  return db;
}

function migrateAuthSchema(database: DatabaseSync) {
  ensureColumn(database, "users", "password_hash", "TEXT");
  ensureColumn(database, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(database, "users", "last_login_at", "TEXT");
}

function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, definition: string) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return;
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function seedDefaults(database: DatabaseSync) {
  const templateCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM llm_prompt_templates").get()?.count ?? 0
  );
  const hotwordCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM asr_hotwords").get()?.count ?? 0
  );

  seedIdentityDefaults(database);

  const defaults: SettingRow[] = [
      {
        itemSection: "asr",
        itemMark: "provider",
        itemTitle: "ASR Provider",
        itemDescription: "当前 ASR 提供方",
        itemValue: "local_funasr",
      },
      {
        itemSection: "asr",
        itemMark: "endpoint",
        itemTitle: "FunASR Endpoint",
        itemDescription: "FunASR 服务地址",
        itemValue: "ws://funasr.local:10095/ws",
      },
      {
        itemSection: "asr",
        itemMark: "api_key",
        itemTitle: "ASR API Key",
        itemDescription: "DashScope API Key",
        itemValue: "",
      },
      {
        itemSection: "asr",
        itemMark: "workspace_id",
        itemTitle: "ASR Workspace ID",
        itemDescription: "DashScope Workspace ID",
        itemValue: "",
      },
      {
        itemSection: "llm",
        itemMark: "base_url",
        itemTitle: "LLM URL",
        itemDescription: "OpenAI 兼容服务根地址",
        itemValue: "http://qwen.local:8080/v1",
      },
      {
        itemSection: "llm",
        itemMark: "api_key",
        itemTitle: "LLM API Key",
        itemDescription: "LLM API Key",
        itemValue: "",
      },
      {
        itemSection: "llm",
        itemMark: "model",
        itemTitle: "LLM Model",
        itemDescription: "当前使用模型",
        itemValue: "qwen3.6-35b",
      },
      {
        itemSection: "mail",
        itemMark: "smtp_host",
        itemTitle: "SMTP Host",
        itemDescription: "邮件服务主机",
        itemValue: "smtp.example.com",
      },
      {
        itemSection: "mail",
        itemMark: "smtp_port",
        itemTitle: "SMTP Port",
        itemDescription: "邮件服务端口",
        itemValue: "465",
      },
      {
        itemSection: "mail",
        itemMark: "smtp_username",
        itemTitle: "SMTP Username",
        itemDescription: "邮件服务用户名",
        itemValue: "meeting@example.com",
      },
      {
        itemSection: "mail",
        itemMark: "smtp_password",
        itemTitle: "SMTP Password",
        itemDescription: "邮件服务密码",
        itemValue: "",
      },
      {
        itemSection: "mail",
        itemMark: "from_name",
        itemTitle: "From Name",
        itemDescription: "发件人名称",
        itemValue: "会议纪要机器人",
      },
      {
        itemSection: "mail",
        itemMark: "from_email",
        itemTitle: "From Email",
        itemDescription: "发件人邮箱",
        itemValue: "meeting@example.com",
      },
      {
        itemSection: "mail",
        itemMark: "default_subject_template",
        itemTitle: "Default Subject",
        itemDescription: "默认邮件主题模板",
        itemValue: "[会议纪要] {meetingTitle} - {meetingDate}",
      },
      {
        itemSection: "mail",
        itemMark: "default_signature",
        itemTitle: "Default Signature",
        itemDescription: "默认邮件签名",
        itemValue: "会议纪要系统",
      },
      {
        itemSection: "mail",
        itemMark: "default_cc",
        itemTitle: "Default CC",
        itemDescription: "默认抄送",
        itemValue: "[]",
      },
      {
        itemSection: "system",
        itemMark: "default_prompt_template_id",
        itemTitle: "默认纪要模板",
        itemDescription: "自动生成首版结果时使用",
        itemValue: "tpl-1",
      },
  ];

  for (const setting of defaults) {
    insertMissingSetting(database, setting);
  }

  if (templateCount === 0) {
    const templates: PromptTemplateRow[] = [
      {
        id: "tpl-1",
        templateKey: "standard_minutes",
        templateName: "标准会议纪要",
        templateType: "minutes",
        content:
          "你是一个专业的会议纪要助手。请基于以下会议转写内容，输出结构化的会议纪要。\n\n会议转写内容：\n{transcript}",
        description: "适用于常规项目会议",
        status: "active",
        isSystem: true,
      },
      {
        id: "tpl-2",
        templateKey: "action_items_only",
        templateName: "行动项抽取",
        templateType: "actions",
        content: "请仅提取行动项、负责人、截止时间。\n\n会议转写内容：\n{transcript}",
        description: "适合任务导向输出",
        status: "active",
        isSystem: true,
      },
    ];

    for (const template of templates) {
      upsertPromptTemplate(template);
    }
  }

  if (hotwordCount === 0) {
    const hotwords: HotwordRow[] = [
      { id: "hw-1", term: "阿里巴巴", weight: 20, status: "active", note: "公司名称" },
      { id: "hw-2", term: "达摩院", weight: 15, status: "active", note: "组织名称" },
      { id: "hw-3", term: "语音识别", weight: 10, status: "disabled", note: "领域词" },
    ];

    for (const hotword of hotwords) {
      upsertHotword(hotword);
    }
  }
}

function insertMissingSetting(database: DatabaseSync, setting: SettingRow) {
  database
    .prepare(`
      INSERT OR IGNORE INTO app_settings (item_section, item_mark, item_title, item_description, item_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      setting.itemSection,
      setting.itemMark,
      setting.itemTitle,
      setting.itemDescription,
      setting.itemValue,
      nowIso()
    );
}

function upsertSetting(setting: SettingRow) {
  const database = getDb();
  database
    .prepare(`
      INSERT INTO app_settings (item_section, item_mark, item_title, item_description, item_value, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_section, item_mark) DO UPDATE SET
        item_title = excluded.item_title,
        item_description = excluded.item_description,
        item_value = excluded.item_value,
        updated_at = excluded.updated_at
    `)
    .run(
      setting.itemSection,
      setting.itemMark,
      setting.itemTitle,
      setting.itemDescription,
      setting.itemValue,
      nowIso()
    );
}

function upsertPromptTemplate(template: PromptTemplateRow) {
  const database = getDb();
  const existing = database
    .prepare("SELECT created_at as createdAt FROM llm_prompt_templates WHERE id = ?")
    .get(template.id) as { createdAt?: string } | undefined;

  database
    .prepare(`
      INSERT INTO llm_prompt_templates (id, template_key, template_name, template_type, content, description, status, is_system, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template_key = excluded.template_key,
        template_name = excluded.template_name,
        template_type = excluded.template_type,
        content = excluded.content,
        description = excluded.description,
        status = excluded.status,
        is_system = excluded.is_system,
        updated_at = excluded.updated_at
    `)
    .run(
      template.id,
      template.templateKey,
      template.templateName,
      template.templateType,
      template.content,
      template.description,
      template.status,
      template.isSystem ? 1 : 0,
      existing?.createdAt ?? nowIso(),
      nowIso()
    );
}

function upsertHotword(hotword: HotwordRow) {
  const database = getDb();
  const existing = database
    .prepare("SELECT created_at as createdAt FROM asr_hotwords WHERE id = ?")
    .get(hotword.id) as { createdAt?: string } | undefined;

  database
    .prepare(`
      INSERT INTO asr_hotwords (id, term, weight, status, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        term = excluded.term,
        weight = excluded.weight,
        status = excluded.status,
        note = excluded.note,
        updated_at = excluded.updated_at
    `)
    .run(
      hotword.id,
      hotword.term,
      hotword.weight,
      hotword.status,
      hotword.note,
      existing?.createdAt ?? nowIso(),
      nowIso()
    );
}

export function listSettings() {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        item_section as itemSection,
        item_mark as itemMark,
        item_title as itemTitle,
        item_description as itemDescription,
        item_value as itemValue,
        updated_at as updatedAt
      FROM app_settings
      ORDER BY item_section, item_mark
    `)
    .all();
}

export function saveSettings(settings: SettingRow[]) {
  for (const setting of settings) {
    upsertSetting(setting);
  }
  writeAuditLog({
    actionType: "settings.update",
    resourceType: "settings",
    resourceId: "app_settings",
    afterSnapshot: settings.map((setting) => ({
      ...setting,
      itemValue: setting.itemMark.includes("key") || setting.itemMark.includes("password")
        ? "***"
        : setting.itemValue,
    })),
  });
}

export function listPromptTemplates() {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        id,
        template_key as templateKey,
        template_name as templateName,
        template_type as templateType,
        content,
        description,
        status,
        is_system as isSystem,
        created_at as createdAt,
        updated_at as updatedAt
      FROM llm_prompt_templates
      ORDER BY created_at ASC
    `)
    .all()
    .map((row: any) => ({ ...row, isSystem: Boolean(row.isSystem) }));
}

export function createPromptTemplate(input: Omit<PromptTemplateRow, "id" | "isSystem"> & { isSystem?: boolean }) {
  const template: PromptTemplateRow = {
    id: newId("tpl"),
    isSystem: input.isSystem ?? false,
    templateKey: requireNonEmpty(input.templateKey, "Template key"),
    templateName: requireNonEmpty(input.templateName, "Template name"),
    templateType: requireNonEmpty(input.templateType, "Template type"),
    content: requireNonEmpty(input.content, "Template content"),
    description: input.description ?? "",
    status: normalizeStatus(input.status),
  };
  upsertPromptTemplate(template);
  const created = listPromptTemplates().find((item: any) => item.id === template.id);
  writeAuditLog({
    actionType: "prompt_template.create",
    resourceType: "prompt_template",
    resourceId: template.id,
    resourceName: template.templateName,
    afterSnapshot: created,
  });
  return created;
}

export function updatePromptTemplate(id: string, patch: Partial<Omit<PromptTemplateRow, "id">>) {
  const existing = listPromptTemplates().find((item: any) => item.id === id);
  if (!existing) return null;

  const next: PromptTemplateRow = {
    id,
    templateKey: patch.templateKey === undefined ? existing.templateKey : requireNonEmpty(patch.templateKey, "Template key"),
    templateName: patch.templateName === undefined ? existing.templateName : requireNonEmpty(patch.templateName, "Template name"),
    templateType: patch.templateType === undefined ? existing.templateType : requireNonEmpty(patch.templateType, "Template type"),
    content: patch.content === undefined ? existing.content : requireNonEmpty(patch.content, "Template content"),
    description: patch.description ?? existing.description,
    status: patch.status === undefined ? existing.status : normalizeStatus(patch.status, existing.status),
    isSystem: patch.isSystem ?? existing.isSystem,
  };

  upsertPromptTemplate(next);
  const updated = listPromptTemplates().find((item: any) => item.id === id);
  writeAuditLog({
    actionType: "prompt_template.update",
    resourceType: "prompt_template",
    resourceId: id,
    resourceName: updated?.templateName ?? existing.templateName,
    beforeSnapshot: existing,
    afterSnapshot: updated,
  });
  return updated;
}

export function listHotwords() {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        id,
        term,
        weight,
        status,
        note,
        created_at as createdAt,
        updated_at as updatedAt
      FROM asr_hotwords
      ORDER BY created_at ASC
    `)
    .all();
}

export function createHotword(input: Omit<HotwordRow, "id">) {
  const hotword: HotwordRow = {
    id: newId("hw"),
    term: requireNonEmpty(input.term, "Hotword term"),
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 10,
    status: normalizeStatus(input.status),
    note: input.note ?? "",
  };
  upsertHotword(hotword);
  const created = listHotwords().find((item: any) => item.id === hotword.id);
  writeAuditLog({
    actionType: "hotword.create",
    resourceType: "hotword",
    resourceId: hotword.id,
    resourceName: hotword.term,
    afterSnapshot: created,
  });
  return created;
}

export function updateHotword(id: string, patch: Partial<Omit<HotwordRow, "id">>) {
  const existing = listHotwords().find((item: any) => item.id === id);
  if (!existing) return null;

  const next: HotwordRow = {
    id,
    term: patch.term === undefined ? existing.term : requireNonEmpty(patch.term, "Hotword term"),
    weight: patch.weight === undefined || !Number.isFinite(Number(patch.weight)) ? existing.weight : Number(patch.weight),
    status: patch.status === undefined ? existing.status : normalizeStatus(patch.status, existing.status),
    note: patch.note ?? existing.note,
  };

  upsertHotword(next);
  const updated = listHotwords().find((item: any) => item.id === id);
  writeAuditLog({
    actionType: "hotword.update",
    resourceType: "hotword",
    resourceId: id,
    resourceName: updated?.term ?? existing.term,
    beforeSnapshot: existing,
    afterSnapshot: updated,
  });
  return updated;
}
export function deleteHotword(id: string) {
  const existing = listHotwords().find((item: any) => item.id === id);
  const result = getDb().prepare("DELETE FROM asr_hotwords WHERE id = ?").run(id);
  const deleted = Number(result.changes ?? 0) > 0;
  if (!deleted) return false;

  writeAuditLog({
    actionType: "hotword.delete",
    resourceType: "hotword",
    resourceId: id,
    resourceName: existing?.term ?? id,
    beforeSnapshot: existing,
  });
  return true;
}

export function listRoles() {
  return getDb()
    .prepare(`
      SELECT
        id,
        role_key as roleKey,
        role_name as roleName,
        created_at as createdAt
      FROM roles
      ORDER BY role_key ASC
    `)
    .all();
}

export function listUsers() {
  const users = getDb()
    .prepare(`
      SELECT
        id,
        account_name as accountName,
        display_name as displayName,
        email,
        department,
        status,
        created_at as createdAt,
        updated_at as updatedAt
      FROM users
      ORDER BY created_at ASC
    `)
    .all() as any[];

  return users.map((user) => ({
    ...user,
    roles: listUserRoles(user.id),
  }));
}

function listUserRoles(userId: string) {
  return getDb()
    .prepare(`
      SELECT
        r.id,
        r.role_key as roleKey,
        r.role_name as roleName
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_key ASC
    `)
    .all(userId);
}

export function createUser(input: Omit<UserRow, "id"> & { roleKeys?: string[] }) {
  const id = newId("user");
  const createdAt = nowIso();
  const accountName = requireNonEmpty(input.accountName, "Account name");
  const displayName = requireNonEmpty(input.displayName, "Display name");
  getDb()
    .prepare(`
      INSERT INTO users (
        id, account_name, display_name, email, department, external_user_id,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      accountName,
      displayName,
      input.email,
      input.department,
      null,
      normalizeStatus(input.status),
      createdAt,
      createdAt
    );

  setUserRoleKeys(id, input.roleKeys ?? ["user"]);
  const user = listUsers().find((item: any) => item.id === id);
  writeAuditLog({
    actionType: "user.create",
    resourceType: "user",
    resourceId: id,
    resourceName: accountName,
    afterSnapshot: user,
  });
  return user;
}

export function updateUser(id: string, patch: Partial<Omit<UserRow, "id">> & { roleKeys?: string[] }) {
  const before = listUsers().find((item: any) => item.id === id);
  if (!before) return null;
  ensureUserChangeAllowed(id, patch);

  getDb()
    .prepare(`
      UPDATE users
      SET account_name = ?, display_name = ?, email = ?, department = ?, status = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(
      patch.accountName === undefined ? before.accountName : requireNonEmpty(patch.accountName, "Account name"),
      patch.displayName === undefined ? before.displayName : requireNonEmpty(patch.displayName, "Display name"),
      patch.email ?? before.email,
      patch.department ?? before.department,
      patch.status === undefined ? before.status : normalizeStatus(patch.status, before.status),
      nowIso(),
      id
    );

  if (patch.roleKeys !== undefined) {
    setUserRoleKeys(id, patch.roleKeys);
  }

  const after = listUsers().find((item: any) => item.id === id);
  writeAuditLog({
    actionType: "user.update",
    resourceType: "user",
    resourceId: id,
    resourceName: after?.accountName ?? before.accountName,
    beforeSnapshot: before,
    afterSnapshot: after,
  });
  return after;
}

export function setUserRoleKeys(userId: string, roleKeys: string[]) {
  ensureUserRoleChangeAllowed(userId, roleKeys);
  const database = getDb();
  const roles = database
    .prepare(`SELECT id, role_key as roleKey FROM roles`)
    .all() as Array<{ id: string; roleKey: string }>;
  const selectedRoles = roles.filter((role) => roleKeys.includes(role.roleKey));
  const selectedRoleKeys = new Set(selectedRoles.map((role) => role.roleKey));
  const unknownRoleKeys = roleKeys.filter((roleKey) => !selectedRoleKeys.has(roleKey));
  if (unknownRoleKeys.length > 0) {
    throw new Error(`Unknown role keys: ${unknownRoleKeys.join(", ")}`);
  }

  database.prepare("DELETE FROM user_roles WHERE user_id = ?").run(userId);
  for (const role of selectedRoles) {
    database
      .prepare(`
      INSERT OR IGNORE INTO user_roles (id, user_id, role_id, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(newId("user-role"), userId, role.id, nowIso());
  }

  return listUsers().find((item: any) => item.id === userId) ?? null;
}

function ensureUserChangeAllowed(
  userId: string,
  patch: Partial<Omit<UserRow, "id">> & { roleKeys?: string[] }
) {
  if (userId !== "user-admin") return;

  if (patch.status === "disabled") {
    throw new Error("Bootstrap admin cannot be disabled");
  }

  if (patch.roleKeys && !patch.roleKeys.includes("system_admin")) {
    throw new Error("Bootstrap admin must keep system_admin role");
  }
}

function ensureUserRoleChangeAllowed(userId: string, roleKeys: string[]) {
  if (userId === "user-admin" && !roleKeys.includes("system_admin")) {
    throw new Error("Bootstrap admin must keep system_admin role");
  }
}

export function listAuditLogs(limit = 100) {
  return getDb()
    .prepare(`
      SELECT
        id,
        actor_user_id as actorUserId,
        actor_account_name as actorAccountName,
        actor_display_name as actorDisplayName,
        action_type as actionType,
        resource_type as resourceType,
        resource_id as resourceId,
        resource_name as resourceName,
        result,
        error_message as errorMessage,
        created_at as createdAt
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit);
}

export function getRuntimeConfig() {
  const settings = listSettings() as any[];
  const templates = listPromptTemplates() as any[];

  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const providerType = get("asr", "provider");
  const endpoint = get("asr", "endpoint");
  const asrApiKey = get("asr", "api_key");
  const workspaceId = get("asr", "workspace_id");
  const defaultPromptTemplateId = get("system", "default_prompt_template_id");
  const defaultTemplate = templates.find((item) => item.id === defaultPromptTemplateId) ?? null;

  return {
    asr: {
      providerType,
      isConfigured: providerType === "local_funasr"
        ? Boolean(endpoint)
        : Boolean(asrApiKey && workspaceId),
      hasApiKey: Boolean(asrApiKey),
      hasWorkspaceId: Boolean(workspaceId),
    },
    llm: {
      baseUrl: get("llm", "base_url"),
      model: get("llm", "model"),
      hasApiKey: Boolean(get("llm", "api_key")),
    },
    defaultPromptTemplate: defaultTemplate
      ? {
          id: defaultTemplate.id,
          templateKey: defaultTemplate.templateKey,
          templateType: defaultTemplate.templateType,
          name: defaultTemplate.templateName,
        }
      : null,
  };
}

export function listActiveHotwordMap() {
  const active = (listHotwords() as any[]).filter((item) => item.status === "active");
  return active.reduce<Record<string, number>>((acc, item) => {
    acc[item.term] = Number(item.weight);
    return acc;
  }, {});
}

function getAsrCaptureSession(captureSessionId: string) {
  if (!captureSessionId) return null;

  const row = getDb()
    .prepare(`
      SELECT
        capture_session_id as captureSessionId,
        task_id as taskId,
        asr_provider as asrProvider,
        asr_config_snapshot as asrConfigSnapshot,
        hotwords_json as hotwordsJson,
        raw_events_json as rawEventsJson,
        status
      FROM asr_capture_sessions
      WHERE capture_session_id = ?
    `)
    .get(captureSessionId) as AsrCaptureSessionRow | undefined;

  return row ?? null;
}

function redactAsrConfigSnapshot(snapshot: any) {
  return {
    providerType: snapshot?.providerType ?? snapshot?.provider ?? "unknown",
    hasEndpoint: Boolean(snapshot?.endpoint),
    hasWorkspaceId: Boolean(snapshot?.workspaceId),
    hasApiKey: Boolean(snapshot?.hasApiKey),
    hotwordCount: snapshot?.hotwords && typeof snapshot.hotwords === "object"
      ? Object.keys(snapshot.hotwords).length
      : undefined,
  };
}

function getBootstrapAdminAccount() {
  const configuredAccount = String(process.env.BOOTSTRAP_ADMIN_ACCOUNT || "").trim();
  if (configuredAccount) return configuredAccount;

  if (process.env.NODE_ENV !== "production") {
    return String(process.env.DEV_ACTOR_ACCOUNT || "admin").trim();
  }

  return "admin";
}

function getBootstrapAdminPassword() {
  const configuredPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "");
  if (configuredPassword) {
    return { password: configuredPassword, mustChangePassword: false, source: "env" as const };
  }

  const fallbackPassword = "admin123";
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[auth] BOOTSTRAP_ADMIN_PASSWORD is not set. Created bootstrap admin with default password admin123; change it immediately."
    );
  }
  return { password: fallbackPassword, mustChangePassword: true, source: "default" as const };
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return `${PASSWORD_SCHEME}$16384$8$1$${salt}$${key}`;
}

function verifyPassword(password: string, storedHash: string | null | undefined): PasswordVerificationResult {
  if (!storedHash) return { ok: false, needsRehash: false };

  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== PASSWORD_SCHEME) {
    return { ok: false, needsRehash: false };
  }

  const [, nRaw, rRaw, pRaw, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
  });

  return {
    ok: actual.length === expected.length && timingSafeEqual(actual, expected),
    needsRehash: nRaw !== "16384" || rRaw !== "8" || pRaw !== "1",
  };
}

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sessionExpiryIso() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
  return expiresAt.toISOString();
}

function seedIdentityDefaults(database: DatabaseSync) {
  const roleCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM roles").get()?.count ?? 0
  );
  const userCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM users").get()?.count ?? 0
  );
  const bootstrapAdminAccount = getBootstrapAdminAccount();
  const bootstrapAdminPassword = getBootstrapAdminPassword();

  if (roleCount === 0) {
    const roles: RoleRow[] = [
      { id: "role-user", roleKey: "user", roleName: "普通用户" },
      { id: "role-minutes-admin", roleKey: "minutes_admin", roleName: "纪要管理员" },
      { id: "role-system-admin", roleKey: "system_admin", roleName: "系统管理员" },
    ];

    for (const role of roles) {
      database
        .prepare(`
          INSERT INTO roles (id, role_key, role_name, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(role_key) DO UPDATE SET role_name = excluded.role_name
        `)
        .run(role.id, role.roleKey, role.roleName, nowIso());
    }
  }

  const existingBootstrapAdmin = database
    .prepare("SELECT id FROM users WHERE account_name = ?")
    .get(bootstrapAdminAccount) as { id: string } | undefined;
  const systemAdminCount = Number(
    database
      .prepare(`
        SELECT COUNT(*) as count
        FROM users u
        INNER JOIN user_roles ur ON ur.user_id = u.id
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE r.role_key = 'system_admin' AND u.status = 'active'
      `)
      .get()?.count ?? 0
  );
  const shouldCreateBootstrapAdmin =
    bootstrapAdminAccount && !existingBootstrapAdmin && (userCount === 0 || systemAdminCount === 0);

  if (shouldCreateBootstrapAdmin) {
    database
      .prepare(`
        INSERT INTO users (
          id, account_name, display_name, email, department, external_user_id,
          password_hash, must_change_password, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "user-admin",
        bootstrapAdminAccount,
        "管理员",
        "",
        "系统",
        null,
        hashPassword(bootstrapAdminPassword.password),
        bootstrapAdminPassword.mustChangePassword ? 1 : 0,
        "active",
        nowIso(),
        nowIso()
      );
  }

  const adminUser = database
    .prepare("SELECT id, password_hash as passwordHash FROM users WHERE account_name = ?")
    .get(bootstrapAdminAccount) as { id: string; passwordHash?: string | null } | undefined;
  const adminRole = database
    .prepare("SELECT id FROM roles WHERE role_key = ?")
    .get("system_admin") as { id: string } | undefined;

  if (adminUser && adminRole) {
    if (!adminUser.passwordHash) {
      database
        .prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?")
        .run(
          hashPassword(bootstrapAdminPassword.password),
          bootstrapAdminPassword.mustChangePassword ? 1 : 0,
          nowIso(),
          adminUser.id
        );
    }

    database
      .prepare(`
        INSERT OR IGNORE INTO user_roles (id, user_id, role_id, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run("user-role-admin-system", adminUser.id, adminRole.id, nowIso());
  }
}

export function getCurrentActor() {
  const scopedActor = actorContext.getStore();
  if (scopedActor) return scopedActor;

  throw new Error("Actor context is required for audited data access");
}

export function runWithActor<T>(actor: ActorContext, callback: () => T): T {
  return actorContext.run(actor, callback);
}

export function getActorByAccountName(accountName: string) {
  const normalizedAccount = String(accountName ?? "").trim();
  if (!normalizedAccount) return null;

  return getDb()
    .prepare(`
      SELECT
        id,
        account_name as accountName,
        display_name as displayName,
        status,
        must_change_password as mustChangePassword
      FROM users
      WHERE account_name = ?
    `)
    .get(normalizedAccount) as ActorContext | null;
}

export function authenticateUser(accountName: string, password: string) {
  const normalizedAccount = String(accountName ?? "").trim();
  if (!normalizedAccount || !password) return null;

  const user = getDb()
    .prepare(`
      SELECT
        id,
        account_name as accountName,
        display_name as displayName,
        status,
        password_hash as passwordHash,
        must_change_password as mustChangePassword
      FROM users
      WHERE account_name = ?
    `)
    .get(normalizedAccount) as (ActorContext & { passwordHash?: string | null }) | null;

  if (!user || user.status !== "active") return null;
  const verification = verifyPassword(password, user.passwordHash);
  if (!verification.ok) return null;

  if (verification.needsRehash) {
    getDb()
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(hashPassword(password), nowIso(), user.id);
  }

  getDb()
    .prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), user.id);

  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

export function createAuthSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = sessionExpiryIso();
  getDb()
    .prepare(`
      INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(newId("session"), userId, hashSessionToken(token), expiresAt, nowIso(), nowIso());

  return { token, expiresAt };
}

export function getActorBySessionToken(token: string) {
  const sessionToken = String(token ?? "").trim();
  if (!sessionToken) return null;

  const row = getDb()
    .prepare(`
      SELECT
        u.id,
        u.account_name as accountName,
        u.display_name as displayName,
        u.status,
        u.must_change_password as mustChangePassword
      FROM auth_sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `)
    .get(hashSessionToken(sessionToken), nowIso()) as ActorContext | null;

  if (!row || row.status !== "active") return null;

  getDb()
    .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?")
    .run(nowIso(), hashSessionToken(sessionToken));

  return { ...row, mustChangePassword: Boolean(row.mustChangePassword) };
}

export function deleteAuthSession(token: string) {
  const sessionToken = String(token ?? "").trim();
  if (!sessionToken) return;
  getDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashSessionToken(sessionToken));
}

export function changeUserPassword(accountName: string, currentPassword: string, nextPassword: string) {
  const normalizedAccount = requireNonEmpty(accountName, "Account name");
  const next = String(nextPassword ?? "");
  if (next.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const user = getDb()
    .prepare(`
      SELECT id, password_hash as passwordHash
      FROM users
      WHERE account_name = ? AND status = 'active'
    `)
    .get(normalizedAccount) as { id: string; passwordHash?: string | null } | undefined;

  if (!user || !verifyPassword(currentPassword, user.passwordHash).ok) {
    throw new Error("Current password is incorrect");
  }

  getDb()
    .prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?")
    .run(hashPassword(next), nowIso(), user.id);
  getDb().prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);

  return true;
}

export function getCurrentActorRoleKeys() {
  const actor = getCurrentActor();
  return getActorRoleKeys(actor.id, actor.status);
}

export function getActorRoleKeys(userId: string, status = "active") {
  if (status !== "active") return [];

  return getDb()
    .prepare(`
      SELECT r.role_key as roleKey
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_key ASC
    `)
    .all(userId)
    .map((row: any) => String(row.roleKey));
}

export function currentActorHasAnyRole(roleKeys: string[]) {
  const currentRoleKeys = new Set(getCurrentActorRoleKeys());
  return roleKeys.some((roleKey) => currentRoleKeys.has(roleKey));
}

function writeAuditLog(input: {
  actionType: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string | null;
  result?: string;
  errorMessage?: string | null;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
}) {
  const actor = getCurrentActor();
  getDb()
    .prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, actor_account_name, actor_display_name,
        action_type, resource_type, resource_id, resource_name, request_id,
        result, error_message, before_snapshot, after_snapshot, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      newId("audit"),
      actor.id,
      actor.accountName,
      actor.displayName,
      input.actionType,
      input.resourceType,
      input.resourceId,
      input.resourceName ?? null,
      null,
      input.result ?? "success",
      input.errorMessage ?? null,
      input.beforeSnapshot === undefined ? null : JSON.stringify(input.beforeSnapshot),
      input.afterSnapshot === undefined ? null : JSON.stringify(input.afterSnapshot),
      nowIso()
    );
}

export function createMeeting(input: MeetingInput) {
  const database = getDb();
  const createdAt = nowIso();
  const meetingId = newId("meeting");
  const asrResultId = newId("asr");
  const settings = listSettings() as any[];
  const activeHotwords = listActiveHotwordMap();
  const actor = getCurrentActor();

  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const title = requireNonEmpty(input.title, "title");
  const sourceType = requireNonEmpty(input.sourceType, "sourceType");
  const transcriptSegments = Array.isArray(input.transcriptSegments) ? input.transcriptSegments : [];
  const normalizedText = transcriptSegments.map((segment) => String(segment.text ?? "")).join("");
  if (!normalizedText.trim()) {
    throw new Error("transcriptSegments must include text");
  }

  const captureSession = getAsrCaptureSession(input.captureSessionId);
  const rawEvents = parseJsonOr(captureSession?.rawEventsJson, null as unknown[] | null);
  const rawAsrConfigSnapshot = captureSession?.asrConfigSnapshot
    ? parseJsonOr(captureSession.asrConfigSnapshot, {})
    : {
        providerType: get("asr", "provider"),
        endpoint: get("asr", "endpoint"),
        workspaceId: get("asr", "workspace_id"),
        hasApiKey: Boolean(get("asr", "api_key")),
        hotwords: activeHotwords,
      };
  const asrConfigSnapshot = redactAsrConfigSnapshot(rawAsrConfigSnapshot);
  const rawPayload = captureSession
    ? {
        captureSessionId: input.captureSessionId,
        taskId: captureSession.taskId,
        status: captureSession.status,
        events: rawEvents ?? [],
        transcriptSegments,
      }
    : { segments: transcriptSegments };

  database
    .prepare(`
      INSERT INTO meetings (
        id, title, source_type, source_file_name, duration_seconds, status, status_updated_at,
        last_error_message, created_by_user_id, created_by_user_name, created_by_user_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      meetingId,
      title,
      sourceType,
      input.sourceFileName,
      input.durationSeconds,
      "transcribed",
      createdAt,
      null,
      actor.id,
      actor.displayName,
      null,
      createdAt,
      createdAt
    );

  database
    .prepare(`
      INSERT INTO meeting_asr_results (
        id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot,
        capture_session_id, result_format, raw_payload, normalized_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      asrResultId,
      meetingId,
      captureSession?.asrProvider || get("asr", "provider") || "local_funasr",
      "current",
      JSON.stringify(asrConfigSnapshot),
      input.captureSessionId,
      captureSession ? "gateway_raw_events_json" : "transcript_segments_json",
      JSON.stringify(rawPayload),
      normalizedText,
      createdAt
    );

  const meeting = getMeetingById(meetingId);
  writeAuditLog({
    actionType: "meeting.create",
    resourceType: "meeting",
    resourceId: meetingId,
    resourceName: title,
    afterSnapshot: meeting,
  });
  return meeting;
}

export function updateMeetingStatus(id: string, status: string, lastErrorMessage?: string | null) {
  const updatedAt = nowIso();
  getDb()
    .prepare(`
      UPDATE meetings
      SET status = ?, status_updated_at = ?, last_error_message = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(status, updatedAt, lastErrorMessage ?? null, updatedAt, id);

  return getMeetingById(id);
}

export function updateMeeting(id: string, patch: { title?: string }) {
  const existing = getMeetingById(id);
  if (!existing) return null;

  const updatedAt = nowIso();
  const nextTitle = patch.title === undefined ? existing.title : requireNonEmpty(patch.title, "title");
  getDb()
    .prepare(`
      UPDATE meetings
      SET title = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(nextTitle, updatedAt, id);

  const updated = getMeetingById(id);
  writeAuditLog({
    actionType: "meeting.update",
    resourceType: "meeting",
    resourceId: id,
    resourceName: updated?.title ?? existing.title,
    beforeSnapshot: existing,
    afterSnapshot: updated,
  });
  return updated;
}

export function deleteMeeting(id: string) {
  const database = getDb();
  const before = getMeetingById(id);
  const asrRows = database
    .prepare("SELECT id FROM meeting_asr_results WHERE meeting_id = ?")
    .all(id) as Array<{ id: string }>;
  const asrIds = asrRows.map((row) => row.id);

  for (const asrId of asrIds) {
    const llmRows = database
      .prepare("SELECT id FROM meeting_llm_results WHERE meeting_asr_result_id = ?")
      .all(asrId) as Array<{ id: string }>;

    for (const llmRow of llmRows) {
      database.prepare("DELETE FROM meeting_send_records WHERE meeting_llm_result_id = ?").run(llmRow.id);
    }

    database.prepare("DELETE FROM meeting_llm_results WHERE meeting_asr_result_id = ?").run(asrId);
  }

  database.prepare("DELETE FROM meeting_asr_results WHERE meeting_id = ?").run(id);
  const result = database.prepare("DELETE FROM meetings WHERE id = ?").run(id);
  const deleted = Number(result.changes ?? 0) > 0;
  if (deleted) {
    writeAuditLog({
      actionType: "meeting.delete",
      resourceType: "meeting",
      resourceId: id,
      resourceName: before?.title ?? id,
      beforeSnapshot: before,
    });
  }
  return deleted;
}

function mapMeetingRow(row: any) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    lastErrorMessage: row.lastErrorMessage ?? null,
    date: new Date(row.createdAt).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    durationLabel: row.durationSeconds ? `${Math.floor(row.durationSeconds / 60)} 分钟` : row.sourceType === "file_upload" ? "上传音频" : "未记录",
    summary: row.summary ?? "",
    transcript: row.transcript,
  };
}

export function listMeetings() {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.status,
        m.last_error_message as lastErrorMessage,
        m.source_type as sourceType,
        m.duration_seconds as durationSeconds,
        m.created_at as createdAt,
        r.raw_payload as rawPayload,
        (
          SELECT result_markdown
          FROM meeting_llm_results lr
          WHERE lr.meeting_asr_result_id = r.id AND lr.status = 'succeeded'
          ORDER BY lr.version_no DESC, lr.created_at DESC
          LIMIT 1
        ) as summary
      FROM meetings m
      LEFT JOIN meeting_asr_results r ON r.meeting_id = m.id
      ORDER BY m.created_at DESC
    `)
    .all() as any[];

  return rows.map((row) => {
    const payload = parseJsonOr(row.rawPayload, { segments: [] } as any);
    return mapMeetingRow({ ...row, transcript: payload.segments ?? payload.transcriptSegments ?? [] });
  });
}

export function getMeetingById(id: string) {
  const database = getDb();
  const row = database
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.status,
        m.last_error_message as lastErrorMessage,
        m.source_type as sourceType,
        m.duration_seconds as durationSeconds,
        m.created_at as createdAt,
        r.raw_payload as rawPayload,
        (
          SELECT result_markdown
          FROM meeting_llm_results lr
          WHERE lr.meeting_asr_result_id = r.id AND lr.status = 'succeeded'
          ORDER BY lr.version_no DESC, lr.created_at DESC
          LIMIT 1
        ) as summary
      FROM meetings m
      LEFT JOIN meeting_asr_results r ON r.meeting_id = m.id
      WHERE m.id = ?
    `)
    .get(id) as any;

  if (!row) return null;
  const payload = parseJsonOr(row.rawPayload, { segments: [] } as any);
  return mapMeetingRow({ ...row, transcript: payload.segments ?? payload.transcriptSegments ?? [] });
}

function listMeetingLlmResultsByAsrResultId(meetingAsrResultId: string) {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        id,
        meeting_asr_result_id as meetingAsrResultId,
        llm_setting_mark as llmSettingMark,
        prompt_template_id as promptTemplateId,
        generation_config_snapshot as generationConfigSnapshot,
        generation_mode as generationMode,
        status,
        version_no as versionNo,
        result_type as resultType,
        result_title as resultTitle,
        raw_prompt as rawPrompt,
        raw_response as rawResponse,
        result_markdown as resultMarkdown,
        error_message as errorMessage,
        created_at as createdAt
      FROM meeting_llm_results
      WHERE meeting_asr_result_id = ?
      ORDER BY version_no DESC, created_at DESC
    `)
    .all(meetingAsrResultId);
}

function getMeetingAsrResultByMeetingId(meetingId: string) {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        id,
        meeting_id as meetingId,
        asr_provider as asrProvider,
        asr_setting_mark as asrSettingMark,
        asr_config_snapshot as asrConfigSnapshot,
        capture_session_id as captureSessionId,
        result_format as resultFormat,
        raw_payload as rawPayload,
        normalized_text as normalizedText,
        created_at as createdAt
      FROM meeting_asr_results
      WHERE meeting_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(meetingId) as any;
}

export function listMeetingAsrResults(meetingId: string) {
  return getDb()
    .prepare(`
      SELECT
        id,
        meeting_id as meetingId,
        asr_provider as asrProvider,
        asr_setting_mark as asrSettingMark,
        capture_session_id as captureSessionId,
        result_format as resultFormat,
        length(raw_payload) as rawPayloadBytes,
        length(normalized_text) as normalizedTextLength,
        created_at as createdAt
      FROM meeting_asr_results
      WHERE meeting_id = ?
      ORDER BY created_at DESC
    `)
    .all(meetingId);
}

export function getMeetingAsrResultDetail(meetingId: string, resultId: string) {
  const row = getDb()
    .prepare(`
      SELECT
        id,
        meeting_id as meetingId,
        asr_provider as asrProvider,
        asr_setting_mark as asrSettingMark,
        asr_config_snapshot as asrConfigSnapshot,
        capture_session_id as captureSessionId,
        result_format as resultFormat,
        raw_payload as rawPayload,
        normalized_text as normalizedText,
        created_at as createdAt
      FROM meeting_asr_results
      WHERE meeting_id = ? AND id = ?
    `)
    .get(meetingId, resultId) as any;

  if (!row) return null;

  return {
    ...row,
    asrConfigSnapshot: redactAsrConfigSnapshot(parseJsonOr(row.asrConfigSnapshot, {})),
    rawPayload: parseJsonOr(row.rawPayload, row.rawPayload),
  };
}

export function listMeetingLlmResults(meetingId: string) {
  const asrResult = getMeetingAsrResultByMeetingId(meetingId);
  if (!asrResult) return [];
  return listMeetingLlmResultsByAsrResultId(asrResult.id);
}

export async function createMeetingLlmResult(meetingId: string, templateId?: string) {
  updateMeetingStatus(meetingId, "llm_processing");
  const asrResult = getMeetingAsrResultByMeetingId(meetingId);
  if (!asrResult) {
    updateMeetingStatus(meetingId, "llm_failed", "Meeting ASR result not found");
    throw new Error("Meeting ASR result not found");
  }

  const settings = listSettings() as any[];
  const templates = listPromptTemplates() as any[];
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const selectedTemplateId = templateId || get("system", "default_prompt_template_id");
  const template = templates.find((item) => item.id === selectedTemplateId);
  if (!template) {
    updateMeetingStatus(meetingId, "llm_failed", "Prompt template not found");
    throw new Error("Prompt template not found");
  }

  const baseUrl = get("llm", "base_url");
  const apiKey = get("llm", "api_key");
  const model = get("llm", "model");

  if (!baseUrl || !model) {
    updateMeetingStatus(meetingId, "llm_failed", "LLM config incomplete");
    throw new Error("LLM config incomplete");
  }

  const existing = listMeetingLlmResultsByAsrResultId(asrResult.id) as any[];
  const versionNo = existing.length > 0 ? Number(existing[0].versionNo) + 1 : 1;
  const prompt = String(template.content || "").replaceAll("{transcript}", asrResult.normalizedText || "");
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;

  let data: any = null;
  let resultMarkdown = "";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是一个专业的会议纪要整理助手。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API error: ${response.status} ${errorText}`);
    }

    data = await response.json();
    resultMarkdown = data.choices?.[0]?.message?.content || "";
    if (!String(resultMarkdown).trim()) {
      throw new Error("LLM returned empty result");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "LLM generation failed";
    insertMeetingLlmResult({
      id: newId("llm"),
      meetingAsrResultId: asrResult.id,
      llmSettingMark: "current",
      promptTemplateId: template.id,
      generationConfigSnapshot: JSON.stringify({ baseUrl, model }),
      generationMode: existing.length > 0 ? "manual_regenerate" : "default_auto",
      status: "failed",
      versionNo,
      resultType: template.templateType || "custom",
      resultTitle: template.templateName,
      rawPrompt: prompt,
      rawResponse: "",
      resultMarkdown: "",
      errorMessage,
    });
    updateMeetingStatus(meetingId, "llm_failed", errorMessage);
    writeAuditLog({
      actionType: existing.length > 0 ? "llm.regenerate" : "llm.generate_default",
      resourceType: "meeting",
      resourceId: meetingId,
      resourceName: template.templateName,
      result: "failed",
      errorMessage,
      afterSnapshot: {
        promptTemplateId: template.id,
        versionNo,
        status: "failed",
      },
    });
    throw error;
  }
  const row: MeetingLlmResultRow = {
    id: newId("llm"),
    meetingAsrResultId: asrResult.id,
    llmSettingMark: "current",
    promptTemplateId: template.id,
    generationConfigSnapshot: JSON.stringify({ baseUrl, model }),
    generationMode: existing.length > 0 ? "manual_regenerate" : "default_auto",
    status: "succeeded",
    versionNo,
    resultType: template.templateType || "custom",
    resultTitle: template.templateName,
    rawPrompt: prompt,
    rawResponse: JSON.stringify(data),
    resultMarkdown,
    errorMessage: null,
  };

  insertMeetingLlmResult(row);
  updateMeetingStatus(meetingId, "pending_review");
  writeAuditLog({
    actionType: row.generationMode === "default_auto" ? "llm.generate_default" : "llm.regenerate",
    resourceType: "meeting_llm_result",
    resourceId: row.id,
    resourceName: row.resultTitle,
    afterSnapshot: {
      meetingId,
      promptTemplateId: row.promptTemplateId,
      versionNo: row.versionNo,
      status: row.status,
    },
  });

  return listMeetingLlmResultsByAsrResultId(asrResult.id)[0];
}

function insertMeetingLlmResult(row: MeetingLlmResultRow) {
  getDb()
    .prepare(`
      INSERT INTO meeting_llm_results (
        id, meeting_asr_result_id, llm_setting_mark, prompt_template_id,
        generation_config_snapshot, generation_mode, status, version_no,
        result_type, result_title, raw_prompt, raw_response, result_markdown,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.id,
      row.meetingAsrResultId,
      row.llmSettingMark,
      row.promptTemplateId,
      row.generationConfigSnapshot,
      row.generationMode,
      row.status,
      row.versionNo,
      row.resultType,
      row.resultTitle,
      row.rawPrompt,
      row.rawResponse,
      row.resultMarkdown,
      row.errorMessage,
      nowIso()
    );
}

export function updateMeetingLlmResult(meetingId: string, id: string, patch: { resultMarkdown?: string; resultTitle?: string }) {
  const existing = getMeetingLlmResultById(id);
  if (!existing) return null;
  if (!meetingLlmResultBelongsToMeeting(id, meetingId)) {
    throw new Error("Meeting LLM result does not belong to this meeting");
  }

  const database = getDb();
  database
    .prepare(`
      UPDATE meeting_llm_results
      SET result_markdown = ?, result_title = ?
      WHERE id = ?
    `)
    .run(
      patch.resultMarkdown ?? existing.resultMarkdown,
      patch.resultTitle ?? existing.resultTitle,
      id
    );

  const updated = getMeetingLlmResultById(id);
  writeAuditLog({
    actionType: "llm_result.update",
    resourceType: "meeting_llm_result",
    resourceId: id,
    resourceName: updated?.resultTitle ?? existing.resultTitle,
    beforeSnapshot: {
      resultTitle: existing.resultTitle,
      resultMarkdown: existing.resultMarkdown,
    },
    afterSnapshot: {
      meetingId,
      resultTitle: updated?.resultTitle,
      resultMarkdown: updated?.resultMarkdown,
    },
  });

  return updated;
}

function getMeetingLlmResultById(id: string) {
  const database = getDb();
  return database
    .prepare(`
      SELECT
        id,
        meeting_asr_result_id as meetingAsrResultId,
        llm_setting_mark as llmSettingMark,
        prompt_template_id as promptTemplateId,
        generation_config_snapshot as generationConfigSnapshot,
        generation_mode as generationMode,
        status,
        version_no as versionNo,
        result_type as resultType,
        result_title as resultTitle,
        raw_prompt as rawPrompt,
        raw_response as rawResponse,
        result_markdown as resultMarkdown,
        error_message as errorMessage,
        created_at as createdAt
      FROM meeting_llm_results
      WHERE id = ?
    `)
    .get(id) as any;
}

function meetingLlmResultBelongsToMeeting(llmResultId: string, meetingId: string) {
  const row = getDb()
    .prepare(`
      SELECT lr.id
      FROM meeting_llm_results lr
      INNER JOIN meeting_asr_results ar ON ar.id = lr.meeting_asr_result_id
      WHERE lr.id = ? AND ar.meeting_id = ?
    `)
    .get(llmResultId, meetingId);

  return Boolean(row);
}

export function listMeetingSendRecords(meetingId: string) {
  const asrResult = getMeetingAsrResultByMeetingId(meetingId);
  if (!asrResult) return [];

  const database = getDb();
  return database
    .prepare(`
      SELECT
        sr.id,
        sr.meeting_llm_result_id as meetingLlmResultId,
        sr.mail_template_type as mailTemplateType,
        sr.subject,
        sr.to_recipients_json as toRecipientsJson,
        sr.cc_recipients_json as ccRecipientsJson,
        sr.body_markdown as bodyMarkdown,
        sr.body_html as bodyHtml,
        sr.status,
        sr.provider_type as providerType,
        sr.provider_message_id as providerMessageId,
        sr.error_message as errorMessage,
        sr.sent_by_user_id as sentByUserId,
        sr.created_at as createdAt,
        sr.sent_at as sentAt
      FROM meeting_send_records sr
      INNER JOIN meeting_llm_results lr ON lr.id = sr.meeting_llm_result_id
      WHERE lr.meeting_asr_result_id = ?
      ORDER BY sr.created_at DESC
    `)
    .all(asrResult.id)
    .map((row: any) => ({
      ...row,
      toRecipients: JSON.parse(row.toRecipientsJson || "[]"),
      ccRecipients: JSON.parse(row.ccRecipientsJson || "[]"),
    }));
}

export async function createMeetingSendRecord(input: {
  meetingId: string;
  meetingLlmResultId: string;
  subject: string;
  toRecipients: string[];
  ccRecipients: string[];
  mailTemplateType?: string;
}) {
  const llmResult = getMeetingLlmResultById(input.meetingLlmResultId);
  if (!llmResult) {
    throw new Error("Meeting LLM result not found");
  }
  if (!meetingLlmResultBelongsToMeeting(input.meetingLlmResultId, input.meetingId)) {
    throw new Error("Meeting LLM result does not belong to this meeting");
  }

  const subject = requireNonEmpty(input.subject, "subject");
  const toRecipients = Array.isArray(input.toRecipients)
    ? input.toRecipients.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const ccRecipients = Array.isArray(input.ccRecipients)
    ? input.ccRecipients.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (toRecipients.length === 0) {
    throw new Error("At least one recipient is required");
  }

  const settings = listSettings() as any[];
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const host = get("mail", "smtp_host");
  const port = Number(get("mail", "smtp_port") || "465");
  const user = get("mail", "smtp_username");
  const pass = get("mail", "smtp_password");
  const fromName = get("mail", "from_name");
  const fromEmail = get("mail", "from_email");

  const bodyMarkdown = llmResult.resultMarkdown || "";
  const bodyHtml = `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.6">${escapeHtml(bodyMarkdown)}</pre>`;

  let sent: { messageId?: string } = {};
  try {
    if (!host || !user || !fromEmail) {
      throw new Error("Mail config incomplete");
    }

    updateMeetingStatus(input.meetingId, "sending");
    const nodemailer = (eval("require") as NodeRequire)("nodemailer") as {
      createTransport: (options: Record<string, unknown>) => {
        sendMail: (message: Record<string, unknown>) => Promise<{ messageId?: string }>;
      };
    };
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });

    sent = await transporter.sendMail({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: toRecipients.join(", "),
      cc: ccRecipients.length > 0 ? ccRecipients.join(", ") : undefined,
      subject,
      text: bodyMarkdown,
      html: bodyHtml,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Mail send failed";
    const failedSendRecordId = newId("send");
    insertMeetingSendRecord({
      id: failedSendRecordId,
      meetingLlmResultId: input.meetingLlmResultId,
      mailTemplateType: input.mailTemplateType ?? "formal_minutes_mail",
      subject,
      toRecipientsJson: JSON.stringify(toRecipients),
      ccRecipientsJson: JSON.stringify(ccRecipients),
      bodyMarkdown,
      bodyHtml,
      status: "failed",
      mailSettingMark: "current",
      mailConfigSnapshot: JSON.stringify({ host, port, user, fromName, fromEmail }),
      providerType: "smtp",
      providerMessageId: null,
      errorMessage,
      sentByUserId: getCurrentActor().id,
    }, null);
    updateMeetingStatus(input.meetingId, "send_failed", errorMessage);
    writeAuditLog({
      actionType: "mail.send",
      resourceType: "meeting_send_record",
      resourceId: failedSendRecordId,
      resourceName: subject,
      result: "failed",
      errorMessage,
      afterSnapshot: {
        meetingId: input.meetingId,
        meetingLlmResultId: input.meetingLlmResultId,
        toRecipients,
        ccRecipients,
        status: "failed",
      },
    });
    throw error;
  }

  const row: MeetingSendRecordRow = {
    id: newId("send"),
    meetingLlmResultId: input.meetingLlmResultId,
    mailTemplateType: input.mailTemplateType ?? "formal_minutes_mail",
    subject,
    toRecipientsJson: JSON.stringify(toRecipients),
    ccRecipientsJson: JSON.stringify(ccRecipients),
    bodyMarkdown,
    bodyHtml,
    status: "sent",
    mailSettingMark: "current",
    mailConfigSnapshot: JSON.stringify({ host, port, user, fromName, fromEmail }),
    providerType: "smtp",
    providerMessageId: sent.messageId ?? null,
    errorMessage: null,
    sentByUserId: getCurrentActor().id,
  };

  insertMeetingSendRecord(row, nowIso());
  updateMeetingStatus(input.meetingId, "sent");
  writeAuditLog({
    actionType: "mail.send",
    resourceType: "meeting_send_record",
    resourceId: row.id,
    resourceName: row.subject,
    afterSnapshot: {
      meetingId: input.meetingId,
      meetingLlmResultId: row.meetingLlmResultId,
      toRecipients,
      ccRecipients,
      status: row.status,
    },
  });

  return listMeetingSendRecords(input.meetingId)[0];
}

function insertMeetingSendRecord(row: MeetingSendRecordRow, sentAt: string | null) {
  getDb()
    .prepare(`
      INSERT INTO meeting_send_records (
        id, meeting_llm_result_id, mail_template_type, subject,
        to_recipients_json, cc_recipients_json, body_markdown, body_html,
        status, mail_setting_mark, mail_config_snapshot, provider_type,
        provider_message_id, error_message, sent_by_user_id, created_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.id,
      row.meetingLlmResultId,
      row.mailTemplateType,
      row.subject,
      row.toRecipientsJson,
      row.ccRecipientsJson,
      row.bodyMarkdown,
      row.bodyHtml,
      row.status,
      row.mailSettingMark,
      row.mailConfigSnapshot,
      row.providerType,
      row.providerMessageId,
      row.errorMessage,
      row.sentByUserId,
      nowIso(),
      sentAt
    );
}
