// 翻译 API + LLM 全局队列验证
// 前提：dev server 已启动（端口 3123），且加载了新代码
// 用法：node tests/verify-translate-queue.mjs
// 说明：直接读写本地 SQLite 插入临时用户，验证后清理；仅限本地开发库
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3123";
const DB_PATH = join(process.cwd(), "data", "meeting-asr-app.db");
const TEST_PASSWORD = "verifypass123";
const USER_ACCOUNT = "verify_queue_user";
const USER_ID = "user-verify-queue";
const USER_ROLE_REL = "user-role-verify-queue";
const ADMIN_ACCOUNT = "verify_queue_admin";
const ADMIN_ID = "user-verify-queue-admin";
const ADMIN_ROLE_REL = "user-role-verify-queue-admin";

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

function insertUser(db, userId, accountName, roleKey) {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(TEST_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  const hash = `scrypt-v1$16384$8$1$${salt}$${key}`;
  const now = new Date().toISOString();
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  db.prepare(
    `INSERT INTO users (id, account_name, display_name, email, department, external_user_id,
      password_hash, must_change_password, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, accountName, "验证用户", "", "", null, hash, 0, "active", now, now);
  const role = db.prepare("SELECT id FROM roles WHERE role_key = ?").get(roleKey);
  if (!role) throw new Error(`roles 表中缺少 ${roleKey} 角色`);
  db.prepare("INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)").run(
    `rel-${userId}`,
    userId,
    role.id,
    now
  );
}

const db = new DatabaseSync(DB_PATH, { readOnly: false });
try {
  insertUser(db, USER_ID, USER_ACCOUNT, "user");
  insertUser(db, ADMIN_ID, ADMIN_ACCOUNT, "system_admin");

  let userCookies = "";
  let adminCookies = "";

  // 1. 未认证
  let r = await jf("/api/translate", { method: "POST", body: { sentences: ["你好"], targetLang: "en" } });
  check("无 cookie 访问 /api/translate 返回 401", r.status === 401, `status=${r.status}`);
  r = await jf("/api/admin/llm-queue-status");
  check("无 cookie 访问 queue-status 返回 401", r.status === 401, `status=${r.status}`);

  // 2. 普通用户
  r = await jf("/api/auth/login", { method: "POST", body: { accountName: USER_ACCOUNT, password: TEST_PASSWORD } });
  check("普通用户登录", r.status === 200, JSON.stringify(r.data?.user ?? r.data));
  if (r.status === 200) userCookies = r.setCookie.split(";")[0];

  r = await jf("/api/translate", { method: "POST", cookies: userCookies, body: { sentences: [], targetLang: "en" } });
  check("空句子返回 400", r.status === 400, `status=${r.status}`);

  r = await jf("/api/admin/llm-queue-status", { cookies: userCookies });
  check("普通用户访问 queue-status 返回 403", r.status === 403, `status=${r.status}`);

  r = await jf("/api/translate", {
    method: "POST",
    cookies: userCookies,
    body: { sentences: ["第一句会议发言", "第二句会议发言", "第三句会议发言"], targetLang: "en" },
    timeout: 60000,
  });
  const translateReachable = r.status === 200;
  check(
    "翻译请求经队列返回（200 或 LLM 不可用时 500，均不挂死）",
    r.status === 200 || r.status === 500,
    `status=${r.status} data=${JSON.stringify(r.data ?? {}).slice(0, 200)}`
  );
  if (translateReachable) {
    check("翻译返回 text 字段", typeof r.data?.text === "string" && r.data.text.length > 0, JSON.stringify(r.data).slice(0, 150));
  }

  // 3. 管理员
  r = await jf("/api/auth/login", { method: "POST", body: { accountName: ADMIN_ACCOUNT, password: TEST_PASSWORD } });
  check("管理员登录", r.status === 200, JSON.stringify(r.data?.user ?? r.data));
  if (r.status === 200) adminCookies = r.setCookie.split(";")[0];

  r = await jf("/api/admin/llm-queue-status", { cookies: adminCookies });
  check(
    "管理员 queue-status 返回 200 且字段齐全",
    r.status === 200 &&
      typeof r.data?.inFlight === "number" &&
      typeof r.data?.queued === "number" &&
      typeof r.data?.dropped === "number" &&
      r.data.inFlight === 0 &&
      r.data.queued === 0,
    JSON.stringify(r.data ?? {})
  );
  const droppedBaseline = r.data?.dropped ?? 0;

  // 4. 新配置项已 seed
  r = await jf("/api/admin/settings", { cookies: adminCookies });
  const settings = Array.isArray(r.data?.settings) ? r.data.settings : [];
  const get = (mark) => settings.find((s) => s.itemSection === "llm" && s.itemMark === mark)?.itemValue;
  check("llm:max_concurrency 已存在（默认 2）", get("max_concurrency") === "2", `value=${get("max_concurrency")}`);
  check("llm:queue_capacity 已存在（默认 10）", get("queue_capacity") === "10", `value=${get("queue_capacity")}`);

  // 5. test-llm 经队列（LLM 不可用时 500 但不挂死）
  const llmBaseUrl = get("base_url") || "http://qwen.local:8080/v1";
  const llmModel = get("model") || "qwen3.6-35b";
  r = await jf("/api/admin/test-llm", {
    method: "POST",
    cookies: adminCookies,
    body: { baseUrl: llmBaseUrl, model: llmModel },
    timeout: 60000,
  });
  check(
    "test-llm 经队列返回（200 或 LLM 不可用 500）",
    r.status === 200 || r.status === 500,
    `status=${r.status} data=${JSON.stringify(r.data ?? {}).slice(0, 150)}`
  );

  // 6. 并发 6 个翻译请求：队列应串行处理，请求全部正常结束
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      jf("/api/translate", {
        method: "POST",
        cookies: userCookies,
        body: { sentences: ["并发测试句子一", "并发测试句子二"], targetLang: "en" },
        timeout: 90000,
      })
    )
  );
  check(
    "并发 6 个翻译请求全部有明确响应",
    results.every((item) => item.status === 200 || item.status === 500),
    results.map((item) => item.status).join(",")
  );

  r = await jf("/api/admin/llm-queue-status", { cookies: adminCookies });
  check(
    "压测后队列归零（inFlight/queued=0）",
    r.data?.inFlight === 0 && r.data?.queued === 0,
    JSON.stringify(r.data ?? {})
  );
  check(
    "压测期间 dropped 计数未异常增长（≤ 并发数）",
    (r.data?.dropped ?? 0) - droppedBaseline <= 6,
    `delta=${(r.data?.dropped ?? 0) - droppedBaseline}`
  );

  // 7. 创建会议（默认 triggerLlm）不破坏原流程
  r = await jf("/api/meetings", {
    method: "POST",
    cookies: userCookies,
    body: {
      title: "队列验证会议",
      sourceType: "upload",
      transcriptSegments: [{ startMs: 0, endMs: 1000, text: "测试", speakerId: "s1" }],
    },
    timeout: 60000,
  });
  check("创建会议（纪要生成经队列）仍返回 200", r.status === 200, `status=${r.status} ${r.data?.error ?? ""}`);
} finally {
  db.prepare("DELETE FROM meeting_llm_results WHERE meeting_id IN (SELECT id FROM meetings WHERE title = '队列验证会议')").run();
  db.prepare("DELETE FROM meetings WHERE title = '队列验证会议'").run();
  db.prepare("DELETE FROM auth_sessions WHERE user_id IN (?, ?)").run(USER_ID, ADMIN_ID);
  db.prepare("DELETE FROM user_roles WHERE user_id IN (?, ?)").run(USER_ID, ADMIN_ID);
  db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(USER_ID, ADMIN_ID);
  db.close();
}

console.log(process.exitCode ? "验证未全部通过" : "全部通过");
