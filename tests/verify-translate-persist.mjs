// 翻译持久化与历史再次翻译验证（round05）
// 前提：dev server 已启动（端口 3123），加载了新代码
// 用法：node tests/verify-translate-persist.mjs
// 说明：直接读写本地 SQLite 插入临时用户，验证后清理；仅限本地开发库
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3123";
const DB_PATH = join(process.cwd(), "data", "meeting-asr-app.db");
const TEST_PASSWORD = "verifypass123";
const USER_ACCOUNT = "verify_persist_user";
const USER_ID = "user-verify-persist";

async function jf(path, { method = "GET", body, cookies, timeout = 30000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data, setCookie };
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const db = new DatabaseSync(DB_PATH, { readOnly: false });
let meetingId = "";

async function run() {
  try {
    // 1. 插入临时用户
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(TEST_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  const hash = `scrypt-v1$16384$8$1$${salt}$${key}`;
  const now = new Date().toISOString();
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
  db.prepare(
    `INSERT INTO users (id, account_name, display_name, email, department, external_user_id,
      password_hash, must_change_password, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(USER_ID, USER_ACCOUNT, "验证用户", "", "", null, hash, 0, "active", now, now);
  const role = db.prepare("SELECT id FROM roles WHERE role_key = ?").get("user");
  db.prepare("INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)").run(
    `rel-${USER_ID}`,
    USER_ID,
    role.id,
    now
  );

  // 2. 登录
  let r = await jf("/api/auth/login", { method: "POST", body: { accountName: USER_ACCOUNT, password: TEST_PASSWORD } });
  check("登录", r.status === 200, JSON.stringify(r.data?.user ?? r.data));
  if (r.status !== 200) {
    process.exitCode = 1;
    return;
  }
  const cookies = r.setCookie.split(";")[0];

  // 3. 系统翻译模板已 seed（admin 端点需要 admin 角色——普通用户用 templates 列表端点？llm-results 需要模板 id 存在即可；直接查库）
  const tpl = db.prepare("SELECT template_type FROM llm_prompt_templates WHERE template_key = 'system_translate'").get();
  check("系统翻译模板已 seed（template_type=translation）", tpl?.template_type === "translation", JSON.stringify(tpl));

  // 4. 创建会议（triggerLlm: false 避免并发纪要干扰）
  r = await jf("/api/meetings", {
    method: "POST",
    cookies,
    body: {
      title: "持久化验证会议",
      sourceType: "upload",
      triggerLlm: false,
      transcriptSegments: [
        { startMs: 0, endMs: 1000, text: "今天会议主要讨论项目进展。", speakerId: "s1", isFinal: true },
        { startMs: 1000, endMs: 2000, text: "下周我们需要发布新版本。", speakerId: "s1", isFinal: true },
      ],
    },
  });
  check("创建会议", r.status === 200, r.data?.error ?? `status=${r.status}`);
  meetingId = r.data?.meeting?.id ?? "";
  if (!meetingId) {
    process.exitCode = 1;
    return;
  }

  // 5. live-translation 持久化
  r = await jf(`/api/meetings/${meetingId}/live-translation`, {
    method: "POST",
    cookies,
    body: {
      targetLang: "en",
      blocks: [
        { time: "00:01", timeSeconds: 1, text: "Today's meeting mainly discussed project progress." },
        { time: "00:02", timeSeconds: 2, text: "Next week we need to release a new version." },
      ],
    },
  });
  check("live-translation 入库", r.status === 200, JSON.stringify(r.data ?? {}));

  r = await jf(`/api/meetings/${meetingId}/llm-results`, { cookies });
  const liveVersions = (r.data?.llmResults ?? []).filter((item) => item.resultType === "translation");
  check(
    "翻译版本出现（result_type=translation, succeeded）",
    liveVersions.length === 1 && liveVersions[0].status === "succeeded",
    JSON.stringify(liveVersions.map((v) => ({ v: v.versionNo, s: v.status })))
  );
  check(
    "译文内容正确",
    liveVersions[0]?.resultMarkdown?.includes("Today's meeting"),
    (liveVersions[0]?.resultMarkdown ?? "").slice(0, 80)
  );

  // 6. 空 blocks 400
  r = await jf(`/api/meetings/${meetingId}/live-translation`, { method: "POST", cookies, body: { targetLang: "en", blocks: [] } });
  check("空 blocks 返回 400", r.status === 400, `status=${r.status}`);

  // 7. 历史再次翻译（手动触发，LLM 可达则 succeeded；不可达则 failed 记录，均不挂死）
  r = await jf(`/api/meetings/${meetingId}/llm-results`, {
    method: "POST",
    cookies,
    body: { promptTemplateId: "tpl-translate", targetLang: "en" },
  });
  check("手动翻译触发（200 或 409）", r.status === 200 || r.status === 409, `status=${r.status}`);

  if (r.status === 200) {
    let final = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const poll = await jf(`/api/meetings/${meetingId}/llm-results`, { cookies });
      const translations = (poll.data?.llmResults ?? []).filter((item) => item.resultType === "translation");
      const pending = translations.some((item) => item.status === "processing" || item.status === "pending");
      const done = translations.filter((item) => item.status === "succeeded" || item.status === "failed");
      if (!pending && done.length >= 2) {
        final = done.reduce((max, item) => (item.versionNo > max.versionNo ? item : max), done[0]);
        break;
      }
    }
    check(
      "历史翻译生成新版本（succeeded 或 failed 明确落库）",
      final?.status === "succeeded" || final?.status === "failed",
      `status=${final?.status ?? "none"} error=${(final?.errorMessage ?? "").slice(0, 120)}`
    );
    check("生成版本号递增（≥2）", (final?.versionNo ?? 0) >= 2, `versionNo=${final?.versionNo}`);
  }
} finally {
  db.prepare(
    "DELETE FROM meeting_llm_results WHERE meeting_id IN (SELECT id FROM meetings WHERE created_by_user_id = ?)"
  ).run(USER_ID);
  db.prepare(
    "DELETE FROM meeting_asr_results WHERE meeting_id IN (SELECT id FROM meetings WHERE created_by_user_id = ?)"
  ).run(USER_ID);
  db.prepare("DELETE FROM meetings WHERE created_by_user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(USER_ID);
  db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
  db.close();
}
}

await run();

console.log(process.exitCode ? "验证未全部通过" : "全部通过");
