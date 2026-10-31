"use client";

import { useCallback, useEffect, useState } from "react";

/** OpenAI 官方标准音色（标准协议无列表 API，预置官方 6 个；国产兼容服务音色名可能不同，可自定义） */
const OPENAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

/** 服务端 TTS 配置（tts-gateway 段：provider / endpoint / model / default_voice） */
export default function TtsPanel() {
  const [provider, setProvider] = useState("cosyvoice");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [defaultVoice, setDefaultVoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<{ ok: boolean; detail?: string } | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const showSuccess = (text: string) => setNotice({ type: "success", text });
  const showError = (text: string) => setNotice({ type: "error", text });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings");
      const data = (await res.json()) as {
        settings?: Array<{ itemSection: string; itemMark: string; itemValue: string }>;
      };
      const settings = data.settings ?? [];
      const get = (section: string, mark: string, fallback = "") =>
        settings.find((item) => item.itemSection === section && item.itemMark === mark)?.itemValue ?? fallback;
      setProvider(get("tts", "provider", "cosyvoice"));
      setEndpoint(get("tts", "endpoint", "http://localhost:8010"));
      setModel(get("tts", "model", ""));
      setDefaultVoice(get("tts", "default_voice", "中文女"));
      // 自动拉取 CosyVoice 容器音色列表（下拉数据源，cosyvoice 协议实时从 /voices 获取；openai 协议返回空）
      fetch("/api/tts/voices")
        .then((r) => r.json())
        .then((d) => {
          const list = Array.isArray(d) ? d : d.voices ?? [];
          setVoices(list.map(String));
        })
        .catch(() => {});
    } catch (error) {
      showError(`加载配置失败: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const testConnection = async () => {
    setTesting(true);
    setHealth(null);
    try {
      const [healthRes, voicesRes] = await Promise.all([
        fetch("/api/tts/health"),
        fetch("/api/tts/voices"),
      ]);
      const healthData = (await healthRes.json()) as { ok?: boolean; container?: { error?: string } };
      const voicesData = (await voicesRes.json()) as { voices?: string[] } | string[];
      const list = Array.isArray(voicesData) ? voicesData : voicesData.voices ?? [];
      setVoices(list.map(String));
      const ok = Boolean(healthData.ok);
      setHealth({ ok, detail: ok ? undefined : healthData.container?.error });
      if (ok) {
        showSuccess(
          provider === "openai"
            ? `连接正常：OpenAI 兼容服务可达（音色列表取决于服务商，未拉取）`
            : `连接正常：${list.length} 个可用音色`
        );
      } else {
        showError(
          provider === "openai"
            ? "OpenAI 兼容服务不可达，请检查 endpoint 是否指向标准 /v1/audio/speech 服务"
            : "TTS 容器不可达，请检查服务是否启动（建议 http://localhost:8010）"
        );
      }
    } catch (error) {
      setHealth({ ok: false, detail: (error as Error).message });
      showError(`连接测试失败: ${(error as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: [
            {
              itemSection: "tts",
              itemMark: "provider",
              itemTitle: "TTS 协议",
              itemDescription: "cosyvoice 私有协议 / openai 标准协议",
              itemValue: provider.trim(),
            },
            {
              itemSection: "tts",
              itemMark: "endpoint",
              itemTitle: "TTS 服务地址",
              itemDescription: "CosyVoice 容器或 OpenAI 兼容服务地址（10 秒缓存生效）",
              itemValue: endpoint.trim(),
            },
            {
              itemSection: "tts",
              itemMark: "model",
              itemTitle: "TTS 模型",
              itemDescription: "OpenAI 兼容服务的模型名，cosyvoice 协议下忽略",
              itemValue: model.trim(),
            },
            {
              itemSection: "tts",
              itemMark: "default_voice",
              itemTitle: "默认音色",
              itemDescription: "未指定音色且无法自动识别语言时使用",
              itemValue: defaultVoice.trim(),
            },
          ],
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      showSuccess("TTS 配置已保存（约 10 秒后生效）");
    } catch (error) {
      showError(`保存失败: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand";
  const btnCls =
    "rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60";
  const ghostBtnCls =
    "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";
  const cardCls = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm";
  const fieldLabel = "mb-1 block text-xs text-slate-500";

  return (
    <div className="space-y-5">
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

      {/* 服务配置 */}
      <div className={cardCls}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">TTS 服务配置</h3>
          <button onClick={testConnection} disabled={testing || loading} className={ghostBtnCls}>
            {testing ? "测试中..." : "测试连接"}
          </button>
        </div>
        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={fieldLabel}>协议（provider）</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className={inputCls}
            >
              <option value="cosyvoice">cosyvoice（私有协议，本地 CosyVoice 容器）</option>
              <option value="openai">openai（OpenAI 兼容标准协议 /v1/audio/speech）</option>
            </select>
            <p className="mt-1 text-xs text-slate-400">
              openai 协议可对接任意 OpenAI 兼容 TTS（官方 / OneAPI 中转 / 国产服务）
            </p>
          </div>
          <div>
            <label className={fieldLabel}>服务地址（endpoint）</label>
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              className={inputCls}
              placeholder={
                provider === "openai" ? "https://api.openai.com/v1" : "http://localhost:8010"
              }
            />
            <p className="mt-1 text-xs text-slate-400">
              {provider === "openai"
                ? "OpenAI 兼容服务根地址（网关自动拼接 /v1/audio/speech）"
                : "本地 CosyVoice 容器（默认 http://localhost:8010）"}
            </p>
          </div>
          {provider === "openai" && (
            <div>
              <label className={fieldLabel}>模型（model）</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={inputCls}
                placeholder="tts-1 / gpt-4o-mini-tts"
              />
              <p className="mt-1 text-xs text-slate-400">服务商支持的 TTS 模型名，如 tts-1</p>
            </div>
          )}
          <div>
            <label className={fieldLabel}>默认音色</label>
            <VoiceSelect
              provider={provider}
              containerVoices={voices}
              value={defaultVoice}
              onChange={setDefaultVoice}
            />
            <p className="mt-1 text-xs text-slate-400">
              {provider === "openai"
                ? "OpenAI 官方 6 个标准音色；国产兼容服务音色名不同时可选择「自定义…」手填"
                : "下拉为 CosyVoice 容器实际音色（测试连接后刷新）；语音对话按回复语言自动切换，识别失败才用此默认值"}
            </p>
          </div>
        </div>

        {/* 连接状态 */}
        <div className="mb-4 rounded-lg border border-slate-200 p-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">容器状态：</span>
            {health === null ? (
              <span className="text-slate-400">{loading ? "加载中..." : "未测试"}</span>
            ) : health.ok ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-600">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                正常
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-red-600">
                <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                不可达
              </span>
            )}
            {health?.detail && <span className="text-xs text-slate-400">{health.detail}</span>}
          </div>
          {voices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {voices.map((voice) => (
                <span key={voice} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {voice}
                </span>
              ))}
            </div>
          )}
        </div>

        <button onClick={saveConfig} disabled={saving || loading} className={btnCls}>
          {saving ? "保存中..." : "保存配置"}
        </button>
      </div>

      {/* 使用说明 */}
      <div className={cardCls}>
        <h3 className="mb-3 text-sm font-semibold text-slate-700">说明</h3>
        <ul className="list-inside list-disc space-y-1.5 text-sm text-slate-500">
          <li>协议：cosyvoice = 本地 CosyVoice 容器（逐句合成 + 按语言自动选音色）；openai = 任意 OpenAI 兼容 TTS（整段合成，音色固定用默认值）。</li>
          <li>OpenAI 标准协议没有音色列表 API，下拉为官方 6 个标准音色，服务商音色不同可选「自定义…」手填。</li>
          <li>配置保存后约 10 秒生效（tts-gateway 缓存）。</li>
          <li>服务不可用时对话仍可进行，仅语音合成失败（消息旁会标注），不影响文字回复。</li>
        </ul>
      </div>
    </div>
  );
}

/**
 * 默认音色下拉：cosyvoice 用容器实际音色列表；openai 用官方标准音色。
 * 当前值不在候选列表时自动落到「自定义…」并显示输入框手填（兼容国产服务自定义音色名）。
 */
function VoiceSelect({
  provider,
  containerVoices,
  value,
  onChange,
}: {
  provider: string;
  containerVoices: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const options = provider === "openai" ? OPENAI_VOICES : containerVoices;
  const current = value.trim();
  const known = options.includes(current);
  const selectValue = known ? current : "__custom__";

  const selectCls =
    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand";

  return (
    <div className="space-y-1.5">
      <select
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === "__custom__") return; // 保持当前值，输入框接管
          onChange(e.target.value);
        }}
        className={selectCls}
      >
        {options.length === 0 && (
          <option value="__custom__" disabled>
            {provider === "openai" ? "（无音色选项）" : "（先测试连接拉取音色列表）"}
          </option>
        )}
        {options.map((voice) => (
          <option key={voice} value={voice}>
            {voice}
          </option>
        ))}
        {options.length > 0 && <option value="__custom__">自定义…</option>}
      </select>
      {!known && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          placeholder={provider === "openai" ? "输入自定义音色名（如 dashvoice）" : "输入自定义音色名"}
        />
      )}
    </div>
  );
}
