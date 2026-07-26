import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

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

const dataDir = join(process.cwd(), "data");
const dbPath = join(dataDir, "meeting-asr-app.db");

let db: DatabaseSync | null = null;

function nowIso() {
  return new Date().toISOString();
}

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
  `);

  seedDefaults(db);
  return db;
}

function seedDefaults(database: DatabaseSync) {
  const settingsCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM app_settings").get()?.count ?? 0
  );
  const templateCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM llm_prompt_templates").get()?.count ?? 0
  );
  const hotwordCount = Number(
    database.prepare("SELECT COUNT(*) as count FROM asr_hotwords").get()?.count ?? 0
  );

  if (settingsCount === 0) {
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
    ];

    for (const setting of defaults) {
      upsertSetting(setting);
    }
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

    upsertSetting({
      itemSection: "system",
      itemMark: "default_prompt_template_id",
      itemTitle: "默认纪要模板",
      itemDescription: "自动生成首版结果时使用",
      itemValue: "tpl-1",
    });
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
    id: `tpl-${Date.now()}`,
    isSystem: input.isSystem ?? false,
    ...input,
  };
  upsertPromptTemplate(template);
  return listPromptTemplates().find((item: any) => item.id === template.id);
}

export function updatePromptTemplate(id: string, patch: Partial<Omit<PromptTemplateRow, "id">>) {
  const existing = listPromptTemplates().find((item: any) => item.id === id);
  if (!existing) return null;

  const next: PromptTemplateRow = {
    id,
    templateKey: patch.templateKey ?? existing.templateKey,
    templateName: patch.templateName ?? existing.templateName,
    templateType: patch.templateType ?? existing.templateType,
    content: patch.content ?? existing.content,
    description: patch.description ?? existing.description,
    status: patch.status ?? existing.status,
    isSystem: patch.isSystem ?? existing.isSystem,
  };

  upsertPromptTemplate(next);
  return listPromptTemplates().find((item: any) => item.id === id);
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
    id: `hw-${Date.now()}`,
    ...input,
  };
  upsertHotword(hotword);
  return listHotwords().find((item: any) => item.id === hotword.id);
}

export function updateHotword(id: string, patch: Partial<Omit<HotwordRow, "id">>) {
  const existing = listHotwords().find((item: any) => item.id === id);
  if (!existing) return null;

  const next: HotwordRow = {
    id,
    term: patch.term ?? existing.term,
    weight: patch.weight ?? existing.weight,
    status: patch.status ?? existing.status,
    note: patch.note ?? existing.note,
  };

  upsertHotword(next);
  return listHotwords().find((item: any) => item.id === id);
}

export function deleteHotword(id: string) {
  getDb().prepare("DELETE FROM asr_hotwords WHERE id = ?").run(id);
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
    workspaceId,
    apiKey: asrApiKey,
    hasCustomFunasr: providerType === "local_funasr" && Boolean(endpoint),
    asr: {
      providerType,
      endpoint,
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

export function createMeeting(input: MeetingInput) {
  const database = getDb();
  const createdAt = nowIso();
  const meetingId = `meeting-${Date.now()}`;
  const asrResultId = `asr-${Date.now()}`;
  const settings = listSettings() as any[];
  const activeHotwords = listActiveHotwordMap();

  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const normalizedText = input.transcriptSegments.map((segment) => segment.text).join("");

  database
    .prepare(`
      INSERT INTO meetings (
        id, title, source_type, source_file_name, duration_seconds, status, status_updated_at,
        last_error_message, created_by_user_id, created_by_user_name, created_by_user_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      meetingId,
      input.title,
      input.sourceType,
      input.sourceFileName,
      input.durationSeconds,
      "transcribed",
      createdAt,
      null,
      "admin",
      "管理员",
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
      get("asr", "provider") || "local_funasr",
      "current",
      JSON.stringify({
        provider: get("asr", "provider"),
        endpoint: get("asr", "endpoint"),
        workspaceId: get("asr", "workspace_id"),
        hasApiKey: Boolean(get("asr", "api_key")),
        hotwords: activeHotwords,
      }),
      input.captureSessionId,
      "transcript_segments_json",
      JSON.stringify({ segments: input.transcriptSegments }),
      normalizedText,
      createdAt
    );

  return getMeetingById(meetingId);
}

function mapMeetingRow(row: any) {
  return {
    id: row.id,
    title: row.title,
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
    const payload = row.rawPayload ? JSON.parse(row.rawPayload) : { segments: [] };
    return mapMeetingRow({ ...row, transcript: payload.segments ?? [] });
  });
}

export function getMeetingById(id: string) {
  const database = getDb();
  const row = database
    .prepare(`
      SELECT
        m.id,
        m.title,
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
  const payload = row.rawPayload ? JSON.parse(row.rawPayload) : { segments: [] };
  return mapMeetingRow({ ...row, transcript: payload.segments ?? [] });
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

export function listMeetingLlmResults(meetingId: string) {
  const asrResult = getMeetingAsrResultByMeetingId(meetingId);
  if (!asrResult) return [];
  return listMeetingLlmResultsByAsrResultId(asrResult.id);
}

export async function createMeetingLlmResult(meetingId: string, templateId?: string) {
  const asrResult = getMeetingAsrResultByMeetingId(meetingId);
  if (!asrResult) {
    throw new Error("Meeting ASR result not found");
  }

  const settings = listSettings() as any[];
  const templates = listPromptTemplates() as any[];
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const selectedTemplateId = templateId || get("system", "default_prompt_template_id");
  const template = templates.find((item) => item.id === selectedTemplateId);
  if (!template) {
    throw new Error("Prompt template not found");
  }

  const baseUrl = get("llm", "base_url");
  const apiKey = get("llm", "api_key");
  const model = get("llm", "model");

  if (!baseUrl || !model) {
    throw new Error("LLM config incomplete");
  }

  const existing = listMeetingLlmResultsByAsrResultId(asrResult.id) as any[];
  const versionNo = existing.length > 0 ? Number(existing[0].versionNo) + 1 : 1;
  const prompt = String(template.content || "").replaceAll("{transcript}", asrResult.normalizedText || "");
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;

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

  const data = await response.json();
  const resultMarkdown = data.choices?.[0]?.message?.content || "";
  const row: MeetingLlmResultRow = {
    id: `llm-${Date.now()}`,
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

  const database = getDb();
  database
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

  return listMeetingLlmResultsByAsrResultId(asrResult.id)[0];
}

export function updateMeetingLlmResult(id: string, patch: { resultMarkdown?: string; resultTitle?: string }) {
  const existing = getMeetingLlmResultById(id);
  if (!existing) return null;

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

  return getMeetingLlmResultById(id);
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

  const settings = listSettings() as any[];
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const host = get("mail", "smtp_host");
  const port = Number(get("mail", "smtp_port") || "465");
  const user = get("mail", "smtp_username");
  const pass = get("mail", "smtp_password");
  const fromName = get("mail", "from_name");
  const fromEmail = get("mail", "from_email");

  if (!host || !user || !fromEmail) {
    throw new Error("Mail config incomplete");
  }

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

  const bodyMarkdown = llmResult.resultMarkdown || "";
  const bodyHtml = `<pre style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.6">${escapeHtml(bodyMarkdown)}</pre>`;

  const sent = await transporter.sendMail({
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to: input.toRecipients.join(", "),
    cc: input.ccRecipients.length > 0 ? input.ccRecipients.join(", ") : undefined,
    subject: input.subject,
    text: bodyMarkdown,
    html: bodyHtml,
  });

  const row: MeetingSendRecordRow = {
    id: `send-${Date.now()}`,
    meetingLlmResultId: input.meetingLlmResultId,
    mailTemplateType: input.mailTemplateType ?? "formal_minutes_mail",
    subject: input.subject,
    toRecipientsJson: JSON.stringify(input.toRecipients),
    ccRecipientsJson: JSON.stringify(input.ccRecipients),
    bodyMarkdown,
    bodyHtml,
    status: "sent",
    mailSettingMark: "current",
    mailConfigSnapshot: JSON.stringify({ host, port, user, fromName, fromEmail }),
    providerType: "smtp",
    providerMessageId: sent.messageId ?? null,
    errorMessage: null,
    sentByUserId: "admin",
  };

  const database = getDb();
  database
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
      nowIso()
    );

  return listMeetingSendRecords(input.meetingId)[0];
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
