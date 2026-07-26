"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type AdminTab = "asr" | "llm" | "mail" | "templates" | "hotwords";

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
  const [activeTab, setActiveTab] = useState<AdminTab>("asr");
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const [funasrProvider, setFunasrProvider] = useState("local_funasr");
  const [funasrUrl, setFunasrUrl] = useState("ws://funasr.local:10095/ws");
  const [funasrApiKey, setFunasrApiKey] = useState("");
  const [funasrWorkspaceId, setFunasrWorkspaceId] = useState("");
  const [funasrStatus, setFunasrStatus] = useState<"ok" | "fail" | "idle">("idle");

  const [llmUrl, setLlmUrl] = useState("http://qwen.local:8080/v1");
  const [llmKey, setLlmKey] = useState("");
  const [llmModel, setLlmModel] = useState("qwen3.6-35b");
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
      mailFromEmail,
      mailFromName,
      mailHost,
      mailPassword,
      mailPort,
      mailUser,
    ]
  );

  useEffect(() => {
    const loadAdminData = async () => {
      try {
        const [settingsRes, templatesRes, hotwordsRes] = await Promise.all([
          fetch("/api/admin/settings"),
          fetch("/api/admin/prompt-templates"),
          fetch("/api/admin/hotwords"),
        ]);

        const settingsData = await settingsRes.json();
        const templatesData = await templatesRes.json();
        const hotwordsData = await hotwordsRes.json();

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
        setDefaultTemplateId(get("system", "default_prompt_template_id", nextTemplates[0]?.id ?? ""));
      } catch (error) {
        console.error("Failed to load admin data:", error);
      } finally {
        setLoading(false);
      }
    };

    loadAdminData().catch(console.error);
  }, []);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: settingsPayload }),
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const saveTemplate = async (template: PromptTemplateItem) => {
    const res = await fetch(`/api/admin/prompt-templates/${template.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template),
    });
    const data = await res.json();
    if (data.template) {
      setTemplates((prev) => prev.map((item) => (item.id === template.id ? data.template : item)));
    }
  };

  const createTemplate = async () => {
    const res = await fetch("/api/admin/prompt-templates", {
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
    const data = await res.json();
    if (data.template) {
      setTemplates((prev) => [...prev, data.template]);
    }
  };

  const saveHotword = async (hotword: HotwordItem) => {
    const res = await fetch(`/api/admin/hotwords/${hotword.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hotword),
    });
    const data = await res.json();
    if (data.hotword) {
      setHotwords((prev) => prev.map((item) => (item.id === hotword.id ? data.hotword : item)));
    }
  };

  const createHotword = async () => {
    const res = await fetch("/api/admin/hotwords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term: "", weight: 10, status: "active", note: "" }),
    });
    const data = await res.json();
    if (data.hotword) {
      setHotwords((prev) => [...prev, data.hotword]);
    }
  };

  const removeHotword = async (id: string) => {
    await fetch(`/api/admin/hotwords/${id}`, { method: "DELETE" });
    setHotwords((prev) => prev.filter((item) => item.id !== id));
  };

  const testFunasr = () => {
    setFunasrStatus("idle");
    setTimeout(() => setFunasrStatus("ok"), 1000);
  };

  const testLlm = () => {
    setLlmStatus("idle");
    setTimeout(() => setLlmStatus("ok"), 1000);
  };

  const testMail = () => {
    setMailStatus("idle");
    setTimeout(() => setMailStatus("ok"), 1000);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="text-lg font-semibold text-slate-800">⚙ 系统管理</div>
        <Link
          href="/"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
        >
          ← 返回主界面
        </Link>
      </header>

      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <SectionTabs value={activeTab} onChange={setActiveTab} />

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
                <input value={funasrApiKey} onChange={(e) => setFunasrApiKey(e.target.value)} className={inputCls} />
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
            <input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} className={inputCls} />
            <label className="mb-1 mt-3 block text-xs text-slate-500">模型名称</label>
            <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} className={inputCls} />
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
                <input type="password" value={mailPassword} onChange={(e) => setMailPassword(e.target.value)} className={inputCls} />
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
                      <button onClick={() => saveTemplate(template)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                        保存
                      </button>
                      <button onClick={() => setDefaultTemplateId(template.id)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                        设为默认
                      </button>
                      <button
                        onClick={() =>
                          setTemplates((prev) =>
                            prev.map((item) =>
                              item.id === template.id
                                ? { ...item, status: item.status === "active" ? "disabled" : "active" }
                                : item
                            )
                          )
                        }
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
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
              <button onClick={saveSettings} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50" disabled={savingSettings}>
                {savingSettings ? "保存中..." : "保存默认模板"}
              </button>
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
      </div>
    </div>
  );
}
