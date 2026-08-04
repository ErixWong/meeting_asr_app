// 权限回归测试：验证角色归并后的权限链路
// 前提：dev server 已启动（npm run dev，端口 3123）
// 用法：node tests/verify-permissions.mjs
// 说明：admin 密码未知时，脚本直接在 SQLite 中插入临时用户完成验证，结束后清理。
// 警告：会直接读写 data/meeting-asr-app.db（先 DELETE 再 INSERT 固定名临时账号），
//       仅允许对本地开发库运行，严禁在生产或共享环境执行。
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";

const BASE = "http://127.0.0.1:3123";
const DB_PATH = join(process.cwd(), "data", "meeting-asr-app.db");
const TEST_ACCOUNT = "verify_tmp_user";
const TEST_PASSWORD = "testpass123";
const TEST_USER_ID = "user-verify-tmp";
const TEST_ROLE_REL_ID = "user-role-verify-tmp";
const TEST_ACCOUNT_2 = "verify_tmp_user2";
const TEST_USER_ID_2 = "user-verify-tmp2";
const TEST_ROLE_REL_ID_2 = "user-role-verify-tmp2";
const TEST_ACCOUNT_3 = "verify_tmp_admin";
const TEST_USER_ID_3 = "user-verify-tmp3";
const TEST_ROLE_REL_ID_3 = "user-role-verify-tmp3";

async function jf(path, { method = "GET", body, cookies } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookies ? { cookie: cookies } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
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

function insertUser(db, userId, accountName, roleRelId, roleKey = "user") {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(TEST_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  const hash = `scrypt-v1$16384$8$1$${salt}$${key}`;
  const now = new Date().toISOString();
  db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  db.prepare(`
    INSERT INTO users (id, account_name, display_name, email, department, external_user_id,
      password_hash, must_change_password, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, accountName, "验证用户", "", "", null, hash, 0, "active", now, now);
  const role = db.prepare("SELECT id FROM roles WHERE role_key = ?").get(roleKey);
  if (!role) throw new Error(`roles 表中缺少 ${roleKey} 角色`);
  db.prepare(`
    INSERT INTO user_roles (id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)
  `).run(roleRelId, userId, role.id, now);
}

function seedTempUsers() {
  const db = new DatabaseSync(DB_PATH);
  try {
    insertUser(db, TEST_USER_ID, TEST_ACCOUNT, TEST_ROLE_REL_ID);
    insertUser(db, TEST_USER_ID_2, TEST_ACCOUNT_2, TEST_ROLE_REL_ID_2);
    insertUser(db, TEST_USER_ID_3, TEST_ACCOUNT_3, TEST_ROLE_REL_ID_3, "system_admin");
  } finally {
    db.close();
  }
}

function cleanupTempUsers() {
  const db = new DatabaseSync(DB_PATH);
  try {
    for (const userId of [TEST_USER_ID, TEST_USER_ID_2, TEST_USER_ID_3]) {
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_roles WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }
  } finally {
    db.close();
  }
}

async function main() {
  // 0. 角色归并检查：minutes_admin 不应再存在
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const roles = db.prepare("SELECT role_key FROM roles ORDER BY role_key").all().map((r) => r.role_key);
  db.close();
  check("角色已归并为 user/system_admin", roles.length === 2 && roles.includes("user") && roles.includes("system_admin"),
    JSON.stringify(roles));

  seedTempUsers();

  let userCookies = "";
  let user2Cookies = "";
  try {
    // 1. 普通用户登录
    let r = await jf("/api/auth/login", {
      method: "POST",
      body: { accountName: TEST_ACCOUNT, password: TEST_PASSWORD },
    });
    check("普通用户登录", r.status === 200, JSON.stringify(r.data?.user ?? r.data));
    if (r.status !== 200) return;
    userCookies = r.setCookie.split(";")[0];

    // 1b. /api/auth/me 返回 roles（前端角色守卫依赖）
    r = await jf("/api/auth/me", { cookies: userCookies });
    check("GET /api/auth/me 返回 roles", r.status === 200 && Array.isArray(r.data?.user?.roles),
      JSON.stringify(r.data?.user ?? r.data));
    check("普通用户 roles 不含 system_admin", r.data?.user?.roles?.includes("system_admin") === false,
      JSON.stringify(r.data?.user?.roles));

    // 2. 业务端点应放行
    r = await jf("/api/meetings", { cookies: userCookies });
    check("GET /api/meetings", r.status === 200, `status=${r.status}`);

    r = await jf("/api/config", { cookies: userCookies });
    check("GET /api/config", r.status === 200, `status=${r.status}`);

    r = await jf("/api/admin/prompt-templates", { cookies: userCookies });
    check("GET 模板列表（生成纪要选择用）", r.status === 200, `status=${r.status}`);

    r = await jf("/api/meetings", {
      method: "POST",
      cookies: userCookies,
      body: {
        title: "权限验证会议",
        sourceType: "upload",
        transcriptSegments: [{ startMs: 0, endMs: 1000, text: "会议开始", speakerId: "speaker-1" }],
      },
    });
    check("创建会议", r.status === 200, r.data?.error ?? `status=${r.status}`);
    const meetingId = r.data?.meeting?.id;
    if (meetingId) {
      r = await jf(`/api/meetings/${meetingId}`, { cookies: userCookies });
      check("查看会议", r.status === 200, `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        cookies: userCookies,
        body: { title: "改名" },
      });
      check("修改会议标题", r.status === 200, r.data?.error ?? `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}/asr-results`, { cookies: userCookies });
      check("GET asr-results", r.status === 200, `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}/llm-results`, { cookies: userCookies });
      check("GET llm-results", r.status === 200, `status=${r.status}`);
    } else {
      check("创建会议返回 meeting", false, r.data?.error ?? "no meeting id");
    }

    // 2b. 数据隔离：用户 B 看不到用户 A 创建的会议
    if (meetingId) {
      r = await jf("/api/auth/login", {
        method: "POST",
        body: { accountName: TEST_ACCOUNT_2, password: TEST_PASSWORD },
      });
      check("用户 B 登录", r.status === 200, JSON.stringify(r.data?.user ?? r.data));
      if (r.status === 200) user2Cookies = r.setCookie.split(";")[0];

      r = await jf(`/api/meetings/${meetingId}`, { cookies: user2Cookies });
      check("用户 B 访问用户 A 的会议被拒", r.status === 404, `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}/llm-results`, { cookies: user2Cookies });
      check("用户 B 访问用户 A 的 llm-results 被拒", r.status === 404, `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}/asr-results`, { cookies: user2Cookies });
      check("用户 B 访问用户 A 的 asr-results 被拒", r.status === 404, `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}/send-records`, { cookies: user2Cookies });
      check("用户 B 访问用户 A 的 send-records 被拒", r.status === 404, `status=${r.status}`);
      r = await jf(`/api/meetings/${meetingId}`, { method: "DELETE", cookies: user2Cookies });
      check("用户 B 删除用户 A 的会议被拒", r.status === 404, `status=${r.status}`);

      r = await jf("/api/meetings", { cookies: user2Cookies });
      const visibleToB = (r.data?.meetings ?? []).some((m) => m.id === meetingId);
      check("用户 B 的会议列表不含用户 A 的会议", !visibleToB, `status=${r.status}`);

      r = await jf("/api/meetings", { cookies: userCookies });
      const visibleToA = (r.data?.meetings ?? []).some((m) => m.id === meetingId);
      check("用户 A 自己的会议列表可见", visibleToA, `status=${r.status}`);

      // 2c. 管理员同样隔离：看不到用户 A 的会议
      r = await jf("/api/auth/login", {
        method: "POST",
        body: { accountName: TEST_ACCOUNT_3, password: TEST_PASSWORD },
      });
      check("管理员账号登录", r.status === 200 && r.data?.user?.roles?.includes("system_admin"),
        JSON.stringify(r.data?.user ?? r.data));
      const adminCookies = r.status === 200 ? r.setCookie.split(";")[0] : "";
      r = await jf(`/api/meetings/${meetingId}`, { cookies: adminCookies });
      check("管理员访问用户 A 的会议被拒", r.status === 404, `status=${r.status}`);
      r = await jf("/api/meetings", { cookies: adminCookies });
      const visibleToAdmin = (r.data?.meetings ?? []).some((m) => m.id === meetingId);
      check("管理员会议列表不含用户 A 的会议", !visibleToAdmin, `status=${r.status}`);

      // 2d. 隔离检查通过后，用户 A 删除会议
      r = await jf(`/api/meetings/${meetingId}`, { method: "DELETE", cookies: userCookies });
      check("删除会议", r.status === 200, r.data?.error ?? `status=${r.status}`);
    }

    // 3. 管理端点应 403
    for (const path of ["/api/admin/users", "/api/admin/settings", "/api/admin/hotwords", "/api/admin/audit-logs"]) {
      r = await jf(path, { cookies: userCookies });
      check(`${path} 被拒`, r.status === 403, `status=${r.status}`);
    }
    r = await jf("/api/admin/prompt-templates", {
      method: "POST",
      cookies: userCookies,
      body: { templateKey: "x", templateName: "x", templateType: "custom", content: "x" },
    });
    check("普通用户创建模板被拒", r.status === 403, `status=${r.status}`);

    // 4. 禁用后会话立即失效（直接改库模拟管理员禁用）
    {
      const d = new DatabaseSync(DB_PATH);
      d.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(TEST_USER_ID);
      d.close();
      r = await jf("/api/auth/me", { cookies: userCookies });
      check("禁用后会话立即失效", r.status === 401, `status=${r.status}`);
    }
  } finally {
    cleanupTempUsers();
  }
}

main().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exitCode = 1;
});
