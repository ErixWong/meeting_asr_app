"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuthSession } from "@/lib/use-auth-session";

type AdminTab = "asr" | "llm" | "mail" | "templates" | "hotwords" | "users" | "audit";

type SettingItem = {
  itemSection: string;
  itemMark: string;
  itemTitle: string;
  itemDescription: string;
  itemValue: string;
};

type PromptTemplateItem = {
  id: string;
  templateKey: string;
  templateName: string;
  templateType: string;
  content: string;
  description: string;
  status: string;
  isSystem?: boolean;
};

type HotwordItem = {
  id: string;
  term: string;
  weight: number;
  status: string;
  note: string;
};

type RoleItem = {
  id: string;
  roleKey: string;
  roleName: string;
};

type UserItem = {
  id: string;
  accountName: string;
  displayName: string;
  email: string;
  department: string;
  status: string;
  roles: RoleItem[];
};

type UserModalState = { mode: "create" } | { mode: "edit"; user: UserItem };

type UserDraft = {
  id?: string;
  accountName: string;
  displayName: string;
  email: string;
  department: string;
  status: string;
  roleKeys: string[];
  password: string;
};

type AuditLogItem = {
  id: string;
  actorAccountName: string;
  actorDisplayName: string;
  actionType: string;
  resourceType: string;
  resourceId: string;
  resourceName?: string | null;
  result: string;
  errorMessage?: string | null;
  createdAt: string;
};

type DiagnosticStep = {
  step: string;
  ok: boolean;
  detail: string;
  elapsedMs?: number;
};

type AsrDiagnostics = {
  providerType: string;
  inputEndpoint: string;
  targetUrl: string;
  hasApiKey: boolean;
  workspaceId?: string;
  steps: DiagnosticStep[];
};

type ApiResponse = Record<string, unknown>;

function isApiResponse(value: unknown): value is ApiResponse {
  return typeof value === "object" && value !== null;
}

class ApiRequestError extends Error {
  data: ApiResponse;

  constructor(message: string, data: ApiResponse) {
    super(message);
    this.name = "ApiRequestError";
    this.data = data;
  }
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-slate-800">
        <span>{icon}</span> {title}
      </h2>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: "ok" | "fail" | "idle" }) {
  const map = {
    ok: { text: "● 已连接", cls: "text-green-600" },
    fail: { text: "● 连接失败", cls: "text-red-600" },
    idle: { text: "● 未连接", cls: "text-slate-400" },
  } as const;
  const s = map[status];
  return <span className={`text-sm ${s.cls}`}>{s.text}</span>;
}

function SectionTabs({
  value,
  onChange,
}: {
  value: AdminTab;
  onChange: (next: AdminTab) => void;
}) {
  const tabs: { key: AdminTab; label: string }[] = [
    { key: "asr", label: "ASR 配置" },
    { key: "llm", label: "LLM 配置" },
    { key: "mail", label: "邮件配置" },
    { key: "templates", label: "模板管理" },
    { key: "hotwords", label: "热词管理" },
    { key: "users", label: "用户与权限" },
    { key: "audit", label: "审计日志" },
  ];

  return (
    <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`rounded-lg px-3 py-2 text-sm transition ${
            value === tab.key
              ? "bg-brand text-white shadow-sm"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default function AdminPage() {
  const { user: currentUser, loading: authLoading } = useAuthSession(true);
  const [activeTab, setActiveTab] = useState<AdminTab>("asr");
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const [funasrProvider, setFunasrProvider] = useState("local_funasr");
  const [funasrUrl, setFunasrUrl] = useState("ws://funasr.local:10095/ws");
  const [funasrApiKey, setFunasrApiKey] = useState("");
  const [funasrWorkspaceId, setFunasrWorkspaceId] = useState("");
  const [funasrStatus, setFunasrStatus] = useState<"ok" | "fail" | "idle">("idle");
  const [funasrDiagnostics, setFunasrDiagnostics] = useState<AsrDiagnostics | null>(null);

  const [llmUrl, setLlmUrl] = useState("http://qwen.local:8080/v1");
  const [llmKey, setLlmKey] = useState("");
  const [llmModel, setLlmModel] = useState("qwen3.6-35b");
  const [llmContextSize, setLlmContextSize] = useState("");
  const [llmMaxTokens, setLlmMaxTokens] = useState("");
  const [llmTimeoutMs, setLlmTimeoutMs] = useState("");
  const [llmStatus, setLlmStatus] = useState<"ok" | "fail" | "idle">("idle");

  const [mailHost, setMailHost] = useState("smtp.example.com");
  const [mailPort, setMailPort] = useState("465");
  const [mailUser, setMailUser] = useState("meeting@example.com");
  const [mailPassword, setMailPassword] = useState("");
  const [mailFromName, setMailFromName] = useState("会议纪要机器人");
  const [mailFromEmail, setMailFromEmail] = useState("meeting@example.com");
  const [mailStatus, setMailStatus] = useState<"ok" | "fail" | "idle">("idle");

  const [defaultTemplateId, setDefaultTemplateId] = useState("");
  const [templates, setTemplates] = useState<PromptTemplateItem[]>([]);
  const [hotwords, setHotwords] = useState<HotwordItem[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [userModal, setUserModal] = useState<UserModalState | null>(null);
  const [userDraft, setUserDraft] = useState<UserDraft | null>(null);
  const [savingUser, setSavingUser] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const inputCls =
    "w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand";
  const btnCls =
    "rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60";

  const settingsPayload = useMemo<SettingItem[]>(
    () => [
      {
        itemSection: "asr",
        itemMark: "provider",
        itemTitle: "ASR Provider",
        itemDescription: "当前 ASR 提供方",
        itemValue: funasrProvider,
      },
      {
        itemSection: "asr",
        itemMark: "endpoint",
        itemTitle: "FunASR Endpoint",
        itemDescription: "FunASR 服务地址",
        itemValue: funasrUrl,
      },
      {
        itemSection: "asr",
        itemMark: "api_key",
        itemTitle: "ASR API Key",
        itemDescription: "DashScope API Key",
        itemValue: funasrApiKey,
      },
      {
        itemSection: "asr",
        itemMark: "workspace_id",
        itemTitle: "ASR Workspace ID",
        itemDescription: "DashScope Workspace ID",
        itemValue: funasrWorkspaceId,
      },
      {
        itemSection: "llm",
        itemMark: "base_url",
        itemTitle: "LLM URL",
        itemDescription: "OpenAI 兼容服务根地址",
        itemValue: llmUrl,
      },
      {
        itemSection: "llm",
        itemMark: "api_key",
        itemTitle: "LLM API Key",
        itemDescription: "LLM API Key",
        itemValue: llmKey,
      },
      {
        itemSection: "llm",
        itemMark: "model",
        itemTitle: "LLM Model",
        itemDescription: "当前使用模型",
        itemValue: llmModel,
      },
      {
        itemSection: "llm",
        itemMark: "context_size",
        itemTitle: "上下文大小（字符）",
        itemDescription: "发送给 LLM 的文本截断长度，留空不截断",
        itemValue: llmContextSize,
      },
      {
        itemSection: "llm",
        itemMark: "max_tokens",
        itemTitle: "最大回复 Tokens",
        itemDescription: "留空则由 LLM 自行决定回复长度",
        itemValue: llmMaxTokens,
      },
      {
        itemSection: "llm",
        itemMark: "timeout_ms",
        itemTitle: "调用超时（毫秒）",
        itemDescription: "留空使用默认 180000",
        itemValue: llmTimeoutMs,
      },
      {
        itemSection: "mail",
        itemMark: "smtp_host",
        itemTitle: "SMTP Host",
        itemDescription: "邮件服务主机",
        itemValue: mailHost,
      },
      {
        itemSection: "mail",
        itemMark: "smtp_port",
        itemTitle: "SMTP Port",
        itemDescription: "邮件服务端口",
        itemValue: mailPort,
      },
      {
        itemSection: "mail",
        itemMark: "smtp_username",
        itemTitle: "SMTP Username",
        itemDescription: "邮件服务用户名",
        itemValue: mailUser,
      },
      {
        itemSection: "mail",
        itemMark: "smtp_password",
        itemTitle: "SMTP Password",
        itemDescription: "邮件服务密码",
        itemValue: mailPassword,
      },
      {
        itemSection: "mail",
        itemMark: "from_name",
        itemTitle: "From Name",
        itemDescription: "发件人名称",
        itemValue: mailFromName,
      },
      {
        itemSection: "mail",
        itemMark: "from_email",
        itemTitle: "From Email",
        itemDescription: "发件人邮箱",
        itemValue: mailFromEmail,
      },
      {
        itemSection: "system",
        itemMark: "default_prompt_template_id",
        itemTitle: "默认纪要模板",
        itemDescription: "自动生成首版结果时使用",
        itemValue: defaultTemplateId,
      },
    ],
    [
      defaultTemplateId,
      funasrApiKey,
      funasrProvider,
      funasrUrl,
      funasrWorkspaceId,
      llmKey,
      llmModel,
      llmUrl,
      llmContextSize,
      llmMaxTokens,
      llmTimeoutMs,
      mailFromEmail,
      mailFromName,
      mailHost,
      mailPassword,
      mailPort,
      mailUser,
    ]
  );

  const requestJson = async <T extends ApiResponse = ApiResponse>(input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const parsed: unknown = await res.json().catch(() => ({}));
    const data = isApiResponse(parsed) ? parsed : {};
    const error = typeof data.error === "string" ? data.error : `Request failed: ${res.status}`;
    if (!res.ok || typeof data.error === "string") {
      throw new ApiRequestError(error, data);
    }
    return data as T;
  };

  const showSuccess = (text: string) => setNotice({ type: "success", text });
  const showError = (text: string) => setNotice({ type: "error", text });

  useEffect(() => {
    if (authLoading || !currentUser || !currentUser.roles.includes("system_admin")) return;

    const loadAdminData = async () => {
      try {
        const results = await Promise.allSettled([
          requestJson("/api/admin/settings"),
          requestJson("/api/admin/prompt-templates"),
          requestJson("/api/admin/hotwords"),
          requestJson("/api/admin/users"),
          requestJson("/api/admin/roles"),
          requestJson("/api/admin/audit-logs"),
        ]);
        const [settingsResult, templatesResult, hotwordsResult, usersResult, rolesResult, auditLogsResult] = results;
        const getData = (result: PromiseSettledResult<ApiResponse>) =>
          result.status === "fulfilled" ? result.value : {};
        const settingsData = getData(settingsResult);
        const templatesData = getData(templatesResult);
        const hotwordsData = getData(hotwordsResult);
        const usersData = getData(usersResult);
        const rolesData = getData(rolesResult);
        const auditLogsData = getData(auditLogsResult);

        if (results.some((result) => result.status === "rejected")) {
          showError("部分后台数据加载失败，请稍后重试");
        }

        const settings = (settingsData.settings ?? []) as SettingItem[];
        const get = (section: string, mark: string, fallback = "") =>
          settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? fallback;

        setFunasrProvider(get("asr", "provider", "local_funasr"));
        setFunasrUrl(get("asr", "endpoint", "ws://funasr.local:10095/ws"));
        setFunasrApiKey(get("asr", "api_key", ""));
        setFunasrWorkspaceId(get("asr", "workspace_id", ""));

        setLlmUrl(get("llm", "base_url", "http://qwen.local:8080/v1"));
        setLlmKey(get("llm", "api_key", ""));
        setLlmModel(get("llm", "model", "qwen3.6-35b"));
        setLlmContextSize(get("llm", "context_size", ""));
        setLlmMaxTokens(get("llm", "max_tokens", ""));
        setLlmTimeoutMs(get("llm", "timeout_ms", ""));

        setMailHost(get("mail", "smtp_host", "smtp.example.com"));
        setMailPort(get("mail", "smtp_port", "465"));
        setMailUser(get("mail", "smtp_username", "meeting@example.com"));
        setMailPassword(get("mail", "smtp_password", ""));
        setMailFromName(get("mail", "from_name", "会议纪要机器人"));
        setMailFromEmail(get("mail", "from_email", "meeting@example.com"));

        const nextTemplates = (templatesData.templates ?? []) as PromptTemplateItem[];
        const nextHotwords = (hotwordsData.hotwords ?? []) as HotwordItem[];

        setTemplates(nextTemplates);
        setHotwords(nextHotwords);
        setUsers((usersData.users ?? []) as UserItem[]);
        setRoles((rolesData.roles ?? []) as RoleItem[]);
        setAuditLogs((auditLogsData.auditLogs ?? []) as AuditLogItem[]);
        setDefaultTemplateId(get("system", "default_prompt_template_id", nextTemplates[0]?.id ?? ""));
      } catch (error) {
        console.error("Failed to load admin data:", error);
        showError(`后台配置加载失败: ${(error as Error).message}`);
      } finally {
        setLoading(false);
      }
    };

    loadAdminData().catch(console.error);
  }, [authLoading, currentUser]);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      await requestJson("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: settingsPayload }),
      });
      await loadAuditLogs();
      showSuccess("设置已保存");
    } catch (error) {
      showError(`设置保存失败: ${(error as Error).message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const loadAuditLogs = async () => {
    const data = await requestJson("/api/admin/audit-logs");
    setAuditLogs((data.auditLogs ?? []) as AuditLogItem[]);
  };

  const refreshAuditLogsBestEffort = async () => {
    try {
      await loadAuditLogs();
      return true;
    } catch (error) {
      console.error("Failed to refresh audit logs:", error);
      return false;
    }
  };

  const persistTemplate = async (template: PromptTemplateItem) => {
    const data = await requestJson<{ template: PromptTemplateItem }>(`/api/admin/prompt-templates/${template.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templateKey: template.templateKey,
        templateName: template.templateName,
        templateType: template.templateType,
        content: template.content,
        description: template.description,
        status: template.status,
        isSystem: template.isSystem,
      }),
    });
    return data.template as PromptTemplateItem;
  };

  const saveTemplate = async (template: PromptTemplateItem) => {
    try {
      const savedTemplate = await persistTemplate(template);
      setTemplates((prev) => prev.map((item) => (item.id === template.id ? savedTemplate : item)));
      showSuccess("模板已保存");
    } catch (error) {
      showError(`模板保存失败: ${(error as Error).message}`);
    }
  };

  const saveDefaultTemplate = async (templateId: string) => {
    setSavingSettings(true);
    try {
      await requestJson("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: [
            {
              itemSection: "system",
              itemMark: "default_prompt_template_id",
              itemTitle: "默认纪要模板",
              itemDescription: "自动生成首版结果时使用",
              itemValue: templateId,
            },
          ],
        }),
      });
      setDefaultTemplateId(templateId);
      await loadAuditLogs();
      showSuccess("默认模板已保存");
    } catch (error) {
      showError(`默认模板保存失败: ${(error as Error).message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleTemplateStatus = async (template: PromptTemplateItem) => {
    const nextTemplate = {
      ...template,
      status: template.status === "active" ? "disabled" : "active",
    };

    try {
      const savedTemplate = await persistTemplate(nextTemplate);
      setTemplates((prev) => prev.map((item) => (item.id === template.id ? savedTemplate : item)));
      showSuccess(savedTemplate.status === "active" ? "模板已启用" : "模板已停用");
    } catch (error) {
      showError(`模板状态保存失败: ${(error as Error).message}`);
    }
  };

  const createTemplate = async () => {
    try {
      const data = await requestJson<{ template: PromptTemplateItem }>("/api/admin/prompt-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateKey: `custom_${Date.now()}`,
          templateName: "新模板",
          templateType: "custom",
          content: "请根据以下会议转写内容输出结果。\n\n{transcript}",
          description: "请补充说明",
        }),
      });
      setTemplates((prev) => [...prev, data.template]);
      showSuccess("模板已新增");
    } catch (error) {
      showError(`新增模板失败: ${(error as Error).message}`);
    }
  };

  const saveHotword = async (hotword: HotwordItem) => {
    try {
      const data = await requestJson<{ hotword: HotwordItem }>(`/api/admin/hotwords/${hotword.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hotword),
      });
      setHotwords((prev) => prev.map((item) => (item.id === hotword.id ? data.hotword : item)));
      showSuccess("热词已保存");
    } catch (error) {
      showError(`热词保存失败: ${(error as Error).message}`);
    }
  };

  const createHotword = async () => {
    try {
      const data = await requestJson<{ hotword: HotwordItem }>("/api/admin/hotwords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ term: `新热词${Date.now()}`, weight: 10, status: "active", note: "" }),
      });
      setHotwords((prev) => [...prev, data.hotword]);
      showSuccess("热词已新增");
    } catch (error) {
      showError(`新增热词失败: ${(error as Error).message}`);
    }
  };

  const removeHotword = async (id: string) => {
    try {
      await requestJson(`/api/admin/hotwords/${id}`, { method: "DELETE" });
      setHotwords((prev) => prev.filter((item) => item.id !== id));
      showSuccess("热词已删除");
    } catch (error) {
      showError(`删除热词失败: ${(error as Error).message}`);
    }
  };

  const roleKeysOf = (user: UserItem) => user.roles.map((role) => role.roleKey);

  const openCreateUser = () => {
    setUserDraft({
      accountName: "",
      displayName: "",
      email: "",
      department: "",
      status: "active",
      roleKeys: ["user"],
      password: "",
    });
    setUserModal({ mode: "create" });
  };

  const openEditUser = (user: UserItem) => {
    setUserDraft({
      id: user.id,
      accountName: user.accountName,
      displayName: user.displayName,
      email: user.email,
      department: user.department,
      status: user.status,
      roleKeys: roleKeysOf(user),
      password: "",
    });
    setUserModal({ mode: "edit", user });
  };

  const closeUserModal = () => {
    if (savingUser) return;
    setUserModal(null);
    setUserDraft(null);
  };

  const toggleDraftRole = (roleKey: string) => {
    setUserDraft((prev) => {
      if (!prev) return prev;
      const hasRole = prev.roleKeys.includes(roleKey);
      return {
        ...prev,
        roleKeys: hasRole ? prev.roleKeys.filter((key) => key !== roleKey) : [...prev.roleKeys, roleKey],
      };
    });
  };

  const submitUserModal = async () => {
    if (!userDraft || !userModal || savingUser) return;

    const accountName = userDraft.accountName.trim();
    const displayName = userDraft.displayName.trim();
    const password = userDraft.password.trim();
    if (!accountName || !displayName) {
      showError("账号和姓名不能为空");
      return;
    }
    if (userModal.mode === "create" && password.length < 8) {
      showError("初始密码至少 8 位");
      return;
    }
    if (userModal.mode === "edit" && password && password.length < 8) {
      showError("密码至少 8 位");
      return;
    }

    setSavingUser(true);
    let userDataSaved = false;
    try {
      let savedUser: UserItem;
      if (userModal.mode === "create") {
        const data = await requestJson<{ user: UserItem }>("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountName,
            displayName,
            email: userDraft.email.trim(),
            department: userDraft.department.trim(),
            status: userDraft.status,
            roleKeys: userDraft.roleKeys,
            initialPassword: password,
          }),
        });
        savedUser = data.user;
        userDataSaved = true;
        setUsers((prev) => [...prev, savedUser]);
      } else {
        if (!userDraft.id) return;
        const data = await requestJson<{ user: UserItem }>(`/api/admin/users/${userDraft.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountName,
            displayName,
            email: userDraft.email.trim(),
            department: userDraft.department.trim(),
            status: userDraft.status,
            roleKeys: userDraft.roleKeys,
          }),
        });
        savedUser = data.user;
        userDataSaved = true;
        setUsers((prev) => prev.map((item) => (item.id === savedUser.id ? savedUser : item)));

        if (password) {
          await requestJson(`/api/admin/users/${userDraft.id}/password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nextPassword: password }),
          });
        }
      }

      const auditRefreshed = await refreshAuditLogsBestEffort();
      setUserModal(null);
      setUserDraft(null);
      showSuccess(auditRefreshed ? "用户已保存" : "用户已保存，但审计日志刷新失败");
    } catch (error) {
      showError(
        userDataSaved
          ? `用户资料已保存，但密码处理失败: ${(error as Error).message}`
          : `用户保存失败: ${(error as Error).message}`
      );
    } finally {
      setSavingUser(false);
    }
  };

  const testFunasr = async () => {
    setFunasrStatus("idle");
    setFunasrDiagnostics(null);
    try {
      const data = await requestJson<{ diagnostics?: AsrDiagnostics }>("/api/admin/test-asr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerType: funasrProvider,
          endpoint: funasrUrl,
          apiKey: funasrApiKey,
          workspaceId: funasrWorkspaceId,
        }),
      });
      setFunasrDiagnostics((data.diagnostics ?? null) as AsrDiagnostics | null);
      setFunasrStatus("ok");
      showSuccess("ASR 连接测试通过");
    } catch (error) {
      setFunasrStatus("fail");
      if (error instanceof ApiRequestError) {
        setFunasrDiagnostics((error.data?.diagnostics ?? null) as AsrDiagnostics | null);
      }
      showError(`ASR 测试失败: ${(error as Error).message}`);
    }
  };

  const testLlm = async () => {
    setLlmStatus("idle");
    try {
      await requestJson("/api/admin/test-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: llmUrl,
          apiKey: llmKey,
          model: llmModel,
        }),
      });
      setLlmStatus("ok");
      showSuccess("LLM 调用测试通过");
    } catch (error) {
      setLlmStatus("fail");
      showError(`LLM 测试失败: ${(error as Error).message}`);
    }
  };

  const testMail = async () => {
    setMailStatus("idle");
    try {
      await requestJson("/api/admin/test-mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smtpHost: mailHost,
          smtpPort: mailPort,
          smtpUsername: mailUser,
          smtpPassword: mailPassword,
        }),
      });
      setMailStatus("ok");
      showSuccess("邮件连接测试通过");
    } catch (error) {
      setMailStatus("fail");
      showError(`邮件测试失败: ${(error as Error).message}`);
    }
  };

  if (authLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-slate-50">
        <div className="rounded-xl border border-slate-200 bg-white px-8 py-6 text-sm text-slate-500 shadow-sm">
          正在验证管理员权限...
        </div>
      </div>
    );
  }

  if (!currentUser || !currentUser.roles.includes("system_admin")) {
    return (
      <div className="flex flex-1 items-center justify-center bg-slate-50 p-6">
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="text-lg font-semibold text-slate-800">无权限访问</div>
          <p className="mt-2 text-sm text-slate-500">当前账号不是系统管理员，无法访问管理后台。</p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-dark"
          >
            返回主界面
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-slate-50">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <SectionTabs value={activeTab} onChange={setActiveTab} />

        {notice && (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              notice.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {notice.text}
          </div>
        )}

        {loading && (
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500 shadow-sm">
            正在加载后台配置...
          </div>
        )}

        {!loading && activeTab === "asr" && (
          <Card title="FunASR 配置" icon="🔌">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-slate-500">提供方</label>
                <select value={funasrProvider} onChange={(e) => setFunasrProvider(e.target.value)} className={inputCls}>
                  <option value="local_funasr">local_funasr</option>
                  <option value="dashscope">dashscope</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">端点地址</label>
                <input value={funasrUrl} onChange={(e) => setFunasrUrl(e.target.value)} className={inputCls} placeholder="ws://host:port/ws" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">ASR API Key</label>
                <input type="password" value={funasrApiKey} onChange={(e) => setFunasrApiKey(e.target.value)} className={inputCls} placeholder="留空保持已保存值" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Workspace ID</label>
                <input value={funasrWorkspaceId} onChange={(e) => setFunasrWorkspaceId(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="space-y-1">
                <StatusBadge status={funasrStatus} />
                <p className="text-xs text-slate-400">新配置只对新建录音连接生效。</p>
              </div>
              <button onClick={testFunasr} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                测试连接
              </button>
            </div>
            {funasrDiagnostics && (
              <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <div className="grid gap-1 md:grid-cols-2">
                  <div>
                    <span className="font-medium">provider:</span> {funasrDiagnostics.providerType}
                  </div>
                  <div>
                    <span className="font-medium">target:</span> {funasrDiagnostics.targetUrl || "(empty)"}
                  </div>
                  <div>
                    <span className="font-medium">input:</span> {funasrDiagnostics.inputEndpoint || "(empty)"}
                  </div>
                  <div>
                    <span className="font-medium">apiKey:</span> {funasrDiagnostics.hasApiKey ? "present" : "missing"}
                  </div>
                </div>
                <div className="mt-2 overflow-x-auto rounded border border-slate-200 bg-white">
                  <table className="w-full min-w-[560px] border-collapse text-left">
                    <thead className="bg-slate-100 text-slate-500">
                      <tr>
                        <th className="px-2 py-1 font-medium">step</th>
                        <th className="px-2 py-1 font-medium">status</th>
                        <th className="px-2 py-1 font-medium">ms</th>
                        <th className="px-2 py-1 font-medium">detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funasrDiagnostics.steps.map((step) => (
                        <tr key={step.step} className="border-t border-slate-100">
                          <td className="px-2 py-1 font-mono">{step.step}</td>
                          <td className={step.ok ? "px-2 py-1 text-emerald-600" : "px-2 py-1 text-red-600"}>
                            {step.ok ? "ok" : "fail"}
                          </td>
                          <td className="px-2 py-1 font-mono">{step.elapsedMs ?? "-"}</td>
                          <td className="px-2 py-1 font-mono">{step.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="mt-3">
              <button onClick={saveSettings} className={btnCls} disabled={savingSettings}>
                {savingSettings ? "保存中..." : "保存 ASR 配置"}
              </button>
            </div>
          </Card>
        )}

        {!loading && activeTab === "llm" && (
          <Card title="LLM 配置" icon="🤖">
            <label className="mb-1 block text-xs text-slate-500">端点地址</label>
            <input value={llmUrl} onChange={(e) => setLlmUrl(e.target.value)} className={inputCls} placeholder="http://host:port/v1" />
            <label className="mb-1 mt-3 block text-xs text-slate-500">API Key</label>
            <input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} className={inputCls} placeholder="留空保持已保存值" />
            <label className="mb-1 mt-3 block text-xs text-slate-500">模型名称</label>
            <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} className={inputCls} />
            <label className="mb-1 mt-3 block text-xs text-slate-500">上下文大小（字符，留空不截断）</label>
            <input type="number" min="1" step="1" value={llmContextSize} onChange={(e) => setLlmContextSize(e.target.value)} className={inputCls} placeholder="留空 = 不截断" />
            <label className="mb-1 mt-3 block text-xs text-slate-500">最大回复 Tokens（留空由 LLM 决定）</label>
            <input type="number" min="1" step="1" value={llmMaxTokens} onChange={(e) => setLlmMaxTokens(e.target.value)} className={inputCls} placeholder="留空 = 由 LLM 决定" />
            <label className="mb-1 mt-3 block text-xs text-slate-500">调用超时（毫秒，留空默认 180000）</label>
            <input type="number" min="1" step="1" value={llmTimeoutMs} onChange={(e) => setLlmTimeoutMs(e.target.value)} className={inputCls} placeholder="留空 = 180000" />
            <div className="mt-3 flex items-center justify-between">
              <StatusBadge status={llmStatus} />
              <button onClick={testLlm} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                测试 API
              </button>
            </div>
            <div className="mt-3">
              <button onClick={saveSettings} className={btnCls} disabled={savingSettings}>
                {savingSettings ? "保存中..." : "保存 LLM 配置"}
              </button>
            </div>
          </Card>
        )}

        {!loading && activeTab === "mail" && (
          <Card title="邮件配置" icon="📮">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-slate-500">SMTP Host</label>
                <input value={mailHost} onChange={(e) => setMailHost(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">SMTP Port</label>
                <input value={mailPort} onChange={(e) => setMailPort(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">SMTP Username</label>
                <input value={mailUser} onChange={(e) => setMailUser(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">SMTP Password</label>
                <input type="password" value={mailPassword} onChange={(e) => setMailPassword(e.target.value)} className={inputCls} placeholder="留空保持已保存值" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">发件人名称</label>
                <input value={mailFromName} onChange={(e) => setMailFromName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">发件人邮箱</label>
                <input value={mailFromEmail} onChange={(e) => setMailFromEmail(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="space-y-1">
                <StatusBadge status={mailStatus} />
                <p className="text-xs text-slate-400">建议先保存后再执行测试发送。</p>
              </div>
              <button onClick={testMail} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                测试发送
              </button>
            </div>
            <div className="mt-3">
              <button onClick={saveSettings} className={btnCls} disabled={savingSettings}>
                {savingSettings ? "保存中..." : "保存邮件配置"}
              </button>
            </div>
          </Card>
        )}

        {!loading && activeTab === "templates" && (
          <Card title="模板管理" icon="📝">
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              模板是独立资源，不再使用单个系统提示词文本框维护。默认模板通过列表中的“设为默认”操作选择。
            </div>
            <div className="space-y-3">
              {templates.map((template) => (
                <div key={template.id} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-800">{template.templateName}</h3>
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{template.templateType}</span>
                      <span className={`rounded px-2 py-0.5 text-xs ${template.status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}>
                        {template.status === "active" ? "启用中" : "已停用"}
                      </span>
                      {defaultTemplateId === template.id && (
                        <span className="rounded bg-brand/10 px-2 py-0.5 text-xs text-brand">默认模板</span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveTemplate(template)}
                        className="rounded-md border border-brand bg-brand px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-dark"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => saveDefaultTemplate(template.id)}
                        className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                          defaultTemplateId === template.id
                            ? "cursor-default border-slate-200 bg-slate-100 text-slate-400"
                            : "border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-100"
                        }`}
                        disabled={savingSettings || defaultTemplateId === template.id}
                      >
                        {defaultTemplateId === template.id ? "已默认" : "设为默认"}
                      </button>
                      <button
                        onClick={() => toggleTemplateStatus(template)}
                        className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                          template.status === "active"
                            ? "border-rose-500 bg-rose-50 text-rose-700 hover:bg-rose-100"
                            : "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        }`}
                      >
                        {template.status === "active" ? "停用" : "启用"}
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <input
                      value={template.templateName}
                      onChange={(e) =>
                        setTemplates((prev) =>
                          prev.map((item) =>
                            item.id === template.id ? { ...item, templateName: e.target.value } : item
                          )
                        )
                      }
                      className={inputCls}
                    />
                    <input
                      value={template.description}
                      onChange={(e) =>
                        setTemplates((prev) =>
                          prev.map((item) =>
                            item.id === template.id ? { ...item, description: e.target.value } : item
                          )
                        )
                      }
                      className={inputCls}
                    />
                  </div>
                  <textarea
                    value={template.content}
                    onChange={(e) =>
                      setTemplates((prev) =>
                        prev.map((item) =>
                          item.id === template.id ? { ...item, content: e.target.value } : item
                        )
                      )
                    }
                    rows={6}
                    className={`${inputCls} mt-3 font-mono leading-relaxed`}
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={createTemplate} className={btnCls}>新增模板</button>
            </div>
          </Card>
        )}

        {!loading && activeTab === "hotwords" && (
          <Card title="热词管理" icon="🔥">
            <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
              热词会在新建 FunASR WebSocket 连接时被拼装进首帧 `hotwords` JSON。这里只维护管理员热词表，主页面不再单独编辑热词。
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">热词</th>
                    <th className="px-3 py-2 font-medium">权重</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 font-medium">备注</th>
                    <th className="px-3 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {hotwords.map((word) => (
                    <tr key={word.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">
                        <input
                          value={word.term}
                          onChange={(e) =>
                            setHotwords((prev) =>
                              prev.map((item) =>
                                item.id === word.id ? { ...item, term: e.target.value } : item
                              )
                            )
                          }
                          className="w-40 rounded border border-slate-200 px-2 py-1 text-sm outline-none focus:border-brand"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={word.weight}
                          onChange={(e) =>
                            setHotwords((prev) =>
                              prev.map((item) =>
                                item.id === word.id ? { ...item, weight: Number(e.target.value) || 1 } : item
                              )
                            )
                          }
                          className="w-20 rounded border border-slate-200 px-2 py-1 text-sm outline-none focus:border-brand"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() =>
                            setHotwords((prev) =>
                              prev.map((item) =>
                                item.id === word.id
                                  ? { ...item, status: item.status === "active" ? "disabled" : "active" }
                                  : item
                              )
                            )
                          }
                          className={`rounded px-2 py-1 text-xs ${word.status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"}`}
                        >
                          {word.status === "active" ? "启用中" : "已停用"}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          value={word.note}
                          onChange={(e) =>
                            setHotwords((prev) =>
                              prev.map((item) =>
                                item.id === word.id ? { ...item, note: e.target.value } : item
                              )
                            )
                          }
                          className="w-40 rounded border border-slate-200 px-2 py-1 text-sm outline-none focus:border-brand"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-3">
                          <button onClick={() => saveHotword(word)} className="text-slate-500 hover:text-slate-700">
                            保存
                          </button>
                          <button onClick={() => removeHotword(word.id)} className="text-red-500 hover:text-red-700">
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={createHotword} className={btnCls}>新增热词</button>
            </div>
          </Card>
        )}

        {!loading && activeTab === "users" && (
          <>
            <Card title="用户与权限" icon="👥">
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                当前为极简 RBAC：只维护用户与固定角色，不在本轮启用复杂权限策略。
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">账号</th>
                      <th className="px-3 py-2 font-medium">姓名</th>
                      <th className="px-3 py-2 font-medium">邮箱</th>
                      <th className="px-3 py-2 font-medium">部门</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">角色</th>
                      <th className="px-3 py-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                          暂无用户
                        </td>
                      </tr>
                    ) : (
                      users.map((user) => (
                        <tr key={user.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-700">
                            <div className="font-medium">{user.accountName}</div>
                            {user.id === "user-admin" && (
                              <div className="mt-1 text-[11px] text-slate-400">bootstrap admin</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-600">{user.displayName || "-"}</td>
                          <td className="px-3 py-2 text-slate-600">{user.email || "-"}</td>
                          <td className="px-3 py-2 text-slate-600">{user.department || "-"}</td>
                          <td className="px-3 py-2">
                            <span className={`rounded px-2 py-0.5 text-xs ${
                              user.status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"
                            }`}>
                              {user.status === "active" ? "启用" : "停用"}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {user.roles.map((role) => (
                                <span key={role.id} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                                  {role.roleName}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <button onClick={() => openEditUser(user)} className="text-sky-600 hover:text-sky-800">
                              编辑
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-3">
                <button onClick={openCreateUser} className={btnCls}>新增用户</button>
              </div>
            </Card>

            {userModal && userDraft && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
                onClick={closeUserModal}
              >
                <div
                  className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg"
                  onClick={(event) => event.stopPropagation()}
                >
                  <h3 className="mb-4 text-base font-semibold text-slate-800">
                    {userModal.mode === "edit" ? "编辑用户" : "新增用户"}
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">账号</label>
                      <input
                        value={userDraft.accountName}
                        disabled={userModal.mode === "edit" && userModal.user.id === "user-admin"}
                        onChange={(event) => setUserDraft((prev) => prev ? { ...prev, accountName: event.target.value } : prev)}
                        className={`${inputCls} disabled:bg-slate-100 disabled:text-slate-500`}
                        placeholder="登录账号"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">姓名</label>
                      <input
                        value={userDraft.displayName}
                        onChange={(event) => setUserDraft((prev) => prev ? { ...prev, displayName: event.target.value } : prev)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">邮箱</label>
                      <input
                        type="email"
                        value={userDraft.email}
                        onChange={(event) => setUserDraft((prev) => prev ? { ...prev, email: event.target.value } : prev)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">部门</label>
                      <input
                        value={userDraft.department}
                        onChange={(event) => setUserDraft((prev) => prev ? { ...prev, department: event.target.value } : prev)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">
                        密码{userModal.mode === "create" ? "（初始密码，至少 8 位）" : "（留空则不修改）"}
                      </label>
                      <input
                        type="password"
                        value={userDraft.password}
                        onChange={(event) => setUserDraft((prev) => prev ? { ...prev, password: event.target.value } : prev)}
                        className={inputCls}
                        placeholder={userModal.mode === "create" ? "至少 8 位" : "留空则不修改"}
                        autoComplete="new-password"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">状态</label>
                      <select
                        value={userDraft.status}
                        disabled={userModal.mode === "edit" && userModal.user.id === "user-admin"}
                        onChange={(event) => setUserDraft((prev) => prev ? { ...prev, status: event.target.value } : prev)}
                        className={`${inputCls} disabled:bg-slate-100 disabled:text-slate-500`}
                      >
                        <option value="active">启用</option>
                        <option value="disabled">停用</option>
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">角色</label>
                      <div className="flex flex-wrap gap-2">
                        {roles.map((role) => {
                          const checked = userDraft.roleKeys.includes(role.roleKey);
                          const protectedRole = userModal.mode === "edit" && userModal.user.id === "user-admin" && role.roleKey === "system_admin";
                          return (
                            <label key={role.id} className="flex items-center gap-1 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={protectedRole}
                                onChange={() => toggleDraftRole(role.roleKey)}
                              />
                              {role.roleName}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="mt-5 flex justify-end gap-2">
                    <button
                      onClick={closeUserModal}
                      disabled={savingUser}
                      className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      取消
                    </button>
                    <button onClick={submitUserModal} disabled={savingUser} className={btnCls}>
                      {savingUser ? "保存中..." : userModal.mode === "edit" ? "保存" : "创建"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {!loading && activeTab === "audit" && (
          <Card title="审计日志" icon="🧾">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm text-slate-500">显示最近 100 条关键操作记录。</div>
              <button onClick={loadAuditLogs} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                刷新
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium">操作者</th>
                    <th className="px-3 py-2 font-medium">动作</th>
                    <th className="px-3 py-2 font-medium">资源</th>
                    <th className="px-3 py-2 font-medium">结果</th>
                    <th className="px-3 py-2 font-medium">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-400" colSpan={6}>
                        暂无审计记录
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="border-t border-slate-100">
                        <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                          {new Date(log.createdAt).toLocaleString("zh-CN")}
                        </td>
                        <td className="px-3 py-2 text-slate-700">
                          {log.actorDisplayName || log.actorAccountName}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-600">{log.actionType}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {log.resourceName || log.resourceId}
                          <span className="ml-2 text-xs text-slate-400">{log.resourceType}</span>
                        </td>
                        <td className={`px-3 py-2 ${log.result === "success" ? "text-emerald-600" : "text-red-600"}`}>
                          {log.result}
                        </td>
                        <td className="max-w-xs truncate px-3 py-2 text-red-500">
                          {log.errorMessage || "-"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );

}
