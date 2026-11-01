import { existsSync, statSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "crypto";
import { getDb as getSharedDb, cleanupExpiredAuditLogs as cleanupSharedAuditLogs } from "../../server/db-shared.mjs";
import { resolveStoredPath } from "../../server/audio-paths.mjs";
import {
  bindAudioRecordingsToMeeting,
  collectCaptureSessionIds,
  deleteAudioRecordingRowsForMeeting,
  drainCaptureEvents,
  getCaptureSessionStats,
  invalidateAsrRuntimeConfig,
  invalidateAudioRuntimeConfig,
  listAudioRecordingsForMeeting,
  releaseCaptureSession,
  removeAudioFilesForRows,
} from "../../server/runtime-store.mjs";
import type { TranscriptSegment } from "@/types";
import {
  escapeHtml,
  newId,
  normalizeStatus,
  nowIso,
  parseJsonOr,
  requireNonEmpty,
} from "@/lib/store-utils";
import { llmQueue, setLlmQueueConfigReader } from "@/lib/llm-queue";
import {
  AiTitleError,
  TITLE_FALLBACK_TITLE,
  TITLE_RESULT_TYPE,
  TITLE_TEMPLATE_CONTENT,
  TITLE_TEMPLATE_ID,
  TITLE_TEMPLATE_KEY,
  buildTitlePrompt,
  ensureTitleTemplate,
  sanitizeMeetingTitle,
} from "@/lib/ai-title";

type SettingRow = {
  itemSection: string;
  itemMark: string;
  itemTitle: string;
  itemDescription: string;
  itemValue: string;
  updatedAt?: string;
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
  createdAt?: string;
  updatedAt?: string;
};

type HotwordRow = {
  id: string;
  term: string;
  weight: number;
  status: string;
  note: string;
  createdAt?: string;
  updatedAt?: string;
};

type UserRow = {
  id: string;
  accountName: string;
  displayName: string;
  email: string;
  department: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

type RoleRow = {
  id: string;
  roleKey: string;
  roleName: string;
  createdAt?: string;
};

type UserWithRoles = UserRow & { roles: RoleRow[] };

type JsonRecord = Record<string, unknown>;

type MeetingRow = {
  id: string;
  title: string;
  status: string;
  lastErrorMessage: string | null;
  sourceType: string;
  durationSeconds: number | null;
  createdAt: string;
  summary: string | null;
};

type MeetingAsrRow = {
  id: string;
  meetingId: string;
  asrProvider: string;
  asrSettingMark: string;
  captureSessionId: string | null;
  resultFormat: string;
  rawPayload: string | null;
  normalizedText: string | null;
  asrConfigSnapshot: string | null;
  createdAt: string;
};

type MeetingAsrSummaryRow = Omit<MeetingAsrRow, "rawPayload" | "normalizedText" | "asrConfigSnapshot"> & {
  rawPayloadBytes: number;
  normalizedTextLength: number;
};

type AuditLogRow = {
  id: string;
  actorUserId: string | null;
  actorAccountName: string | null;
  actorDisplayName: string | null;
  actionType: string;
  resourceType: string;
  resourceId: string;
  resourceName: string | null;
  result: string;
  errorMessage: string | null;
  createdAt: string;
};

type MeetingTranscriptSegment = {
  id: string;
  speaker: string;
  speakerId?: number | null;
  text: string;
  time: string;
  timeSeconds: number;
  isFinal: boolean;
};

type MeetingInput = {
  title: string;
  sourceType: string;
  sourceFileName: string | null;
  durationSeconds: number | null;
  captureSessionId: string;
  captureSessionIds?: string[];
  transcriptSegments: MeetingTranscriptSegment[];
};

type MeetingLlmResultRow = {
  id: string;
  meetingId: string;
  inputTranscriptSnapshot: string;
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
  createdAt?: string;
};

type MeetingSendRecordRow = {
  id: string;
  meetingLlmResultId: string;
  mailTemplateType: string;
  subject: string;
  toRecipientsJson: string | null;
  ccRecipientsJson: string | null;
  bodyMarkdown: string;
  bodyHtml: string;
  status: string;
  mailSettingMark: string;
  mailConfigSnapshot: string;
  providerType: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  sentByUserId: string;
  createdAt?: string;
  sentAt?: string | null;
};

type AsrCaptureSessionRow = {
  captureSessionId: string;
  taskId: string;
  asrProvider: string;
  asrConfigSnapshot: string;
  hotwordsJson: string;
  status: string;
};

type ActorContext = {
  id: string;
  accountName: string;
  displayName: string;
  status: string;
  email?: string | null;
  mustChangePassword?: boolean;
};

type PasswordVerificationResult = {
  ok: boolean;
  needsRehash: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

const PASSWORD_SCHEME = "scrypt-v1";
const SESSION_TTL_DAYS = 7;
const SECRET_SETTING_KEYS = new Set([
  "asr:api_key",
  "llm:api_key",
  "mail:smtp_password",
  "tts:api_key",
]);

type SettingDefinition = {
  itemTitle: string;
  itemDescription: string;
  validate: (value: string) => string;
};

function validateSettingValue(value: string, label: string, maxLength: number, required = true) {
  if (value.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} contains invalid control characters`);
  }
  if (required && !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function textSetting(label: string, maxLength: number, required = true) {
  return (value: string) => validateSettingValue(value, label, maxLength, required).trim();
}

function secretSetting(label: string, maxLength: number) {
  return (value: string) => validateSettingValue(value, label, maxLength, false);
}

function urlSetting(label: string, protocols: string[]) {
  return (value: string) => {
    const normalized = textSetting(label, 2048)(value);
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new Error(`${label} must be a valid URL`);
    }
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error(`${label} must use an allowed protocol without embedded credentials`);
    }
    return normalized;
  };
}

function integerSetting(label: string, min: number, max: number, required = false) {
  return (value: string) => {
    const normalized = validateSettingValue(value, label, 32, required).trim();
    if (!normalized) return "";
    if (!/^\d+$/.test(normalized)) {
      throw new Error(`${label} must be an integer`);
    }
    const number = Number(normalized);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new Error(`${label} must be between ${min} and ${max}`);
    }
    return String(number);
  };
}

function emailSetting(label: string) {
  return (value: string) => {
    const normalized = textSetting(label, 320)(value);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error(`${label} must be a valid email address`);
    }
    return normalized;
  };
}

const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  "asr:provider": {
    itemTitle: "ASR Provider",
    itemDescription: "当前 ASR 提供方",
    validate: (value) => {
      const normalized = textSetting("ASR provider", 32)(value);
      if (!(["local_funasr", "dashscope"] as string[]).includes(normalized)) {
        throw new Error("ASR provider is invalid");
      }
      return normalized;
    },
  },
  "asr:endpoint": {
    itemTitle: "FunASR Endpoint",
    itemDescription: "FunASR 服务地址",
    validate: urlSetting("ASR endpoint", ["ws:", "wss:"]),
  },
  "asr:api_key": {
    itemTitle: "ASR API Key",
    itemDescription: "DashScope API Key",
    validate: secretSetting("ASR API key", 2048),
  },
  "asr:workspace_id": {
    itemTitle: "ASR Workspace ID",
    itemDescription: "DashScope Workspace ID",
    validate: textSetting("ASR workspace ID", 256, false),
  },
  "audio:record_enabled": {
    itemTitle: "录音落盘开关",
    itemDescription: "转写的同时在服务端旁路录制原始音频，会议结束后转成 MP3 保存（默认开）",
    validate: (value) => {
      const normalized = validateSettingValue(value, "Audio record enabled", 16, false);
      const lower = normalized.toLowerCase();
      return normalized === "0" || lower === "false" || lower === "no" || lower === "off" ? "0" : "1";
    },
  },
  "audio:bitrate_kbps": {
    itemTitle: "录音码率（kbps）",
    itemDescription: "会议结束后转码 MP3 的码率，可选 32 / 48 / 64 / 96 / 128（默认 48，约 21 MB/小时）",
    validate: (value) => {
      const normalized = validateSettingValue(value, "Audio bitrate", 32, true).trim();
      if (!["32", "48", "64", "96", "128"].includes(normalized)) {
        throw new Error("Audio bitrate must be one of 32/48/64/96/128");
      }
      return normalized;
    },
  },
  "audio:orphan_ttl_hours": {
    itemTitle: "孤儿录音保留（小时）",
    itemDescription: "未绑定到任何会议的录音保留时长，超时后连同文件一起清理（默认 72）",
    validate: integerSetting("Audio orphan TTL hours", 1, 24 * 365),
  },
  "llm:base_url": {
    itemTitle: "LLM URL",
    itemDescription: "OpenAI 兼容服务根地址",
    validate: urlSetting("LLM base URL", ["http:", "https:"]),
  },
  "llm:api_key": {
    itemTitle: "LLM API Key",
    itemDescription: "LLM API Key",
    validate: secretSetting("LLM API key", 2048),
  },
  "llm:model": {
    itemTitle: "LLM Model",
    itemDescription: "当前使用模型",
    validate: textSetting("LLM model", 256),
  },
  "llm:context_size": {
    itemTitle: "上下文大小（字符）",
    itemDescription: "发送给 LLM 的文本截断长度，留空不截断",
    validate: integerSetting("LLM context size", 1, 1_000_000),
  },
  "llm:max_tokens": {
    itemTitle: "最大回复 Tokens",
    itemDescription: "留空则由 LLM 自行决定回复长度",
    validate: integerSetting("LLM max tokens", 1, 100_000),
  },
  "llm:timeout_ms": {
    itemTitle: "调用超时（毫秒）",
    itemDescription: "留空使用默认 300000",
    validate: integerSetting("LLM timeout", 1_000, 600_000),
  },
  "llm:max_concurrency": {
    itemTitle: "LLM 并发数",
    itemDescription: "全局队列同时执行的 LLM 请求数，默认 2",
    validate: integerSetting("LLM concurrency", 1, 20),
  },
  "llm:queue_capacity": {
    itemTitle: "LLM 排队长度",
    itemDescription: "全局队列最多排队等待的请求数，超出直接拒绝，默认 10",
    validate: integerSetting("LLM queue capacity", 1, 200),
  },
  "llm:translate_trigger_sentences": {
    itemTitle: "翻译触发句数",
    itemDescription: "实时翻译攒够多少句 final 触发一次，越小越实时（默认 3）",
    validate: integerSetting("LLM translate trigger sentences", 1, 20),
  },
  "llm:thinking_model": {
    itemTitle: "模型是否带思考模式",
    itemDescription: "Qwen3 等推理模型会输出思考内容，开启后自动附加关闭思考参数（默认开）",
    validate: (value) => {
      const normalized = validateSettingValue(value, "Thinking model", 16, false);
      const lower = normalized.toLowerCase();
      return lower === "1" || lower === "true" || lower === "yes" ? "1" : "0";
    },
  },
  "mail:smtp_host": {
    itemTitle: "SMTP Host",
    itemDescription: "邮件服务主机",
    validate: textSetting("SMTP host", 255),
  },
  "mail:smtp_port": {
    itemTitle: "SMTP Port",
    itemDescription: "邮件服务端口",
    validate: integerSetting("SMTP port", 1, 65_535, true),
  },
  "mail:smtp_secure": {
    itemTitle: "SSL 加密",
    itemDescription: "使用 SSL/TLS 加密连接（如 465 端口）；关闭则使用明文（如内部 relay 的 25 端口）",
    validate: (value) => {
      const normalized = validateSettingValue(value, "SMTP secure", 16, false);
      return normalized === "0" || normalized.toLowerCase() === "false" || normalized.toLowerCase() === "no" ? "0" : "1";
    },
  },
  "mail:smtp_username": {
    itemTitle: "SMTP Username",
    itemDescription: "邮件服务用户名",
    validate: textSetting("SMTP username", 320),
  },
  "mail:smtp_password": {
    itemTitle: "SMTP Password",
    itemDescription: "邮件服务密码",
    validate: secretSetting("SMTP password", 2048),
  },
  "mail:from_name": {
    itemTitle: "From Name",
    itemDescription: "发件人名称",
    validate: textSetting("From name", 256),
  },
  "mail:from_email": {
    itemTitle: "From Email",
    itemDescription: "发件人邮箱",
    validate: emailSetting("From email"),
  },
  "mail:default_subject_template": {
    itemTitle: "Default Subject",
    itemDescription: "默认邮件主题模板",
    validate: textSetting("Default subject template", 512),
  },
  "mail:default_signature": {
    itemTitle: "Default Signature",
    itemDescription: "默认邮件签名",
    validate: textSetting("Default signature", 2_000),
  },
  "mail:default_cc": {
    itemTitle: "Default CC",
    itemDescription: "默认抄送",
    validate: (value) => {
      const normalized = validateSettingValue(value, "Default CC", 16_384, true);
      let recipients: unknown;
      try {
        recipients = JSON.parse(normalized);
      } catch {
        throw new Error("Default CC must be valid JSON");
      }
      if (!Array.isArray(recipients) || recipients.length > 100 || recipients.some((item) => typeof item !== "string")) {
        throw new Error("Default CC must be an array of at most 100 email addresses");
      }
      recipients.forEach((item) => emailSetting("Default CC address")(item));
      return JSON.stringify(recipients.map((item) => item.trim()));
    },
  },
  "mail:allowed_domains": {
    itemTitle: "允许的收件邮箱域名",
    itemDescription: "逗号分隔，限制纪要只能发送到这些域名（如 company.com）；留空则不限制",
    validate: (value) => {
      const normalized = validateSettingValue(value, "Allowed recipient domains", 512, false);
      if (!normalized) return "";
      const domains = normalized
        .split(",")
        .map((item) => item.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean);
      if (domains.length === 0) return "";
      for (const domain of domains) {
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
          throw new Error(`Allowed recipient domain "${domain}" is invalid`);
        }
      }
      return domains.join(",");
    },
  },
  "system:default_prompt_template_id": {
    itemTitle: "默认纪要模板",
    itemDescription: "自动生成首版结果时使用",
    validate: textSetting("Default prompt template", 128),
  },
  "voiceprint:enabled": {
    itemTitle: "服务端声纹识别",
    itemDescription: "录音时对每句 final 转写调用声纹服务识别说话人（开启后说话人显示为人名，关闭则回退前端启发式聚类）",
    validate: (value) => {
      const normalized = textSetting("Voiceprint enabled", 8)(value);
      if (!(["true", "false"] as string[]).includes(normalized)) {
        throw new Error("Voiceprint enabled must be true or false");
      }
      return normalized;
    },
  },
  "voiceprint:endpoint": {
    itemTitle: "声纹服务地址（已弃用）",
    itemDescription: "旧版单一服务地址，已由 endpoint_zh / endpoint_zh_en 替代（保留以兼容旧库）",
    validate: urlSetting("Voiceprint endpoint", ["http:", "https:"]),
  },
  "voiceprint:model": {
    itemTitle: "声纹识别模型",
    itemDescription: "zh=中文版 CAM++（中文会议）；zh_en=中英双语版（英文/中英混合会议）",
    validate: (value) => {
      const normalized = textSetting("Voiceprint model", 8)(value);
      if (!["zh", "zh_en"].includes(normalized)) {
        throw new Error("Voiceprint model must be zh or zh_en");
      }
      return normalized;
    },
  },
  "voiceprint:endpoint_zh": {
    itemTitle: "中文版声纹服务地址",
    itemDescription: "中文版 CAM++ 容器（默认 http://127.0.0.1:10097）",
    validate: urlSetting("Voiceprint zh endpoint", ["http:", "https:"]),
  },
  "voiceprint:endpoint_zh_en": {
    itemTitle: "双语版声纹服务地址",
    itemDescription: "中英双语版 CAM++ 容器（默认 http://127.0.0.1:10098）",
    validate: urlSetting("Voiceprint zh_en endpoint", ["http:", "https:"]),
  },
  "tts:provider": {
    itemTitle: "TTS 协议",
    itemDescription: "cosyvoice（私有协议）/ openai（OpenAI 兼容标准协议）",
    validate: (value: string) => {
      const normalized = String(value ?? "").trim().toLowerCase();
      if (normalized && !["cosyvoice", "openai"].includes(normalized)) {
        throw new Error("TTS provider must be cosyvoice or openai");
      }
      return normalized;
    },
  },
  "tts:model": {
    itemTitle: "TTS 模型",
    itemDescription: "OpenAI 兼容服务的模型名（如 tts-1 / gpt-4o-mini-tts），cosyvoice 协议下忽略",
    validate: textSetting("TTS model", 128, false),
  },
  "tts:endpoint": {
    itemTitle: "TTS 服务地址",
    itemDescription:
      "cosyvoice：CosyVoice 容器地址（默认 http://localhost:8010）；openai：服务根地址（如 https://api.openai.com，不要带 /v1，网关自动拼 /v1/audio/speech）",
    validate: urlSetting("TTS endpoint", ["http:", "https:"]),
  },
  "tts:api_key": {
    itemTitle: "TTS API Key",
    itemDescription: "openai 协议的鉴权 key（Authorization: Bearer）；免鉴权服务留空",
    validate: secretSetting("TTS api key", 512),
  },
  "tts:default_voice": {
    itemTitle: "默认音色",
    itemDescription: "语音对话按回复语言自动选音色；识别失败时使用此默认值",
    validate: textSetting("TTS default voice", 64),
  },
};

let dbSeeded = false;
let seedPromise: Promise<void> | null = null;
const actorContext = new AsyncLocalStorage<ActorContext>();

const globalForLlmReconcile = globalThis as unknown as { __llmStuckReconciled?: boolean };

/**
 * Promise 化的数据库句柄（`server/db-shared.mjs` 的 AsyncDb）。
 *
 * 与 legacy `src/types/node-sqlite.d.ts` 的 `DatabaseSync` **同形**：
 * `prepare<T>()` / `get<U>()` / `all<U>()` 的泛型调用写法不变，只是返回值变成 Promise。
 * 这样 78 处迁移点只需补 `await`，类型断言与 SQL 文本逐字不变。
 */
type SqliteRow = Record<string, unknown>;

type AsyncStatement = {
  run: (...params: unknown[]) => Promise<{ changes?: number; lastInsertRowid?: number | null }>;
  get: <U = SqliteRow>(...params: unknown[]) => Promise<U | undefined>;
  all: <U = SqliteRow>(...params: unknown[]) => Promise<U[]>;
};

type AsyncDatabase = {
  exec: (sql: string) => Promise<void>;
  prepare: <T = SqliteRow>(sql: string) => AsyncStatement;
  withTransaction: <T>(callback: () => Promise<T>) => Promise<T>;
};

/**
 * 事务：直接交给 `AsyncDb.withTransaction()`（同一实例串行化，见 server/db/async-db.mjs）。
 *
 * 与 legacy 的差异：legacy 是「嵌套时直接把回调放进外层事务里跑」（扁平），现在是
 * 「嵌套时开 savepoint」（内层回滚只影响内层）。两者在「内层异常向外穿透」时结果相同；
 * 差别只出现在外层吞掉内层异常时（legacy 内层写入保留、新实现内层写入回滚），
 * 本单所有调用点都不吞内层异常。详见交付报告「行为差异清单」。
 */
async function withTransaction<T>(callback: () => Promise<T>): Promise<T> {
  const database = await getDb();
  return database.withTransaction(callback);
}

/**
 * 取数据库句柄（单例）。
 *
 * 首次调用做一次幂等初始化（auth 列自愈 → 种子数据 → 卡住的 LLM 任务收敛）；
 * 异步化后用 single-flight promise 代替 legacy 的 `dbSeeded` 布尔值，避免并发首调重复跑。
 *
 * ⚠ 播种期间必须**重入放行**：seedDefaults / seedIdentityDefaults 内部会调用
 * `upsertPromptTemplate` / `upsertHotword` / `writeAuditLog` 等仍然走 `getDb()` 的函数。
 * 若这些调用也去 `await seedPromise`，就会等待「自己所在的那个 promise」—— 永久挂住
 * （同步时代 `dbSeeded` 是布尔值，重入只会看到 true 直接返回句柄，所以没有这个问题）。
 * 用 AsyncLocalStorage 标记播种上下文：**同一个异步上下文**内重入直接拿句柄，
 * 其他并发调用仍然排队等播种完成。
 */
const seedingContext = new AsyncLocalStorage<AsyncDatabase>();

async function getDb(): Promise<AsyncDatabase> {
  const seedingDb = seedingContext.getStore();
  if (seedingDb) return seedingDb;

  const database = (await getSharedDb()) as unknown as AsyncDatabase;
  if (!seedPromise) {
    seedPromise = seedingContext
      .run(database, async () => {
        await migrateAuthSchema(database);
        await seedDefaults(database);
        await reconcileStuckLlmProcessing(database);
      })
      .catch((error) => {
        seedPromise = null;
        throw error;
      });
  }
  await seedPromise;
  return database;
}

async function reconcileStuckLlmProcessing(database: AsyncDatabase) {
  if (globalForLlmReconcile.__llmStuckReconciled) return;
  globalForLlmReconcile.__llmStuckReconciled = true;

  const stuck = await database
    .prepare("SELECT id FROM meetings WHERE status = 'llm_processing'")
    .all() as Array<{ id: string }>;
  for (const row of stuck) {
    await database
      .prepare(`
        UPDATE meetings
        SET status = 'llm_failed', last_error_message = ?, status_updated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'llm_processing'
      `)
      .run("服务重启，生成任务已中断，请重新生成", nowIso(), nowIso(), row.id);
  }
  if (stuck.length > 0) {
    console.warn(`[LLM] reconcile: marked ${stuck.length} stuck llm_processing meeting(s) as failed`);
  }
}

async function migrateAuthSchema(database: AsyncDatabase) {
  await ensureColumn(database, "users", "password_hash", "TEXT");
  await ensureColumn(database, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(database, "users", "last_login_at", "TEXT");
}

async function ensureColumn(database: AsyncDatabase, tableName: string, columnName: string, definition: string) {
  const columns = (await database.prepare(`PRAGMA table_info(${tableName})`).all()) as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) return;
  await database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function seedDefaults(database: AsyncDatabase) {
  const templateCount = Number(
    (await database.prepare("SELECT COUNT(*) as count FROM llm_prompt_templates").get())?.count ?? 0
  );
  const hotwordCount = Number(
    (await database.prepare("SELECT COUNT(*) as count FROM asr_hotwords").get())?.count ?? 0
  );

  await seedIdentityDefaults(database);

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
        itemSection: "audio",
        itemMark: "record_enabled",
        itemTitle: "录音落盘开关",
        itemDescription: "转写的同时在服务端旁路录制原始音频，会议结束后转成 MP3 保存（默认开）",
        itemValue: "1",
      },
      {
        itemSection: "audio",
        itemMark: "bitrate_kbps",
        itemTitle: "录音码率（kbps）",
        itemDescription: "会议结束后转码 MP3 的码率，可选 32 / 48 / 64 / 96 / 128（默认 48，约 21 MB/小时）",
        itemValue: "48",
      },
      {
        itemSection: "audio",
        itemMark: "orphan_ttl_hours",
        itemTitle: "孤儿录音保留（小时）",
        itemDescription: "未绑定到任何会议的录音保留时长，超时后连同文件一起清理（默认 72）",
        itemValue: "72",
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
        itemSection: "llm",
        itemMark: "context_size",
        itemTitle: "上下文大小（字符）",
        itemDescription: "发送给 LLM 的文本截断长度，留空不截断",
        itemValue: "",
      },
      {
        itemSection: "llm",
        itemMark: "max_tokens",
        itemTitle: "最大回复 Tokens",
        itemDescription: "留空则由 LLM 自行决定回复长度",
        itemValue: "",
      },
      {
        itemSection: "llm",
        itemMark: "timeout_ms",
        itemTitle: "调用超时（毫秒）",
        itemDescription: "留空使用默认 300000",
        itemValue: "",
      },
      {
        itemSection: "llm",
        itemMark: "max_concurrency",
        itemTitle: "LLM 并发数",
        itemDescription: "全局队列同时执行的 LLM 请求数",
        itemValue: "2",
      },
      {
        itemSection: "llm",
        itemMark: "queue_capacity",
        itemTitle: "LLM 排队长度",
        itemDescription: "全局队列最多排队等待的请求数，超出直接拒绝",
        itemValue: "10",
      },
      {
        itemSection: "llm",
        itemMark: "translate_trigger_sentences",
        itemTitle: "翻译触发句数",
        itemDescription: "实时翻译攒够多少句 final 触发一次，越小越实时",
        itemValue: "3",
      },
      {
        itemSection: "llm",
        itemMark: "thinking_model",
        itemTitle: "模型是否带思考模式",
        itemDescription: "Qwen3 等推理模型会输出思考内容，开启后自动附加关闭思考参数（默认开）",
        itemValue: "1",
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
        itemMark: "smtp_secure",
        itemTitle: "SSL 加密",
        itemDescription: "使用 SSL/TLS 加密连接（如 465 端口）；关闭则使用明文（如内部 relay 的 25 端口）",
        itemValue: "1",
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
        itemSection: "mail",
        itemMark: "allowed_domains",
        itemTitle: "允许的收件邮箱域名",
        itemDescription: "逗号分隔，限制纪要只能发送到这些域名；留空则不限制",
        itemValue: "",
      },
      {
        itemSection: "voiceprint",
        itemMark: "enabled",
        itemTitle: "服务端声纹识别",
        itemDescription: "录音时对每句 final 转写调用声纹服务识别说话人",
        itemValue: "true",
      },
      {
        itemSection: "voiceprint",
        itemMark: "model",
        itemTitle: "声纹识别模型",
        itemDescription: "zh=中文版（默认）；zh_en=中英双语版（英文会议）",
        itemValue: "zh",
      },
      {
        itemSection: "voiceprint",
        itemMark: "endpoint",
        itemTitle: "声纹服务地址（已弃用）",
        itemDescription: "旧版单一服务地址，已由 endpoint_zh / endpoint_zh_en 替代",
        itemValue: "http://127.0.0.1:10097",
      },
      {
        itemSection: "voiceprint",
        itemMark: "endpoint_zh",
        itemTitle: "中文版声纹服务地址",
        itemDescription: "中文版 CAM++ 容器（默认 http://127.0.0.1:10097）",
        itemValue: "http://127.0.0.1:10097",
      },
      {
        itemSection: "voiceprint",
        itemMark: "endpoint_zh_en",
        itemTitle: "双语版声纹服务地址",
        itemDescription: "中英双语版 CAM++ 容器（默认 http://127.0.0.1:10098）",
        itemValue: "http://127.0.0.1:10098",
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
    await insertMissingSetting(database, setting);
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
      await upsertPromptTemplate(template);
    }
  }

  if (hotwordCount === 0) {
    const hotwords: HotwordRow[] = [
      { id: "hw-1", term: "阿里巴巴", weight: 20, status: "active", note: "公司名称" },
      { id: "hw-2", term: "达摩院", weight: 15, status: "active", note: "组织名称" },
      { id: "hw-3", term: "语音识别", weight: 10, status: "disabled", note: "领域词" },
    ];

    for (const hotword of hotwords) {
      await upsertHotword(hotword);
    }
  }

  await upsertPromptTemplate({
    id: "tpl-translate",
    templateKey: "system_translate",
    templateName: "会议翻译",
    templateType: "translation",
    content: "你是实时会议翻译助手。将用户发来的会议记录逐行翻译成目标语言，只输出译文，不要解释、不要编号。",
    description: "系统内置翻译模板，按句分批调用 LLM",
    status: "active",
    isSystem: true,
  });

  // feat-261101-04（#44）：tpl-title **无条件**确保存在。
  // 上面 tpl-1/tpl-2 的种子包在 `if (templateCount === 0)` 里，老库（已有任意模板）
  // 那一整块不会跑 —— 只靠种子会拿不到标题模板。语义与 tpl-translate 的覆盖式 upsert
  // 不同：**已有同名模板（id=tpl-title 或 template_key=system_title）就不覆盖**
  // （用户可能改过内容），缺失才插入。见 src/lib/ai-title.ts ensureTitleTemplate。
  await ensureTitleTemplate(database, nowIso());
}

async function insertMissingSetting(database: AsyncDatabase, setting: SettingRow) {
  await database
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

async function upsertSetting(setting: SettingRow) {
  const database = await getDb();
  await database
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

async function upsertPromptTemplate(template: PromptTemplateRow) {
  const database = await getDb();
  const existing = await database
    .prepare("SELECT created_at as createdAt FROM llm_prompt_templates WHERE id = ?")
    .get(template.id) as { createdAt?: string } | undefined;

  await database
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

async function upsertHotword(hotword: HotwordRow) {
  const database = await getDb();
  const existing = await database
    .prepare("SELECT created_at as createdAt FROM asr_hotwords WHERE id = ?")
    .get(hotword.id) as { createdAt?: string } | undefined;

  await database
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

function isSecretSetting(setting: Pick<SettingRow, "itemSection" | "itemMark">) {
  return SECRET_SETTING_KEYS.has(`${setting.itemSection}:${setting.itemMark}`);
}

export async function listSettings() {
  const database = await getDb();
  return await database
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
    .all<SettingRow>();
}

export async function listSettingsForAdmin() {
  return (await listSettings() as Array<SettingRow & { updatedAt?: string }>).map((setting) => ({
    ...setting,
    itemValue: isSecretSetting(setting) ? "" : setting.itemValue,
    isSecret: isSecretSetting(setting),
    hasValue: isSecretSetting(setting) ? Boolean(setting.itemValue) : undefined,
  }));
}

export async function getSettingValue(section: string, mark: string) {
  const row = (await listSettings() as Array<SettingRow>)
    .find((setting) => setting.itemSection === section && setting.itemMark === mark);
  return row?.itemValue ?? "";
}

async function buildDisableThinkingParams(): Promise<Record<string, unknown>>{
  if (await getSettingValue("llm", "thinking_model") === "0") return {};
  return {
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
    think: false,
  };
}

const TRANSLATE_TARGET_LABELS: Record<string, string> = {
  zh: "中文",
  en: "英文",
  ja: "日语",
  ko: "韩语",
};

export interface TranslateResult {
  text: string;
  elapsedMs: number;
}

export async function translateSentences(sentences: string[], targetLang: string): Promise<TranslateResult> {
  const baseUrl = await getSettingValue("llm", "base_url");
  const apiKey = await getSettingValue("llm", "api_key");
  const model = await getSettingValue("llm", "model");
  if (!baseUrl || !model) throw new Error("LLM config incomplete");

  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
  const targetLabel = TRANSLATE_TARGET_LABELS[targetLang] || targetLang || "英文";
  const content = sentences.join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const requestStartedAt = Date.now();
  try {
    const { status, text } = await llmRequest(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `你是实时会议翻译助手。把用户发来的会议记录逐行翻译成${targetLabel}。只输出译文，每行对应原文一行，不要编号、不要解释。`,
          },
          { role: "user", content },
        ],
        temperature: 0.3,
        ...buildDisableThinkingParams(),
      }),
      signal: controller.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`LLM API error: ${status} ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const translated = stripLeadingThinking(String(parsed.choices?.[0]?.message?.content ?? "").trim());
    if (!translated) throw new Error("LLM returned empty translation");
    return { text: translated, elapsedMs: Date.now() - requestStartedAt };
  } finally {
    clearTimeout(timer);
  }
}

export interface TranslateSelectionResult {
  text: string;
  elapsedMs: number;
}

export async function translateSelection(text: string, targetLang: string): Promise<TranslateSelectionResult> {
  const baseUrl = await getSettingValue("llm", "base_url");
  const apiKey = await getSettingValue("llm", "api_key");
  const model = await getSettingValue("llm", "model");
  if (!baseUrl || !model) throw new Error("LLM config incomplete");

  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
  const targetLabel = TRANSLATE_TARGET_LABELS[targetLang] || targetLang || "英文";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const requestStartedAt = Date.now();
  try {
    const { status, text: responseText } = await llmRequest(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              `你是语言教学助手。用户会选中的一段文本（可能是单词、短语或句子），并希望翻译成${targetLabel}。` +
              `请严格按下面的格式用 markdown 输出，每项独占一行，使用列表符号，不要多余说明、不要编号。\n` +
              `\n` +
              `单词或短语格式示例（把英文单词 snide 译为中文）：\n` +
              `- 词性 + 释义：形容词；挖苦的，讽刺的\n` +
              `- 音标：/snaɪd/\n` +
              `- 例句：He made a snide remark about her outfit. — 他对她的穿着做了一个讽刺的评论。\n` +
              `\n` +
              `句子格式：\n` +
              `- 整句翻译：整句翻译成${targetLabel}\n` +
              `- 重点单词（拆出 2~4 个），每个单独列出：\n` +
              `  - 单词 / 词性 + 释义\n` +
              `  - 音标（仅译文为英文时给出）\n` +
              `  - 例句：目标语言原文 — 中文翻译`,
          },
          { role: "user", content: text },
        ],
        temperature: 0.2,
        ...buildDisableThinkingParams(),
      }),
      signal: controller.signal,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`LLM API error: ${status} ${responseText.slice(0, 200)}`);
    }
    const parsed = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: unknown } }> };
    const translated = stripLeadingThinking(String(parsed.choices?.[0]?.message?.content ?? "").trim());
    if (!translated) throw new Error("LLM returned empty translation");
    return { text: translated, elapsedMs: Date.now() - requestStartedAt };
  } finally {
    clearTimeout(timer);
  }
}

setLlmQueueConfigReader(async () => {
  const concurrency = Number(String((await getSettingValue("llm", "max_concurrency")) || "").trim());
  const capacity = Number(String((await getSettingValue("llm", "queue_capacity")) || "").trim());
  return {
    maxConcurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 2,
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 10,
  };
});

function validateSettings(settings: unknown): SettingRow[] {
  if (!Array.isArray(settings)) {
    throw new Error("settings must be an array");
  }
  if (settings.length > Object.keys(SETTING_DEFINITIONS).length) {
    throw new Error("Too many settings entries");
  }

  const seen = new Set<string>();
  let totalValueLength = 0;
  return settings.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`settings[${index}] must be an object`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.itemSection !== "string" || typeof item.itemMark !== "string") {
      throw new Error(`settings[${index}] must include itemSection and itemMark`);
    }
    const key = `${item.itemSection}:${item.itemMark}`;
    const definition = SETTING_DEFINITIONS[key];
    if (!definition) {
      throw new Error(`Unknown setting: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate setting: ${key}`);
    }
    if (typeof item.itemValue !== "string") {
      throw new Error(`Setting ${key} value must be a string`);
    }

    const itemValue = definition.validate(item.itemValue);
    totalValueLength += itemValue.length;
    if (totalValueLength > 32_768) {
      throw new Error("Settings payload is too large");
    }
    seen.add(key);
    return {
      itemSection: item.itemSection,
      itemMark: item.itemMark,
      itemTitle: definition.itemTitle,
      itemDescription: definition.itemDescription,
      itemValue,
    };
  });
}

export async function saveSettings(settings: unknown) {
  const validatedSettings = validateSettings(settings);
  return await withTransaction(async () => {
    const existingSettings = new Map(
      (await listSettings() as SettingRow[]).map((setting) => [
        `${setting.itemSection}:${setting.itemMark}`,
        setting,
      ])
    );
    for (const setting of validatedSettings) {
      const existing = existingSettings.get(`${setting.itemSection}:${setting.itemMark}`);
      const nextSetting = isSecretSetting(setting) && setting.itemValue === "" && existing?.itemValue
        ? { ...setting, itemValue: existing.itemValue }
        : setting;
      await upsertSetting(nextSetting);
    }
    await writeAuditLog({
      actionType: "settings.update",
      resourceType: "settings",
      resourceId: "app_settings",
      afterSnapshot: validatedSettings.map((setting) => ({
        ...setting,
        itemValue: isSecretSetting(setting)
          ? "***"
          : setting.itemValue,
      })),
    });
    invalidateAsrRuntimeConfig();
    invalidateAudioRuntimeConfig();
  });
}

export async function listPromptTemplates() {
  const database = await getDb();
  return await database
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
    .all<PromptTemplateRow>()
    .then((rows) => rows.map((row) => ({ ...row, isSystem: Boolean(row.isSystem) })));
}

export async function createPromptTemplate(input: Omit<PromptTemplateRow, "id" | "isSystem"> & { isSystem?: boolean }) {
  return await withTransaction(async () => {
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
    await upsertPromptTemplate(template);
    const created = (await listPromptTemplates()).find((item) => item.id === template.id);
    await writeAuditLog({
      actionType: "prompt_template.create",
      resourceType: "prompt_template",
      resourceId: template.id,
      resourceName: template.templateName,
      afterSnapshot: created,
    });
    return created;
  });
}

export async function updatePromptTemplate(id: string, patch: Partial<Omit<PromptTemplateRow, "id">>) {
  return await withTransaction(async () => {
    const existing = (await listPromptTemplates()).find((item) => item.id === id);
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

    await upsertPromptTemplate(next);
    const updated = (await listPromptTemplates()).find((item) => item.id === id);
    await writeAuditLog({
      actionType: "prompt_template.update",
      resourceType: "prompt_template",
      resourceId: id,
      resourceName: updated?.templateName ?? existing.templateName,
      beforeSnapshot: existing,
      afterSnapshot: updated,
    });
    return updated;
  });
}

export async function listHotwords() {
  const database = await getDb();
  return await database
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
    .all<HotwordRow>();
}

export async function createHotword(input: Omit<HotwordRow, "id">) {
  return await withTransaction(async () => {
    const hotword: HotwordRow = {
      id: newId("hw"),
      term: requireNonEmpty(input.term, "Hotword term"),
      weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : 10,
      status: normalizeStatus(input.status),
      note: input.note ?? "",
    };
    await upsertHotword(hotword);
    const created = (await listHotwords()).find((item) => item.id === hotword.id);
    await writeAuditLog({
      actionType: "hotword.create",
      resourceType: "hotword",
      resourceId: hotword.id,
      resourceName: hotword.term,
      afterSnapshot: created,
    });
    invalidateAsrRuntimeConfig();
    return created;
  });
}

export async function updateHotword(id: string, patch: Partial<Omit<HotwordRow, "id">>) {
  return await withTransaction(async () => {
    const existing = (await listHotwords()).find((item) => item.id === id);
    if (!existing) return null;

    const next: HotwordRow = {
      id,
      term: patch.term === undefined ? existing.term : requireNonEmpty(patch.term, "Hotword term"),
      weight: patch.weight === undefined || !Number.isFinite(Number(patch.weight)) ? existing.weight : Number(patch.weight),
      status: patch.status === undefined ? existing.status : normalizeStatus(patch.status, existing.status),
      note: patch.note ?? existing.note,
    };

    await upsertHotword(next);
    const updated = (await listHotwords()).find((item) => item.id === id);
    await writeAuditLog({
      actionType: "hotword.update",
      resourceType: "hotword",
      resourceId: id,
      resourceName: updated?.term ?? existing.term,
      beforeSnapshot: existing,
      afterSnapshot: updated,
    });
    invalidateAsrRuntimeConfig();
    return updated;
  });
}
export async function deleteHotword(id: string) {
  return await withTransaction(async () => {
    const existing = (await listHotwords()).find((item) => item.id === id);
    const result = await (await getDb()).prepare("DELETE FROM asr_hotwords WHERE id = ?").run(id);
    const deleted = Number(result.changes ?? 0) > 0;
    if (!deleted) return false;

    await writeAuditLog({
      actionType: "hotword.delete",
      resourceType: "hotword",
      resourceId: id,
      resourceName: existing?.term ?? id,
      beforeSnapshot: existing,
    });
    invalidateAsrRuntimeConfig();
    return true;
  });
}

export async function listRoles() {
  return await (await getDb())
    .prepare<RoleRow>(`
      SELECT
        id,
        role_key as roleKey,
        role_name as roleName,
        created_at as createdAt
      FROM roles
      ORDER BY role_key ASC
    `)
    .all<RoleRow>();
}

export async function listUsers() {
  const users = await (await getDb())
    .prepare<UserRow>(`
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
    .all<UserRow>();

  return Promise.all(
    users.map<Promise<UserWithRoles>>(async (user) => ({
      ...user,
      roles: await listUserRoles(user.id),
    }))
  );
}

async function listUserRoles(userId: string) {
  return await (await getDb())
    .prepare<RoleRow>(`
      SELECT
        r.id,
        r.role_key as roleKey,
        r.role_name as roleName
      FROM user_roles ur
      INNER JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.role_key ASC
    `)
    .all<RoleRow>(userId);
}

export async function createUser(input: Omit<UserRow, "id"> & { roleKeys?: string[]; initialPassword: string }) {
  const id = newId("user");
  const createdAt = nowIso();
  const accountName = requireNonEmpty(input.accountName, "Account name");
  const displayName = requireNonEmpty(input.displayName, "Display name");
  const initialPassword = validatePassword(input.initialPassword);
  const passwordHash = await hashPassword(initialPassword);
  return await withTransaction(async () => {
    (await getDb())
      .prepare(`
        INSERT INTO users (
          id, account_name, display_name, email, department, external_user_id,
          password_hash, must_change_password, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        accountName,
        displayName,
        input.email,
        input.department,
        null,
        passwordHash,
        1,
        normalizeStatus(input.status),
        createdAt,
        createdAt
      );

    await setUserRoleKeys(id, input.roleKeys ?? ["user"]);
    const user = (await listUsers()).find((item) => item.id === id);
    await writeAuditLog({
      actionType: "user.create",
      resourceType: "user",
      resourceId: id,
      resourceName: accountName,
      afterSnapshot: user,
    });
    return user;
  });
}

export async function resetUserPassword(userId: string, nextPassword: string) {
  const next = validatePassword(nextPassword);
  const existing = (await listUsers()).find((item) => item.id === userId);
  if (!existing) return null;

  const passwordHash = await hashPassword(next);
  return await withTransaction(async () => {
    (await getDb())
      .prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 1, updated_at = ?
        WHERE id = ?
      `)
      .run(passwordHash, nowIso(), userId);
    await (await getDb()).prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);

    const updated = (await listUsers()).find((item) => item.id === userId);
    await writeAuditLog({
      actionType: "user.password_reset",
      resourceType: "user",
      resourceId: userId,
      resourceName: updated?.accountName ?? existing.accountName,
      afterSnapshot: {
        userId,
        mustChangePassword: true,
        sessionsRevoked: true,
      },
    });
    return updated;
  });
}

export async function updateUser(id: string, patch: Partial<Omit<UserRow, "id">> & { roleKeys?: string[] }) {
  return await withTransaction(async () => {
    const before = (await listUsers()).find((item) => item.id === id);
    if (!before) return null;
    ensureUserChangeAllowed(id, patch);

    (await getDb())
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
      await setUserRoleKeys(id, patch.roleKeys);
    }

    const after = (await listUsers()).find((item) => item.id === id);
    await writeAuditLog({
      actionType: "user.update",
      resourceType: "user",
      resourceId: id,
      resourceName: after?.accountName ?? before.accountName,
      beforeSnapshot: before,
      afterSnapshot: after,
    });
    return after;
  });
}

export async function setUserRoleKeys(userId: string, roleKeys: string[]) {
  return await withTransaction(async () => {
    ensureUserRoleChangeAllowed(userId, roleKeys);
    const database = await getDb();
    const roles = await database
      .prepare(`SELECT id, role_key as roleKey FROM roles`)
      .all() as Array<{ id: string; roleKey: string }>;
    const selectedRoles = roles.filter((role) => roleKeys.includes(role.roleKey));
    const selectedRoleKeys = new Set(selectedRoles.map((role) => role.roleKey));
    const unknownRoleKeys = roleKeys.filter((roleKey) => !selectedRoleKeys.has(roleKey));
    if (unknownRoleKeys.length > 0) {
      throw new Error(`Unknown role keys: ${unknownRoleKeys.join(", ")}`);
    }

    await database.prepare("DELETE FROM user_roles WHERE user_id = ?").run(userId);
    for (const role of selectedRoles) {
      await database
        .prepare(`
        INSERT OR IGNORE INTO user_roles (id, user_id, role_id, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(newId("user-role"), userId, role.id, nowIso());
    }

    return (await listUsers()).find((item) => item.id === userId) ?? null;
  });
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

export async function listAuditLogs(limit = 100) {
  return await (await getDb())
          .prepare<AuditLogRow>(`
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

export async function cleanupExpiredAuditLogs(retentionDays = 30) {
  return await cleanupSharedAuditLogs(retentionDays);
}

export async function getRuntimeConfig() {
  const settings = await listSettings();
  const templates = await listPromptTemplates();

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
      translateTriggerSentences: Number(String(get("llm", "translate_trigger_sentences") || "3").trim()) || 3,
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

export async function listActiveHotwordMap() {
  const active = (await listHotwords()).filter((item) => item.status === "active");
  return active.reduce<Record<string, number>>((acc, item) => {
    acc[item.term] = Number(item.weight);
    return acc;
  }, {});
}

async function getAsrCaptureSession(captureSessionId: string) {
  if (!captureSessionId) return null;

  const row = (await (await getDb())
    .prepare(`
      SELECT
        capture_session_id as captureSessionId,
        task_id as taskId,
        asr_provider as asrProvider,
        asr_config_snapshot as asrConfigSnapshot,
        hotwords_json as hotwordsJson,
        status
      FROM asr_capture_sessions
      WHERE capture_session_id = ?
    `)
    .get(captureSessionId)) as AsrCaptureSessionRow | undefined;

  return row ?? null;
}

function redactAsrConfigSnapshot(snapshot: unknown) {
  const record = isRecord(snapshot) ? snapshot : {};
  const hotwords = record.hotwords;
  return {
    providerType: String(record.providerType ?? record.provider ?? "unknown"),
    hasEndpoint: Boolean(record.endpoint),
    hasWorkspaceId: Boolean(record.workspaceId),
    hasApiKey: Boolean(record.hasApiKey),
    hotwordCount: isRecord(hotwords)
      ? Object.keys(hotwords).length
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

function scryptAsync(password: string, salt: string, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `${PASSWORD_SCHEME}$16384$8$1$${salt}$${key.toString("hex")}`;
}

// 仅供 await getDb() 同步初始化（seedIdentityDefaults）使用；交互路径一律使用异步 hashPassword。
function hashPasswordSync(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return `${PASSWORD_SCHEME}$16384$8$1$${salt}$${key}`;
}

function validatePassword(password: unknown) {
  const value = String(password ?? "");
  if (value.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (value.length > 128) {
    throw new Error("Password must be at most 128 characters");
  }
  return value;
}

async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<PasswordVerificationResult> {
  if (!storedHash) return { ok: false, needsRehash: false };

  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== PASSWORD_SCHEME) {
    return { ok: false, needsRehash: false };
  }

  const [, nRaw, rRaw, pRaw, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scryptAsync(password, salt, expected.length, {
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

async function seedIdentityDefaults(database: AsyncDatabase) {
  const userCount = Number(
    (await database.prepare("SELECT COUNT(*) as count FROM users").get())?.count ?? 0
  );
  const bootstrapAdminAccount = getBootstrapAdminAccount();
  const bootstrapAdminPassword = getBootstrapAdminPassword();

  const roles: RoleRow[] = [
    { id: "role-user", roleKey: "user", roleName: "普通用户" },
    { id: "role-system-admin", roleKey: "system_admin", roleName: "管理员" },
  ];

  for (const role of roles) {
    await database
      .prepare(`
        INSERT INTO roles (id, role_key, role_name, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(role_key) DO UPDATE SET role_name = excluded.role_name
      `)
      .run(role.id, role.roleKey, role.roleName, nowIso());
  }

  const systemAdminRole = await database
    .prepare("SELECT id FROM roles WHERE role_key = 'system_admin'")
    .get() as { id: string } | undefined;
  const legacyMinutesAdminRole = await database
    .prepare("SELECT id FROM roles WHERE role_key = 'minutes_admin'")
    .get() as { id: string } | undefined;

  if (systemAdminRole && legacyMinutesAdminRole) {
    await database
      .prepare(`
        UPDATE OR IGNORE user_roles
        SET role_id = ?
        WHERE role_id = ?
      `)
      .run(systemAdminRole.id, legacyMinutesAdminRole.id);
    await database.prepare("DELETE FROM roles WHERE id = ?").run(legacyMinutesAdminRole.id);
  }

  const existingBootstrapAdmin = await database
    .prepare("SELECT id FROM users WHERE account_name = ?")
    .get(bootstrapAdminAccount) as { id: string } | undefined;
  const systemAdminCount = Number(
    (
      await database
        .prepare(`
          SELECT COUNT(*) as count
          FROM users u
          INNER JOIN user_roles ur ON ur.user_id = u.id
          INNER JOIN roles r ON r.id = ur.role_id
          WHERE r.role_key = 'system_admin' AND u.status = 'active'
        `)
        .get()
    )?.count ?? 0
  );
  const shouldCreateBootstrapAdmin =
    bootstrapAdminAccount && !existingBootstrapAdmin && (userCount === 0 || systemAdminCount === 0);

  if (shouldCreateBootstrapAdmin) {
    await database
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
        hashPasswordSync(bootstrapAdminPassword.password),
        bootstrapAdminPassword.mustChangePassword ? 1 : 0,
        "active",
        nowIso(),
        nowIso()
      );
  }

  const adminUser = await database
    .prepare("SELECT id, password_hash as passwordHash FROM users WHERE account_name = ?")
    .get(bootstrapAdminAccount) as { id: string; passwordHash?: string | null } | undefined;
  const adminRole = await database
    .prepare("SELECT id FROM roles WHERE role_key = ?")
    .get("system_admin") as { id: string } | undefined;

  if (adminUser && adminRole) {
    if (!adminUser.passwordHash) {
      await database
        .prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?")
        .run(
          hashPasswordSync(bootstrapAdminPassword.password),
          bootstrapAdminPassword.mustChangePassword ? 1 : 0,
          nowIso(),
          adminUser.id
        );
    }

    await database
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

export async function getActorByAccountName(accountName: string) {
  const normalizedAccount = String(accountName ?? "").trim();
  if (!normalizedAccount) return null;

  return await (await getDb())
    .prepare(`
      SELECT
        id,
        account_name as accountName,
        display_name as displayName,
        email,
        status,
        must_change_password as mustChangePassword
      FROM users
      WHERE account_name = ?
    `)
    .get(normalizedAccount) as ActorContext | null;
}

export async function authenticateUser(accountName: string, password: string) {
  const normalizedAccount = String(accountName ?? "").trim();
  if (!normalizedAccount || !password) return null;

  const user = await (await getDb())
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
  const verification = await verifyPassword(password, user.passwordHash);
  if (!verification.ok) return null;

  if (verification.needsRehash) {
    const passwordHash = await hashPassword(password);
    (await getDb())
      .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, nowIso(), user.id);
  }

  (await getDb())
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

export async function createAuthSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = sessionExpiryIso();
  (await getDb())
    .prepare(`
      INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(newId("session"), userId, hashSessionToken(token), expiresAt, nowIso(), nowIso());

  return { token, expiresAt };
}

export async function getActorBySessionToken(token: string) {
  const sessionToken = String(token ?? "").trim();
  if (!sessionToken) return null;

  const row = await (await getDb())
    .prepare(`
      SELECT
        u.id,
        u.account_name as accountName,
        u.display_name as displayName,
        u.email,
        u.status,
        u.must_change_password as mustChangePassword
      FROM auth_sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `)
    .get(hashSessionToken(sessionToken), nowIso()) as ActorContext | null;

  if (!row || row.status !== "active") return null;

  (await getDb())
    .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?")
    .run(nowIso(), hashSessionToken(sessionToken));

  return { ...row, mustChangePassword: Boolean(row.mustChangePassword) };
}

export async function deleteAuthSession(token: string) {
  const sessionToken = String(token ?? "").trim();
  if (!sessionToken) return;
  await (await getDb()).prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashSessionToken(sessionToken));
}

export async function changeUserPassword(accountName: string, currentPassword: string, nextPassword: string) {
  const normalizedAccount = requireNonEmpty(accountName, "Account name");
  const next = validatePassword(nextPassword);

  const user = await (await getDb())
    .prepare(`
      SELECT id, password_hash as passwordHash
      FROM users
      WHERE account_name = ? AND status = 'active'
    `)
    .get(normalizedAccount) as { id: string; passwordHash?: string | null } | undefined;

  if (!user || !(await verifyPassword(currentPassword, user.passwordHash)).ok) {
    throw new Error("Current password is incorrect");
  }

  const passwordHash = await hashPassword(next);
  return await withTransaction(async () => {
    (await getDb())
      .prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?")
      .run(passwordHash, nowIso(), user.id);
    await (await getDb()).prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);

    return true;
  });
}

export async function getCurrentActorRoleKeys() {
  const actor = getCurrentActor();
  return await getActorRoleKeys(actor.id, actor.status);
}

export async function getActorRoleKeys(userId: string, status = "active") {
  if (status !== "active") return [];

  return (
    await (await getDb())
      .prepare(`
        SELECT r.role_key as roleKey
        FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?
        ORDER BY r.role_key ASC
      `)
      .all(userId)
  ).map((row) => row.roleKey);
}

export async function currentActorHasAnyRole(roleKeys: string[]) {
  const currentRoleKeys = new Set(await getCurrentActorRoleKeys());
  return roleKeys.some((roleKey) => currentRoleKeys.has(roleKey));
}

async function writeAuditLog(input: {
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
  (await getDb())
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

export async function createMeeting(input: MeetingInput) {
  const database = await getDb();
  const createdAt = nowIso();
  const meetingId = newId("meeting");
  const asrResultId = newId("asr");
  const settings = await listSettings();
  const activeHotwords = await listActiveHotwordMap();
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

  const captureSessionIds = collectCaptureSessionIds(input);
  const captureSessionId = String(input.captureSessionId || captureSessionIds[0] || "").trim();
  if (captureSessionId) {
    await drainCaptureEvents(captureSessionId);
  }
  const captureSession = await getAsrCaptureSession(captureSessionId);
  const captureStats = captureSession ? getCaptureSessionStats(captureSessionId) : null;
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
        captureSessionId,
        taskId: captureSession.taskId,
        status: captureSession.status,
        asrProvider: captureSession.asrProvider,
        eventStats: captureStats
          ? {
              totalEvents: captureStats.totalEvents,
              onlineEvents: captureStats.onlineEvents,
              offlineEvents: captureStats.offlineEvents,
              finalSegmentsCount: captureStats.finalSegmentsCount,
              firstEventAt: captureStats.firstEventAt,
              lastEventAt: captureStats.lastEventAt,
            }
          : null,
        speakerIds: captureStats?.speakerIds ?? [],
        transcriptSegments,
      }
    : { captureSessionId, segments: transcriptSegments };

  const meetingResult = await withTransaction(async () => {
    await database
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

    await database
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
        captureSessionId,
        captureSession ? "gateway_raw_events_json" : "transcript_segments_json",
        JSON.stringify(rawPayload),
        normalizedText,
        createdAt
      );

    if (captureSession) {
      await database
        .prepare("DELETE FROM asr_capture_sessions WHERE capture_session_id = ?")
        .run(captureSessionId);
    }

    // feat-261101-01：把本次录音（双通道 = 2 条）绑定到会议，expires_at 置 NULL（永久）
    await bindAudioRecordingsToMeeting({ meetingId, captureSessionIds });

    const meeting = await getMeetingById(meetingId);
    await writeAuditLog({
      actionType: "meeting.create",
      resourceType: "meeting",
      resourceId: meetingId,
      resourceName: title,
      afterSnapshot: meeting
        ? {
            id: meeting.id,
            title: meeting.title,
            status: meeting.status,
            lastErrorMessage: meeting.lastErrorMessage,
            date: meeting.date,
            durationLabel: meeting.durationLabel,
          }
        : null,
    });
    return meeting;
  });

  if (captureSession) {
    releaseCaptureSession(captureSessionId);
  }
  return meetingResult;
}

export async function appendMeetingTranscript(input: {
  meetingId: string;
  captureSessionId: string;
  captureSessionIds?: string[];
  transcriptSegments: MeetingTranscriptSegment[];
}) {
  const existing = await getMeetingById(input.meetingId);
  if (!existing) return null;

  const database = await getDb();
  const createdAt = nowIso();
  const settings = await listSettings();
  const activeHotwords = await listActiveHotwordMap();
  const transcriptSegments = Array.isArray(input.transcriptSegments) ? input.transcriptSegments : [];
  const normalizedText = transcriptSegments.map((segment) => String(segment.text ?? "")).join("");
  if (!normalizedText.trim()) return existing;

  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";
  const captureSessionId = String(input.captureSessionId || "").trim();
  if (captureSessionId) {
    await drainCaptureEvents(captureSessionId);
  }
  const captureSession = await getAsrCaptureSession(captureSessionId);
  const captureStats = captureSession ? getCaptureSessionStats(captureSessionId) : null;
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
        captureSessionId,
        taskId: captureSession.taskId,
        status: captureSession.status,
        asrProvider: captureSession.asrProvider,
        eventStats: captureStats
          ? {
              totalEvents: captureStats.totalEvents,
              onlineEvents: captureStats.onlineEvents,
              offlineEvents: captureStats.offlineEvents,
              finalSegmentsCount: captureStats.finalSegmentsCount,
              firstEventAt: captureStats.firstEventAt,
              lastEventAt: captureStats.lastEventAt,
            }
          : null,
        speakerIds: captureStats?.speakerIds ?? [],
        transcriptSegments,
      }
    : { captureSessionId, segments: transcriptSegments };

  return await withTransaction(async () => {
    await database
      .prepare(`
        INSERT INTO meeting_asr_results (
          id, meeting_id, asr_provider, asr_setting_mark, asr_config_snapshot,
          capture_session_id, result_format, raw_payload, normalized_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newId("asr"),
        input.meetingId,
        captureSession?.asrProvider || get("asr", "provider") || "local_funasr",
        "checkpoint",
        JSON.stringify(asrConfigSnapshot),
        input.captureSessionId,
        captureSession ? "gateway_raw_events_json" : "transcript_segments_json",
        JSON.stringify(rawPayload),
        normalizedText,
        createdAt
      );

    await database
      .prepare("UPDATE meetings SET updated_at = ? WHERE id = ?")
      .run(createdAt, input.meetingId);

    // feat-261101-01：增量落定路径同样把录音绑定到会议（幂等，重复绑不报错）
    await bindAudioRecordingsToMeeting({
      meetingId: input.meetingId,
      captureSessionIds: collectCaptureSessionIds(input),
    });

    return await getMeetingById(input.meetingId);
  });
}

export async function updateMeetingStatus(id: string, status: string, lastErrorMessage?: string | null) {
  const updatedAt = nowIso();
  (await getDb())
    .prepare(`
      UPDATE meetings
      SET status = ?, status_updated_at = ?, last_error_message = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(status, updatedAt, lastErrorMessage ?? null, updatedAt, id);

  return await getMeetingById(id);
}

export async function updateTranscriptMeetingStatus(
  id: string,
  status: "paused" | "transcribed",
  lastErrorMessage?: string | null
) {
  const existing = await getMeetingById(id);
  if (!existing) return null;

  const allowedFrom = status === "paused"
    ? ["transcribed", "paused"]
    : ["paused"];
  if (!allowedFrom.includes(existing.status)) {
    throw new Error(`Invalid meeting status transition: ${existing.status} -> ${status}`);
  }

  return await withTransaction(async () => {
    const updatedAt = nowIso();
    const result = await (await getDb())
      .prepare(`
        UPDATE meetings
        SET status = ?, status_updated_at = ?, last_error_message = ?, updated_at = ?
        WHERE id = ? AND status IN (?, ?)
      `)
      .run(status, updatedAt, lastErrorMessage ?? null, updatedAt, id, ...allowedFrom);

    if (Number(result.changes ?? 0) === 0) {
      throw new Error(`Meeting status changed before transition: ${id}`);
    }

    const updated = await getMeetingById(id);
    await writeAuditLog({
      actionType: "meeting.status.update",
      resourceType: "meeting",
      resourceId: id,
      resourceName: updated?.title ?? existing.title,
      beforeSnapshot: {
        id: existing.id,
        title: existing.title,
        status: existing.status,
        lastErrorMessage: existing.lastErrorMessage,
      },
      afterSnapshot: updated
        ? {
            id: updated.id,
            title: updated.title,
            status: updated.status,
            lastErrorMessage: updated.lastErrorMessage,
          }
        : null,
    });
    return updated;
  });
}

export async function updateMeeting(id: string, patch: { title?: string }) {
  return await withTransaction(async () => {
    const existing = await getMeetingById(id);
    if (!existing) return null;

    const updatedAt = nowIso();
    const nextTitle = patch.title === undefined ? existing.title : requireNonEmpty(patch.title, "title");
    (await getDb())
      .prepare(`
        UPDATE meetings
        SET title = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextTitle, updatedAt, id);

    const updated = await getMeetingById(id);
    await writeAuditLog({
      actionType: "meeting.update",
      resourceType: "meeting",
      resourceId: id,
      resourceName: updated?.title ?? existing.title,
      beforeSnapshot: {
        id: existing.id,
        title: existing.title,
        status: existing.status,
      },
      afterSnapshot: updated
        ? {
            id: updated.id,
            title: updated.title,
            status: updated.status,
          }
        : null,
    });
    return updated;
  });
}

export async function deleteMeeting(id: string) {
  const { deleted, audioRows } = await withTransaction(async () => {
    const database = await getDb();
    const actor = getCurrentActor();
    const before = await getMeetingById(id);
    // 先取录音行（meetings 删除后 meeting_audio_recordings 会被 FK 级联清掉）
    const removedAudio = await listAudioRecordingsForMeeting(id);
    const result = await database
      .prepare("DELETE FROM meetings WHERE id = ? AND created_by_user_id = ?")
      .run(id, actor.id);
    const isDeleted = Number(result.changes ?? 0) > 0;
    if (isDeleted) {
      // 级联已清行；显式再删一次兜底（foreign_keys 未开时也不会留脏行）
      await deleteAudioRecordingRowsForMeeting(id);
      await writeAuditLog({
        actionType: "meeting.delete",
        resourceType: "meeting",
        resourceId: id,
        resourceName: before?.title ?? id,
        beforeSnapshot: before
          ? {
              id: before.id,
              title: before.title,
              status: before.status,
              lastErrorMessage: before.lastErrorMessage,
            }
          : null,
      });
    }
    return { deleted: isDeleted, audioRows: isDeleted ? removedAudio : [] };
  });

  // 文件删除放在事务提交之后：回滚时不会丢音频
  removeAudioFilesForRows(audioRows);
  return deleted;
}

function mapMeetingRow(row: MeetingRow & { transcript: TranscriptSegment[] }) {
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

// ---------------------------------------------------------------------------
// 会议录音（feat-261101-01 L5）：详情/列表输出 + 播放下载
// ---------------------------------------------------------------------------

// #region meeting-audio-projection
// ⚠ 本区间是「列表与详情共用」的音频投影纯函数：不 import 任何模块、不碰 DB、不读文件。
// scripts/audio-test.mjs 会按这两个标记把源码切出来（tsc 转译后在 vm 里跑）做防回归断言，
// 所以：**别把这两个标记删了/挪到别的函数上**，也别往区间里塞有副作用的代码。
// 字段白名单也在这里：磁盘路径（file_path / raw_file_path）永远不许出现在输出里。

type MeetingAudioRow = {
  id: string;
  captureSessionId: string;
  meetingId: string | null;
  filePath: string | null;
  rawFilePath: string | null;
  format: string;
  status: string;
  bytes: number;
  durationSeconds: number;
  sampleRate: number;
  bitrateKbps: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type MeetingAudioClientRow = {
  id: string;
  captureSessionId: string;
  status: string;
  format: string;
  bytes: number;
  durationSeconds: number;
  bitrateKbps: number | null;
  errorMessage: string | null;
  createdAt: string;
  downloadFileName: string;
};

function toClientAudioRow(
  row: MeetingAudioRow,
  meetingTitle: string,
  index: number,
  total: number
): MeetingAudioClientRow {
  const baseName = String(meetingTitle || "录音").trim() || "录音";
  return {
    id: row.id,
    captureSessionId: row.captureSessionId,
    status: row.status,
    format: row.format,
    bytes: row.bytes,
    durationSeconds: row.durationSeconds,
    bitrateKbps: row.bitrateKbps,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    // 双通道时带序号，避免两个下载文件同名
    downloadFileName: total > 1 ? `${baseName}-${index + 1}.mp3` : `${baseName}.mp3`,
  };
}

/**
 * 列表与详情**共用**的音频投影（R2 修 F1/F2 的口径统一点）：
 * - `audioRecordings`：白名单字段的客户端行，不含任何磁盘路径；
 * - `hasAudio`：统一口径 = **存在 `status === "ready"` 的条目**（「有没有可听的」）。
 *   历史列表曾经用 `COUNT(*) > 0`（recording 也算 true），与详情 `some(ready)` 不一致，已废弃。
 */
export function projectMeetingAudio(
  rows: MeetingAudioRow[] | null | undefined,
  meetingTitle: string
): { hasAudio: boolean; audioRecordings: MeetingAudioClientRow[] } {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const audioRecordings = list.map((row, index) => toClientAudioRow(row, meetingTitle, index, list.length));
  return {
    hasAudio: audioRecordings.some((item) => item.status === "ready"),
    audioRecordings,
  };
}
// #endregion meeting-audio-projection

export async function getMeetingAudioRecordings(meetingId: string): Promise<MeetingAudioClientRow[]>{
  if (!meetingId || !await ensureMeetingOwned(meetingId)) return [];
  const rows = await listAudioRecordingsForMeeting(meetingId) as MeetingAudioRow[];
  return projectMeetingAudio(rows, (await queryMeetingRowById(meetingId))?.title ?? "录音").audioRecordings;
}

/** 播放/下载用：属主校验后返回磁盘绝对路径 + 元信息。 */
export async function getMeetingAudioFile(input: { meetingId: string; recordingId?: string | null }) {
  const { meetingId } = input;
  if (!meetingId || !await ensureMeetingOwned(meetingId)) return null;

  const rows = await listAudioRecordingsForMeeting(meetingId) as MeetingAudioRow[];
  const readyRows = rows.filter((row) => row.status === "ready" && row.filePath);
  const recordingId = String(input.recordingId || "").trim();
  const target = recordingId
    ? readyRows.find((row) => row.id === recordingId || row.captureSessionId === recordingId)
    : readyRows[0];
  if (!target?.filePath) return null;

  let absolutePath: string;
  try {
    absolutePath = resolveStoredPath(target.filePath) as string;
  } catch (error) {
    console.error("Invalid meeting audio path:", target.filePath, error);
    return null;
  }
  if (!existsSync(absolutePath)) return null;

  const stats = statSync(absolutePath);
  if (!stats.isFile()) return null;

  const meetingTitle = (await queryMeetingRowById(meetingId))?.title ?? "录音";
  return {
    filePath: absolutePath,
    size: stats.size,
    mimeType: "audio/mpeg",
    recording: toClientAudioRow(target, meetingTitle, 0, readyRows.length),
  };
}

/**
 * 列表页用：一次 SQL 取出当前用户所有会议的音频行（避免 N+1），按 meetingId 分组。
 * 只查投影需要的列 —— `file_path` / `raw_file_path` 在 SQL 层就不查，从源头杜绝磁盘路径外泄。
 * 排序与 `listAudioRecordingsForMeeting` 一致（created_at, id），保证列表/详情下载文件名序号相同。
 */
async function listMeetingAudioRowsByMeeting(): Promise<Map<string, MeetingAudioRow[]>>{
  const actor = getCurrentActor();
  const rows = await (await getDb())
    .prepare(`
      SELECT
        r.id,
        r.capture_session_id as captureSessionId,
        r.meeting_id as meetingId,
        NULL as filePath,
        NULL as rawFilePath,
        r.format,
        r.status,
        r.bytes,
        r.duration_seconds as durationSeconds,
        r.sample_rate as sampleRate,
        r.bitrate_kbps as bitrateKbps,
        r.error_message as errorMessage,
        r.created_at as createdAt,
        r.updated_at as updatedAt,
        r.expires_at as expiresAt
      FROM meeting_audio_recordings r
      INNER JOIN meetings m ON m.id = r.meeting_id
      WHERE m.created_by_user_id = ?
      ORDER BY r.created_at ASC, r.id ASC
    `)
    .all(actor.id) as MeetingAudioRow[];

  const grouped = new Map<string, MeetingAudioRow[]>();
  for (const row of rows) {
    const meetingId = String(row.meetingId ?? "");
    if (!meetingId) continue;
    const list = grouped.get(meetingId);
    if (list) list.push(row);
    else grouped.set(meetingId, [row]);
  }
  return grouped;
}

export async function listMeetings() {
  const database = await getDb();
  const actor = getCurrentActor();
  const rows = await database
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.status,
        m.last_error_message as lastErrorMessage,
        m.source_type as sourceType,
        m.duration_seconds as durationSeconds,
        m.created_at as createdAt,
        (
          SELECT result_markdown
          FROM meeting_llm_results lr
          WHERE lr.meeting_id = m.id AND lr.status = 'succeeded' AND lr.result_type NOT IN ('translation', 'title')
          ORDER BY lr.version_no DESC, lr.created_at DESC
          LIMIT 1
        ) as summary
      FROM meetings m
      WHERE m.created_by_user_id = ?
      ORDER BY m.created_at DESC
    `)
    .all<MeetingRow>(actor.id);

  const audioByMeeting = await listMeetingAudioRowsByMeeting();

  return rows.map((row) => {
    const audio = projectMeetingAudio(audioByMeeting.get(String(row.id)) ?? [], row.title ?? "录音");
    return {
      ...mapMeetingRow({ ...row, transcript: [] }),
      hasAudio: audio.hasAudio,
      audioRecordings: audio.audioRecordings,
    };
  });
}

async function queryMeetingRowById(id: string) {
  return await (await getDb())
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.status,
        m.last_error_message as lastErrorMessage,
        m.source_type as sourceType,
        m.duration_seconds as durationSeconds,
        m.created_at as createdAt,
        (
          SELECT result_markdown
          FROM meeting_llm_results lr
          WHERE lr.meeting_id = m.id AND lr.status = 'succeeded' AND lr.result_type NOT IN ('translation', 'title')
          ORDER BY lr.version_no DESC, lr.created_at DESC
          LIMIT 1
        ) as summary
      FROM meetings m
      WHERE m.id = ?
    `)
    .get<MeetingRow>(id);
}

async function ensureMeetingOwned(id: string) {
  const actor = getCurrentActor();
  const owner = await (await getDb())
    .prepare("SELECT created_by_user_id as ownerId FROM meetings WHERE id = ?")
    .get(id) as { ownerId: string } | undefined;
  return Boolean(owner && owner.ownerId === actor.id);
}

export async function getMeetingLightById(id: string) {
  if (!await ensureMeetingOwned(id)) return null;
  const row = await queryMeetingRowById(id);
  if (!row) return null;
  const audio = projectMeetingAudio(
    await listAudioRecordingsForMeeting(id) as MeetingAudioRow[],
    row.title ?? "录音"
  );
  return {
    ...mapMeetingRow({ ...row, transcript: [] }),
    hasAudio: audio.hasAudio,
    audioRecordings: audio.audioRecordings,
  };
}

export async function getMeetingById(id: string) {
  if (!await ensureMeetingOwned(id)) return null;
  const row = await queryMeetingRowById(id);
  if (!row) return null;
  const audio = projectMeetingAudio(
    await listAudioRecordingsForMeeting(id) as MeetingAudioRow[],
    row.title ?? "录音"
  );
  return {
    ...mapMeetingRow({ ...row, transcript: await getMergedMeetingTranscriptSegments(id) }),
    hasAudio: audio.hasAudio,
    audioRecordings: audio.audioRecordings,
  };
}

async function getMeetingAsrRows(meetingId: string) {
  return await (await getDb())
    .prepare(`
      SELECT
        id,
        raw_payload as rawPayload,
        normalized_text as normalizedText,
        created_at as createdAt
      FROM meeting_asr_results
      WHERE meeting_id = ?
      ORDER BY created_at ASC, id ASC
    `)
    .all<Pick<MeetingAsrRow, "id" | "rawPayload" | "normalizedText" | "createdAt">>(meetingId);
}

function parseTranscriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isRecord).map((segment, index) => ({
    id: String(segment.id ?? `segment-${index}`),
    speaker: String(segment.speaker ?? ""),
    speakerId: typeof segment.speakerId === "number" ? segment.speakerId : null,
    source: segment.source === "speaker" ? "speaker" : segment.source === "mic" ? "mic" : undefined,
    deviceId: typeof segment.deviceId === "string" && segment.deviceId ? segment.deviceId : undefined,
    text: String(segment.text ?? ""),
    time: String(segment.time ?? ""),
    timeSeconds: Number.isFinite(Number(segment.timeSeconds)) ? Number(segment.timeSeconds) : 0,
    isFinal: Boolean(segment.isFinal),
  }));
}

async function getMergedMeetingTranscriptSegments(meetingId: string) {
  return (await getMeetingAsrRows(meetingId)).flatMap((row) => {
    const payload = parseJsonOr<JsonRecord>(row.rawPayload, {});
    const segments = parseTranscriptSegments(payload.transcriptSegments ?? payload.segments);

    if (segments.length > 0) return segments;
    const normalizedText = row.normalizedText ?? "";
    if (!normalizedText.trim()) return [];
    return [{
      id: `${row.id}-text`,
      speaker: "",
      text: normalizedText,
      time: "",
      timeSeconds: 0,
      isFinal: true,
    }];
  });
}

async function getMergedMeetingTranscript(meetingId: string) {
  return (await getMeetingAsrRows(meetingId))
    .map((row) => String(row.normalizedText || "").trim())
    .filter(Boolean)
    .join("\n");
}

async function listMeetingLlmResultsByMeetingId(meetingId: string) {
  const database = await getDb();
  return await database
    .prepare(`
      SELECT
        id,
        meeting_id as meetingId,
        input_transcript_snapshot as inputTranscriptSnapshot,
        llm_setting_mark as llmSettingMark,
        prompt_template_id as promptTemplateId,
        generation_config_snapshot as generationConfigSnapshot,
        generation_mode as generationMode,
        status,
        version_no as versionNo,
        result_type as resultType,
        result_title as resultTitle,
        result_markdown as resultMarkdown,
        error_message as errorMessage,
        created_at as createdAt
      FROM meeting_llm_results
      WHERE meeting_id = ? AND result_type <> 'title'
      ORDER BY version_no DESC, created_at DESC
    `)
    .all<MeetingLlmResultRow>(meetingId);
}

export async function listMeetingAsrResults(meetingId: string) {
  if (!await ensureMeetingOwned(meetingId)) return null;
  return await (await getDb())
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
    .all<MeetingAsrSummaryRow>(meetingId);
}

export async function getMeetingAsrResultDetail(meetingId: string, resultId: string) {
  if (!await ensureMeetingOwned(meetingId)) return null;
  const row = await (await getDb())
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
    .get<MeetingAsrRow>(meetingId, resultId);

  if (!row) return null;

  return {
    ...row,
    asrConfigSnapshot: redactAsrConfigSnapshot(parseJsonOr<JsonRecord>(row.asrConfigSnapshot, {})),
    rawPayload: parseJsonOr<unknown>(row.rawPayload, row.rawPayload),
  };
}

export async function listMeetingLlmResultSummaries(meetingId: string) {
  if (!await ensureMeetingOwned(meetingId)) return null;
  return await (await getDb())
    .prepare(`
      SELECT
        id,
        meeting_id as meetingId,
        prompt_template_id as promptTemplateId,
        generation_mode as generationMode,
        status,
        version_no as versionNo,
        result_type as resultType,
        result_title as resultTitle,
        generation_config_snapshot as generationConfigSnapshot,
        error_message as errorMessage,
        created_at as createdAt
      FROM meeting_llm_results
      WHERE meeting_id = ? AND result_type <> 'title'
      ORDER BY version_no DESC, created_at DESC
    `)
    .all<Pick<MeetingLlmResultRow, "id" | "meetingId" | "promptTemplateId" | "generationMode" | "status" | "versionNo" | "resultType" | "resultTitle" | "generationConfigSnapshot" | "errorMessage" | "createdAt">>(meetingId);
}

export async function getMeetingLlmResultDetail(meetingId: string, resultId: string) {
  if (!await ensureMeetingOwned(meetingId)) return null;
  return await (await getDb())
    .prepare(`
      SELECT
        id,
        meeting_id as meetingId,
        prompt_template_id as promptTemplateId,
        generation_mode as generationMode,
        status,
        version_no as versionNo,
        result_type as resultType,
        result_title as resultTitle,
        result_markdown as resultMarkdown,
        error_message as errorMessage,
        created_at as createdAt
      FROM meeting_llm_results
      WHERE meeting_id = ? AND id = ?
    `)
    .get<Pick<MeetingLlmResultRow, "id" | "meetingId" | "promptTemplateId" | "generationMode" | "status" | "versionNo" | "resultType" | "resultTitle" | "resultMarkdown" | "errorMessage" | "createdAt">>(meetingId, resultId) ?? null;
}

function truncateUtf16(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
  return cut;
}

function stripLeadingThinking(content: string): string {
  let cleaned = content.replace(/^\s+/, "");
  const closeTag = /<\/think\s*>/gi;
  let lastClose = -1;
  let lastCloseLen = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = closeTag.exec(cleaned)) !== null) {
    lastClose = tagMatch.index;
    lastCloseLen = tagMatch[0].length;
  }
  if (lastClose >= 0) {
    cleaned = cleaned.slice(lastClose + lastCloseLen).replace(/^\s+/, "");
  }
  cleaned = cleaned.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  cleaned = cleaned.replace(/^(<\/?think\s*>?\s*)+/i, "");
  cleaned = cleaned.replace(/^(?:<thinking>[\s\S]*?<\/thinking>|<reasoning>[\s\S]*?<\/reasoning>)\s*/i, "");
  cleaned = cleaned.replace(/^\[[\s\S]*?\](?:\s*\n|$)/, (match) => {
    const block = match.slice(0, match.lastIndexOf("]") + 1);
    return block.includes("\n") || block.trim() === cleaned.trim() ? "" : match;
  });
  return cleaned;
}

function llmRequest(
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  }
): Promise<{ status: number; text: string; headersAt: number; bodyAt: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const startedAt = Date.now();

    const req = transport(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : isHttps ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const headersAt = Date.now();
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            headersAt,
            bodyAt: Date.now(),
          });
        });
        res.on("error", (err) => reject(new Error(`LLM response read failed: ${err.message}`, { cause: err })));
      }
    );

    req.on("error", (err) => reject(new Error(`LLM network error: ${err.message}`, { cause: err })));

    const onAbort = () => {
      req.destroy();
      const abortError = new Error(`This operation was aborted after ${Date.now() - startedAt}ms`);
      abortError.name = "AbortError";
      reject(abortError);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    req.write(options.body);
    req.end();
  });
}

type LlmTransport = typeof llmRequest;

/**
 * LLM 传输层注入口（feat-261101-04 / #44）。
 *
 * 默认真实 `llmRequest`（原生 http/https）；`scripts/ai-title-test.mjs` 用它在
 * 不联网、不写死模型名/API key 的前提下跑完整链路（真实 sqlite + 真实队列 + 真实记账）。
 * 传 `null` 恢复真实传输。**除测试外不要调用。**
 */
export function setLlmTransport(transport: LlmTransport | null) {
  llmTransport = transport ?? llmRequest;
}

let llmTransport: LlmTransport = llmRequest;

export async function claimMeetingLlmGeneration(meetingId: string):
  Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const database = await getDb();
  const owner = await database
    .prepare("SELECT created_by_user_id as ownerId FROM meetings WHERE id = ?")
    .get(meetingId) as { ownerId: string } | undefined;
  if (!owner || owner.ownerId !== getCurrentActor().id) {
    return { ok: false, status: 404, error: "Meeting not found" };
  }

  const claim = await database
    .prepare(`
      UPDATE meetings
      SET status = 'llm_processing', status_updated_at = ?, last_error_message = NULL, updated_at = ?
      WHERE id = ? AND status <> 'llm_processing'
    `)
    .run(nowIso(), nowIso(), meetingId);
  if (Number(claim.changes ?? 0) === 0) {
    return { ok: false, status: 409, error: "LLM generation already in progress" };
  }
  return { ok: true };
}

export async function createMeetingLlmResult(meetingId: string, templateId?: string, options?: { skipClaim?: boolean; targetLang?: string }) {
  try {
    return await llmQueue.enqueue("summary", () => createMeetingLlmResultInner(meetingId, templateId, options));
  } catch (error) {
    if (
      options?.skipClaim &&
      error instanceof Error &&
      error.message.includes("LLM queue")
    ) {
      await updateMeetingStatus(meetingId, "llm_failed", `LLM queue busy: ${error.message}`);
    }
    throw error;
  }
}

const TRANSLATE_BATCH_MAX_SENTENCES = 5;
const TRANSLATE_BATCH_MAX_CHARS = 1000;

async function translateMeetingFlow(
  meetingId: string,
  template: PromptTemplateRow,
  inputTranscriptSnapshot: string,
  targetLang: string | undefined
) {
  const lang = targetLang || "en";
  const segments = (await getMergedMeetingTranscriptSegments(meetingId))
    .filter((segment) => segment.isFinal && Boolean(segment.text.trim()))
    .map((segment) => segment.text.trim());
  const existing = await listMeetingLlmResultsByMeetingId(meetingId);
  const startedAt = Date.now();
  const snapshot = JSON.stringify({
    targetLang: lang,
    source: "manual",
    batchMaxSentences: TRANSLATE_BATCH_MAX_SENTENCES,
    batchMaxChars: TRANSLATE_BATCH_MAX_CHARS,
  });

  try {
    if (segments.length === 0) {
      throw new Error("Meeting has no final transcript segments to translate");
    }

    const batches: string[][] = [];
    let current: string[] = [];
    let currentChars = 0;
    for (const text of segments) {
      if (current.length >= TRANSLATE_BATCH_MAX_SENTENCES || currentChars + text.length > TRANSLATE_BATCH_MAX_CHARS) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(text);
      currentChars += text.length;
    }
    if (current.length > 0) batches.push(current);

    // 批内串行直连 LLM，不再经队列嵌套入队（外层 summary 槽已保证整个翻译任务并发=1；
    // 嵌套入队会在多任务并发时因槽位被外层占用导致 30s 排队超时，任务必失败）
    const translations: string[] = [];
    for (const batch of batches) {
      translations.push((await translateSentences(batch, lang)).text);
    }
    const resultMarkdown = translations.join("\n\n");
    if (!resultMarkdown.trim()) {
      throw new Error("LLM returned empty translation result");
    }

    await withTransaction(async () => {
      const row: MeetingLlmResultRow = {
        id: newId("llm"),
        meetingId,
        inputTranscriptSnapshot,
        llmSettingMark: "current",
        promptTemplateId: template.id,
        generationConfigSnapshot: snapshot,
        generationMode: existing.length > 0 ? "manual_regenerate" : "default_auto",
        status: "succeeded",
        versionNo: await getNextLlmVersionNo(meetingId),
        resultType: "translation",
        resultTitle: template.templateName,
        rawPrompt: inputTranscriptSnapshot.slice(0, 4000),
        rawResponse: resultMarkdown,
        resultMarkdown,
        errorMessage: null,
      };
      await insertMeetingLlmResult(row);
      await updateMeetingStatus(meetingId, "generated");
      await writeAuditLog({
        actionType: "llm.translate",
        resourceType: "meeting_llm_result",
        resourceId: row.id,
        resourceName: row.resultTitle,
        afterSnapshot: {
          meetingId,
          promptTemplateId: row.promptTemplateId,
          versionNo: row.versionNo,
          status: row.status,
          targetLang: lang,
        },
      });
    });
    console.log(
      `[LLM] translate: meeting=${meetingId} lang=${lang} segments=${segments.length} batches=${batches.length} elapsed=${Date.now() - startedAt}ms`
    );
    return resultMarkdown;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const errorMessage = `Translation failed: ${error instanceof Error ? error.message : String(error)} (elapsed=${elapsedMs}ms)`;
    console.error(`[LLM] translate failed: meeting=${meetingId} error=${errorMessage}`);
    await withTransaction(async () => {
      const row: MeetingLlmResultRow = {
        id: newId("llm"),
        meetingId,
        inputTranscriptSnapshot,
        llmSettingMark: "current",
        promptTemplateId: template.id,
        generationConfigSnapshot: snapshot,
        generationMode: existing.length > 0 ? "manual_regenerate" : "default_auto",
        status: "failed",
        versionNo: await getNextLlmVersionNo(meetingId),
        resultType: "translation",
        resultTitle: template.templateName,
        rawPrompt: inputTranscriptSnapshot.slice(0, 4000),
        rawResponse: "",
        resultMarkdown: "",
        errorMessage,
      };
      await insertMeetingLlmResult(row);
      await updateMeetingStatus(meetingId, "llm_failed", errorMessage);
      await writeAuditLog({
        actionType: "llm.translate",
        resourceType: "meeting_llm_result",
        resourceId: row.id,
        resourceName: row.resultTitle,
        result: "failed",
        errorMessage,
        afterSnapshot: {
          meetingId,
          promptTemplateId: row.promptTemplateId,
          versionNo: row.versionNo,
          status: row.status,
          targetLang: lang,
        },
      });
    });
    throw error;
  }
}

export async function persistLiveTranslation(
  meetingId: string,
  targetLang: string,
  blocks: Array<{ time: string; timeSeconds: number; text: string }>
) {
  const textBlocks = blocks
    .map((block) => String(block.text ?? "").trim())
    .filter(Boolean);
  if (textBlocks.length === 0) return null;
  if (!await ensureMeetingOwned(meetingId)) return null;

  const segments = (await getMergedMeetingTranscriptSegments(meetingId))
    .filter((segment) => segment.isFinal && Boolean(segment.text.trim()))
    .map((segment) => segment.text.trim())
    .join("\n");

  return await withTransaction(async () => {
    const existing = await listMeetingLlmResultsByMeetingId(meetingId);
    const resultMarkdown = textBlocks.join("\n\n");
    const row: MeetingLlmResultRow = {
      id: newId("llm"),
      meetingId,
      inputTranscriptSnapshot: segments,
      llmSettingMark: "current",
      promptTemplateId: "tpl-translate",
      generationConfigSnapshot: JSON.stringify({ targetLang: targetLang || "en", source: "live" }),
      generationMode: "default_auto",
      status: "succeeded",
      versionNo: await getNextLlmVersionNo(meetingId),
      resultType: "translation",
      resultTitle: "会议翻译",
      rawPrompt: "",
      rawResponse: resultMarkdown,
      resultMarkdown,
      errorMessage: null,
    };
    await insertMeetingLlmResult(row);
    await writeAuditLog({
      actionType: "llm.translate",
      resourceType: "meeting_llm_result",
      resourceId: row.id,
      resourceName: row.resultTitle,
      afterSnapshot: {
        meetingId,
        versionNo: row.versionNo,
        status: row.status,
        source: "live",
        targetLang: targetLang || "en",
        blockCount: textBlocks.length,
        existingResults: existing.length,
      },
    });
    return row;
  });
}

async function createMeetingLlmResultInner(meetingId: string, templateId?: string, options?: { skipClaim?: boolean; targetLang?: string }) {
  if (!await ensureMeetingOwned(meetingId)) throw new Error("Meeting not found");

  if (!options?.skipClaim) {
    const claim = await claimMeetingLlmGeneration(meetingId);
    if (!claim.ok) throw new Error(claim.error);
  }

  const inputTranscriptSnapshot = await getMergedMeetingTranscript(meetingId);
  if (!inputTranscriptSnapshot) {
    await updateMeetingStatus(meetingId, "llm_failed", "Meeting ASR transcript not found");
    throw new Error("Meeting ASR transcript not found");
  }

  const settings = await listSettings();
  const templates = await listPromptTemplates();
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const selectedTemplateId = templateId || get("system", "default_prompt_template_id");
  const template = templates.find((item) => item.id === selectedTemplateId);
  if (!template) {
    await updateMeetingStatus(meetingId, "llm_failed", "Prompt template not found");
    throw new Error("Prompt template not found");
  }

  if (template.templateType === "translation") {
    return await translateMeetingFlow(meetingId, template, inputTranscriptSnapshot, options?.targetLang);
  }

  const baseUrl = get("llm", "base_url");
  const apiKey = get("llm", "api_key");
  const model = get("llm", "model");

  if (!baseUrl || !model) {
    await updateMeetingStatus(meetingId, "llm_failed", "LLM config incomplete");
    throw new Error("LLM config incomplete");
  }

  const existing = await listMeetingLlmResultsByMeetingId(meetingId);
  const rawPrompt = String(template.content || "").replaceAll("{transcript}", inputTranscriptSnapshot);
  const contextSize = Number(String(get("llm", "context_size") || "").trim()) || 0;
  const maxTokens = Number(String(get("llm", "max_tokens") || "").trim()) || 0;
  const timeoutMs = Number(String(get("llm", "timeout_ms") || "").trim()) || 300000;
  const prompt = contextSize > 0 && rawPrompt.length > contextSize ? truncateUtf16(rawPrompt, contextSize) : rawPrompt;
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;

  let llmFinishReason: string | null = null;
  let resultMarkdown = "";
  let rawText = "";
  let reasoningChars = 0;
  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    console.log(
      `[LLM] generate: meeting=${meetingId} model=${model} url=${baseUrl} promptChars=${prompt.length} maxTokens=${maxTokens > 0 ? maxTokens : "auto"} contextSize=${contextSize > 0 ? contextSize : "full"} timeoutMs=${timeoutMs} stream=false`
    );

    try {
      const { status, text, headersAt, bodyAt } = await llmRequest(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "你是一个专业的会议纪要整理助手。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          ...buildDisableThinkingParams(),
        }),
        signal: controller.signal,
      });

      console.log(`[LLM] headers: status=${status} elapsed=${headersAt - startedAt}ms`);

      if (status < 200 || status >= 300) {
        throw new Error(`LLM API error: ${status} ${text.slice(0, 2000)}`);
      }

      rawText = text;
      console.log(
        `[LLM] body: elapsed=${bodyAt - headersAt}ms rawLength=${rawText.length} total=${bodyAt - startedAt}ms`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!rawText.trim()) {
      throw new Error(`LLM returned empty body (raw=${rawText.slice(0, 500)})`);
    }

    let parsedJson: { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string | null }> };
    try {
      parsedJson = JSON.parse(rawText) as typeof parsedJson;
    } catch (parseError) {
      throw new Error(
        `LLM returned non-JSON body (${String(parseError).slice(0, 200)} raw=${rawText.slice(0, 500)})`
      );
    }
    const choice = parsedJson.choices?.[0];
    const message = choice?.message;
    llmFinishReason = choice?.finish_reason ?? null;
    resultMarkdown = stripLeadingThinking(String(message?.content ?? "").trim());
    reasoningChars = String(message?.reasoning_content ?? "").length;
    console.log(
      `[LLM] parsed: finishReason=${llmFinishReason ?? "N/A"} contentChars=${String(resultMarkdown).length} reasoningChars=${reasoningChars}`
    );

    if (!String(resultMarkdown).trim()) {
      throw new Error(
        `LLM returned empty result (finishReason=${llmFinishReason ?? "N/A"} raw=${rawText.slice(0, 2000)})`
      );
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const errorCause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const causeInfo =
      errorCause instanceof Error
        ? ` (${(errorCause as { code?: string }).code ?? errorCause.name}: ${errorCause.message})`
        : "";
    const baseMessage = isTimeout
      ? `LLM timeout after ${timeoutMs}ms`
      : error instanceof Error
        ? `${error.message}${causeInfo}`
        : "LLM generation failed";
    const errorMessage = `${baseMessage} (elapsed=${elapsedMs}ms)`;
    console.error(
      `[LLM] failed: meeting=${meetingId} error=${errorMessage}`
    );
    await withTransaction(async () => {
      const versionNo = await getNextLlmVersionNo(meetingId);
      await insertMeetingLlmResult({
        id: newId("llm"),
        meetingId,
        inputTranscriptSnapshot,
        llmSettingMark: "current",
        promptTemplateId: template.id,
        generationConfigSnapshot: JSON.stringify({ baseUrl, model, contextSize, maxTokens, timeoutMs }),
        generationMode: existing.length > 0 ? "manual_regenerate" : "default_auto",
        status: "failed",
        versionNo,
        resultType: template.templateType || "custom",
        resultTitle: template.templateName,
        rawPrompt: prompt,
        rawResponse: rawText ? rawText.slice(0, 4000) : "",
        resultMarkdown: "",
        errorMessage,
      });
      await updateMeetingStatus(meetingId, "llm_failed", errorMessage);
      await writeAuditLog({
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
    });
    throw error;
  }
  await withTransaction(async () => {
    const row: MeetingLlmResultRow = {
      id: newId("llm"),
      meetingId,
      inputTranscriptSnapshot,
      llmSettingMark: "current",
      promptTemplateId: template.id,
      generationConfigSnapshot: JSON.stringify({ baseUrl, model, contextSize, maxTokens, timeoutMs }),
      generationMode: existing.length > 0 ? "manual_regenerate" : "default_auto",
      status: "succeeded",
      versionNo: await getNextLlmVersionNo(meetingId),
      resultType: template.templateType || "custom",
      resultTitle: template.templateName,
      rawPrompt: prompt,
      rawResponse: rawText.slice(0, 8000),
      resultMarkdown,
      errorMessage:
        llmFinishReason === "length"
          ? "结果可能不完整（finish_reason=length，输出被截断）"
          : null,
    };
    await insertMeetingLlmResult(row);
    await updateMeetingStatus(meetingId, "generated");
    await writeAuditLog({
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
  });

  return (await listMeetingLlmResultsByMeetingId(meetingId))[0];
}

async function getNextLlmVersionNo(meetingId: string) {
  const row = await (await getDb())
    .prepare(`
      SELECT COALESCE(MAX(version_no), 0) + 1 as nextVersionNo
      FROM meeting_llm_results
      WHERE meeting_id = ?
    `)
    .get(meetingId) as { nextVersionNo?: number } | undefined;

  return Number(row?.nextVersionNo ?? 1);
}

async function insertMeetingLlmResult(row: MeetingLlmResultRow) {
  (await getDb())
    .prepare(`
      INSERT INTO meeting_llm_results (
        id, meeting_id, input_transcript_snapshot, llm_setting_mark, prompt_template_id,
        generation_config_snapshot, generation_mode, status, version_no,
        result_type, result_title, raw_prompt, raw_response, result_markdown,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.id,
      row.meetingId,
      row.inputTranscriptSnapshot,
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

// ---------------------------------------------------------------------------
// 会议 AI 标题（feat-261101-04 / GitHub #44）
//
// 链路：POST /api/meetings/[id]/ai-title → generateMeetingTitle
//   → llmQueue.enqueue("title") → 取正文 → 窗口截断 → llmTransport（默认真实 http）
//   → 清洗 → **同一个事务**内：UPDATE meetings.title + 插 meeting_llm_results 行 + 审计
//
// 设计取舍（见 docs/design/ai-title.md）：
//   * 不走 `claimMeetingLlmGeneration`：那会把会议状态推到 `llm_processing`，
//     而改标题不属于转写/生成生命周期，会跟「生成纪要」抢状态、在列表里闪「生成中」；
//     并发点击的要求是「后者覆盖前者」，claim 反而会 409 把后者拒掉。
//   * 失败不改标题、只落一条 status=failed 的记账行 + 审计（无半更新状态）。
// ---------------------------------------------------------------------------

export type MeetingTitleGeneration = {
  title: string;
  previousTitle: string;
  llmResultId: string;
  /** 与列表/详情**同一个投影函数**产出的会议对象（前端拿它同时更新列表行与详情） */
  meeting: Awaited<ReturnType<typeof getMeetingLightById>>;
  promptChars: number;
  transcriptChars: number;
  sentChars: number;
  truncated: boolean;
};

export async function generateMeetingTitle(meetingId: string): Promise<MeetingTitleGeneration> {
  // 沿用既有 llm 队列（并发上限/容量/排队超时都在队列里），任务类型 "title"
  return llmQueue.enqueue("title", () => generateMeetingTitleInner(meetingId));
}

async function generateMeetingTitleInner(meetingId: string): Promise<MeetingTitleGeneration> {
  if (!await ensureMeetingOwned(meetingId)) {
    throw new AiTitleError("Meeting not found", 404);
  }

  const previousTitle = String((await queryMeetingRowById(meetingId))?.title ?? "").trim() || TITLE_FALLBACK_TITLE;
  const transcript = await getMergedMeetingTranscript(meetingId);
  if (!transcript.trim()) {
    throw new AiTitleError("会议还没有转写内容，无法生成标题", 409);
  }

  const settings = await listSettings();
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const baseUrl = get("llm", "base_url");
  const apiKey = get("llm", "api_key");
  const model = get("llm", "model");
  if (!baseUrl || !model) {
    throw new AiTitleError("LLM config incomplete", 500);
  }

  // 模板可能被用户改过 → 优先用库里的。
  // 若库里根本没有标题模板（老库种子没跑到 / 被删），运行期再补一次：
  // `ensureTitleTemplate` 幂等（已有就不覆盖），而 `meeting_llm_results.prompt_template_id`
  // 是 NOT NULL + 外键，记账行必须有真实模板 id 才能落库。
  const findTitleTemplate = async () =>
    (await listPromptTemplates()).find(
      (item) => item.templateKey === TITLE_TEMPLATE_KEY || item.id === TITLE_TEMPLATE_ID
    );
  let template = await findTitleTemplate();
  if (!template) {
    await ensureTitleTemplate(await getDb(), nowIso());
    template = await findTitleTemplate();
  }
  const built = buildTitlePrompt(template?.content || TITLE_TEMPLATE_CONTENT, transcript);
  const maxTokens = Number(String(get("llm", "max_tokens") || "").trim()) || 0;
  const timeoutMs = Number(String(get("llm", "timeout_ms") || "").trim()) || 120_000;
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
  const startedAt = Date.now();
  // 记账快照（与纪要同一个口径：baseUrl/model/参数；**不含 api_key**）
  const generationConfigSnapshot = JSON.stringify({
    source: "ai_title",
    baseUrl,
    model,
    maxTokens,
    timeoutMs,
    templateId: template?.id ?? null,
    transcriptChars: built.totalChars,
    sentChars: built.sentChars,
    truncated: built.truncated,
  });

  let rawText = "";
  let title = "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: { status: number; text: string };
    try {
      response = await llmTransport(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "你是一个专业的会议标题助手。" },
            { role: "user", content: built.prompt },
          ],
          temperature: 0.3,
          ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          ...buildDisableThinkingParams(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    console.log(
      `[LLM] title: meeting=${meetingId} status=${response.status} transcriptChars=${built.totalChars} ` +
        `sentChars=${built.sentChars} truncated=${built.truncated} elapsed=${Date.now() - startedAt}ms`
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`LLM API error: ${response.status} ${String(response.text ?? "").slice(0, 500)}`);
    }

    rawText = String(response.text ?? "");
    if (!rawText.trim()) {
      throw new Error("LLM returned empty body");
    }

    let parsed: { choices?: Array<{ message?: Record<string, unknown> }> };
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch (parseError) {
      throw new Error(`LLM returned non-JSON body (${String(parseError).slice(0, 200)})`);
    }

    const content = stripLeadingThinking(String(parsed.choices?.[0]?.message?.content ?? "").trim());
    if (!content.trim()) {
      throw new Error("LLM returned empty title");
    }
    // 清洗是硬要求：引号/换行/首尾标点/超长/空 都在 sanitizeMeetingTitle 里收口，
    // 空兜底用会议原名（绝不允许把会议名改成空串）。
    title = sanitizeMeetingTitle(content, previousTitle);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const baseMessage = isTimeout
      ? `LLM timeout after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : "LLM title generation failed";
    const errorMessage = `${baseMessage} (elapsed=${elapsedMs}ms)`;
    console.error(`[LLM] title failed: meeting=${meetingId} error=${errorMessage}`);

    await withTransaction(async () => {
      const row: MeetingLlmResultRow = {
        id: newId("llm"),
        meetingId,
        inputTranscriptSnapshot: transcript,
        llmSettingMark: "current",
        promptTemplateId: template?.id ?? TITLE_TEMPLATE_ID,
        generationConfigSnapshot,
        generationMode: "manual_regenerate",
        status: "failed",
        versionNo: await getNextLlmVersionNo(meetingId),
        resultType: TITLE_RESULT_TYPE,
        resultTitle: previousTitle,
        rawPrompt: built.prompt,
        rawResponse: rawText.slice(0, 4000),
        resultMarkdown: "",
        errorMessage,
      };
      await insertMeetingLlmResult(row);
      await writeAuditLog({
        actionType: "llm.title",
        resourceType: "meeting",
        resourceId: meetingId,
        resourceName: previousTitle,
        result: "failed",
        errorMessage,
        afterSnapshot: {
          llmResultId: row.id,
          versionNo: row.versionNo,
          status: "failed",
          transcriptChars: built.totalChars,
          sentChars: built.sentChars,
          truncated: built.truncated,
        },
      });
    });

    if (error instanceof AiTitleError) throw error;
    throw new AiTitleError(errorMessage, 502);
  }

  return await withTransaction(async () => {
    const database = await getDb();
    const updatedAt = nowIso();
    // 改名 + 记账在同一个事务里：要么都生效、要么都不发生（不留半更新状态）。
    // 并发点击时 title 是单条 UPDATE，天然原子，后者覆盖前者。
    await database
      .prepare("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, updatedAt, meetingId);

    const row: MeetingLlmResultRow = {
      id: newId("llm"),
      meetingId,
      inputTranscriptSnapshot: transcript,
      llmSettingMark: "current",
      promptTemplateId: template?.id ?? TITLE_TEMPLATE_ID,
      generationConfigSnapshot,
      generationMode: "manual_regenerate",
      status: "succeeded",
      versionNo: await getNextLlmVersionNo(meetingId),
      resultType: TITLE_RESULT_TYPE,
      resultTitle: title,
      rawPrompt: built.prompt,
      rawResponse: rawText.slice(0, 4000),
      resultMarkdown: title,
      errorMessage: null,
    };
    await insertMeetingLlmResult(row);

    await writeAuditLog({
      actionType: "llm.title",
      resourceType: "meeting",
      resourceId: meetingId,
      resourceName: title,
      beforeSnapshot: { title: previousTitle },
      afterSnapshot: {
        llmResultId: row.id,
        versionNo: row.versionNo,
        title,
        status: "succeeded",
        transcriptChars: built.totalChars,
        sentChars: built.sentChars,
        truncated: built.truncated,
      },
    });

    // 返回**与列表/详情同一个投影函数**的会议对象（#43 R2 教训：两处不能各拼一套）
    const meeting = await getMeetingLightById(meetingId);
    return {
      title,
      previousTitle,
      llmResultId: row.id,
      meeting,
      promptChars: built.prompt.length,
      transcriptChars: built.totalChars,
      sentChars: built.sentChars,
      truncated: built.truncated,
    };
  });
}

export async function updateMeetingLlmResult(meetingId: string, id: string, patch: { resultMarkdown?: string; resultTitle?: string }) {
  return await withTransaction(async () => {
    if (!await ensureMeetingOwned(meetingId)) return null;
    const existing = await getMeetingLlmResultById(id);
    if (!existing) return null;
    if (!await meetingLlmResultBelongsToMeeting(id, meetingId)) {
      throw new Error("Meeting LLM result does not belong to this meeting");
    }

    const database = await getDb();
    await database
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

    const updated = await getMeetingLlmResultById(id);
    await writeAuditLog({
      actionType: "llm_result.update",
      resourceType: "meeting_llm_result",
      resourceId: id,
      resourceName: updated?.resultTitle ?? existing.resultTitle,
      beforeSnapshot: {
        resultTitle: existing.resultTitle,
      },
      afterSnapshot: {
        meetingId,
        resultTitle: updated?.resultTitle,
      },
    });
    return updated;
  });
}

export async function deleteMeetingLlmResult(meetingId: string, id: string) {
  return await withTransaction(async () => {
    if (!await ensureMeetingOwned(meetingId)) return null;
    const existing = await getMeetingLlmResultById(id);
    if (!existing) return false;
    if (!await meetingLlmResultBelongsToMeeting(id, meetingId)) {
      throw new Error("Meeting LLM result does not belong to this meeting");
    }

    const database = await getDb();
    await database.prepare("DELETE FROM meeting_send_records WHERE meeting_llm_result_id = ?").run(id);
    const result = await database.prepare("DELETE FROM meeting_llm_results WHERE id = ?").run(id);
    const deleted = Number(result.changes ?? 0) > 0;
    if (deleted) {
      await writeAuditLog({
        actionType: "llm_result.delete",
        resourceType: "meeting_llm_result",
        resourceId: id,
        resourceName: existing.resultTitle,
        beforeSnapshot: {
          meetingId,
          resultTitle: existing.resultTitle,
          resultMarkdown: existing.resultMarkdown,
        },
      });
    }
    return deleted;
  });
}

async function getMeetingLlmResultById(id: string) {
  const database = await getDb();
  return database
    .prepare<MeetingLlmResultRow>(`
      SELECT
        id,
        meeting_id as meetingId,
        input_transcript_snapshot as inputTranscriptSnapshot,
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
    .get<MeetingLlmResultRow>(id);
}

async function meetingLlmResultBelongsToMeeting(llmResultId: string, meetingId: string) {
  const row = await (await getDb())
    .prepare(`
      SELECT lr.id
      FROM meeting_llm_results lr
      WHERE lr.id = ? AND lr.meeting_id = ?
    `)
    .get(llmResultId, meetingId);

  return Boolean(row);
}

function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJsonOr<unknown>(value, []);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

export async function listMeetingSendRecords(meetingId: string) {
  if (!await ensureMeetingOwned(meetingId)) return null;
  const database = await getDb();
  return await database
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
      WHERE lr.meeting_id = ?
      ORDER BY sr.created_at DESC
    `)
    .all<MeetingSendRecordRow>(meetingId)
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        toRecipients: parseStringArray(row.toRecipientsJson),
        ccRecipients: parseStringArray(row.ccRecipientsJson),
      }))
    );
}

export async function createMeetingSendRecord(input: {
  meetingId: string;
  meetingLlmResultId: string;
  subject: string;
  toRecipients: string[];
  ccRecipients: string[];
  mailTemplateType?: string;
}) {
  const llmResult = await getMeetingLlmResultById(input.meetingLlmResultId);
  if (!llmResult) {
    throw new Error("Meeting LLM result not found");
  }
  if (!await ensureMeetingOwned(input.meetingId)) {
    throw new Error("Meeting LLM result does not belong to this meeting");
  }
  if (!await meetingLlmResultBelongsToMeeting(input.meetingLlmResultId, input.meetingId)) {
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

  const settings = await listSettings();
  const get = (section: string, mark: string) =>
    settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? "";

  const allowedDomains = get("mail", "allowed_domains")
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

  if (allowedDomains.length > 0) {
    const recipientsToCheck = [...toRecipients, ...ccRecipients];
    const domainOf = (email: string) => {
      const at = email.lastIndexOf("@");
      return at > -1 ? email.slice(at + 1).toLowerCase() : "";
    };
    const disallowed = recipientsToCheck.filter((email) => !allowedDomains.includes(domainOf(email)));
    if (disallowed.length > 0) {
      throw new Error(`邮件收件人不在允许的域名范围内，已阻止发送: ${disallowed.join(", ")}`);
    }
  }

  const host = get("mail", "smtp_host");
  const port = Number(get("mail", "smtp_port") || "465");
  const secure = get("mail", "smtp_secure") !== "0";
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

    await updateMeetingStatus(input.meetingId, "sending");
    const nodemailer = (eval("require") as NodeRequire)("nodemailer") as {
      createTransport: (options: Record<string, unknown>) => {
        sendMail: (message: Record<string, unknown>) => Promise<{ messageId?: string }>;
      };
    };
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
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
    await withTransaction(async () => {
      await insertMeetingSendRecord({
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
      await updateMeetingStatus(input.meetingId, "send_failed", errorMessage);
      await writeAuditLog({
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

  await withTransaction(async () => {
    await insertMeetingSendRecord(row, nowIso());
    await updateMeetingStatus(input.meetingId, "sent");
    await writeAuditLog({
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
  });

  return (await listMeetingSendRecords(input.meetingId))?.[0] ?? null;
}

async function insertMeetingSendRecord(row: MeetingSendRecordRow, sentAt: string | null) {
  (await getDb())
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
