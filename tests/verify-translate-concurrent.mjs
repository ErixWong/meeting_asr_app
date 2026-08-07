// 历史翻译并发回归（round06）：2 个会议同时手动翻译，必须都 succeeded（嵌套队列缺陷回归）
// 前提：dev server 已启动（3123）
// 用法：node tests/verify-translate-concurrent.mjs
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3123";
const DB_PATH = join(process.cwd(), "data", "meeting-asr-app.db");
const TEST_PASSWORD = "verifypass123";
const USER_ACCOUNT = "verify_conc_user";
const USER_ID = "user-verify-conc";

async function jf(path, { method = "GET", body, cookies, timeout = 30000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookies ? { cookie: cookies } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, data, setCookie };
}

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const db = new DatabaseSync(DB_PATH, { readOnly: false });
const createdMeetings = [];

async function run() {
  try {
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

    let r = await jf("/api/auth/login", { method: "POST", body: { accountName: USER_ACCOUNT, password: TEST_PASSWORD } });
    check("登录", r.status === 200);
    if (r.status !== 200) { process.exitCode = 1; return; }
    const cookies = r.setCookie.split(";")[0];

    const sentences = Array.from({ length: 10 }, (_, i) => `并发测试句子${i + 1}，讨论项目进度与发布计划。`);
    const segments = sentences.map((text, i) => ({
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      text,
      speakerId: "s1",
      isFinal: true,
    }));

    const meetingIds = [];
    for (let i = 0; i < 2; i++) {
      r = await jf("/api/meetings", {
        method: "POST",
        cookies,
        body: { title: `并发翻译会议${i + 1}`, sourceType: "upload", triggerLlm: false, transcriptSegments: segments },
      });
      check(`创建会议${i + 1}`, r.status === 200, r.data?.error ?? `status=${r.status}`);
      if (r.data?.meeting?.id) {
        meetingIds.push(r.data.meeting.id);
        createdMeetings.push(r.data.meeting.id);
      }
    }
    if (meetingIds.length < 2) { process.exitCode = 1; return; }

    // 同时触发两个历史翻译
    const triggers = await Promise.all(
      meetingIds.map((id) =>
        jf(`/api/meetings/${id}/llm-results`, {
          method: "POST",
          cookies,
          body: { promptTemplateId: "tpl-translate", targetLang: "en" },
        })
      )
    );
    check("两个翻译同时触发", triggers.every((t) => t.status === 200 || t.status === 409), triggers.map((t) => t.status).join(","));

    // 轮询等待两个会议都出现 succeeded 翻译（最多 150s）
    const outcomes = new Map();
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      for (const id of meetingIds) {
        if (outcomes.has(id)) continue;
        const poll = await jf(`/api/meetings/${id}/llm-results`, { cookies });
        const translations = (poll.data?.llmResults ?? []).filter((item) => item.resultType === "translation");
        const done = translations.filter((item) => item.status === "succeeded" || item.status === "failed");
        if (done.length > 0) {
          const latest = done.reduce((max, item) => (item.versionNo > max.versionNo ? item : max), done[0]);
          outcomes.set(id, latest.status);
        }
      }
      if (outcomes.size >= meetingIds.length) break;
    }

    check(
      "两个会议翻译均 succeeded（无嵌套队列超时）",
      meetingIds.every((id) => outcomes.get(id) === "succeeded"),
      JSON.stringify(Object.fromEntries(outcomes))
    );
  } finally {
    for (const id of createdMeetings) {
      db.prepare("DELETE FROM meeting_llm_results WHERE meeting_id = ?").run(id);
      db.prepare("DELETE FROM meeting_asr_results WHERE meeting_id = ?").run(id);
      db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(USER_ID);
    db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(USER_ID);
    db.prepare("DELETE FROM users WHERE id = ?").run(USER_ID);
    db.close();
  }
}

await run();
console.log(process.exitCode ? "验证未全部通过" : "全部通过");
