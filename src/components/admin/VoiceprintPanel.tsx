"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getVoiceprintConfig,
  getVoiceprintSpeakers,
  registerVoiceprintSpeaker,
  deleteVoiceprintSpeaker,
  saveVoiceprintConfig,
  VoiceprintConfig,
  VoiceprintSpeaker,
  VoiceprintApiError,
} from "@/lib/voiceprint-api";

/** 服务端声纹管理（独立容器 funasr-voiceprint，端口 10097） */
export default function VoiceprintPanel() {
  const [config, setConfig] = useState<VoiceprintConfig | null>(null);
  const [speakers, setSpeakers] = useState<VoiceprintSpeaker[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [endpoint, setEndpoint] = useState("");
  const [threshold, setThreshold] = useState("0.35");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // 注册
  const [regName, setRegName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [uploading, setUploading] = useState(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const totalRef = useRef(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const showSuccess = (text: string) => setNotice({ type: "success", text });
  const showError = (text: string) => setNotice({ type: "error", text });

  const refresh = useCallback(async () => {
    try {
      const [configData, speakersData] = await Promise.all([
        getVoiceprintConfig(),
        getVoiceprintSpeakers(),
      ]);
      setConfig(configData);
      setEnabled(configData.enabled);
      setEndpoint(configData.endpoint);
      if (configData.threshold !== null) setThreshold(String(configData.threshold));
      setSpeakers(speakersData.speakers ?? []);
    } catch (error) {
      showError(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      // 卸载时停止录音，释放麦克风
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [refresh]);

  const testConnection = async () => {
    setTesting(true);
    try {
      const data = await getVoiceprintConfig();
      setConfig(data);
      if (data.threshold !== null) setThreshold(String(data.threshold));
      showSuccess(
        data.serviceReachable ? `连接正常：${data.serviceStatus ?? "ready"}` : "服务不可达，请检查声纹容器"
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const patch: { enabled?: boolean; endpoint?: string; threshold?: number } = {
        enabled,
        endpoint: endpoint.trim(),
      };
      const currentThreshold = Number(threshold);
      if (Number.isFinite(currentThreshold)) patch.threshold = currentThreshold;
      const result = await saveVoiceprintConfig(patch);
      await refresh();
      if (result.messages.some((message) => message.startsWith("threshold not updated"))) {
        showError("设置已保存，但阈值未同步到声纹服务（服务不可达？）");
      } else {
        showSuccess("配置已保存");
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // ---------------- 录音注册 ----------------

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      chunksRef.current = [];
      totalRef.current = 0;
      processor.onaudioprocess = (event) => {
        const data = new Float32Array(event.inputBuffer.getChannelData(0));
        chunksRef.current.push(data);
        totalRef.current += data.length;
        setRecSec(totalRef.current / 16000);
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      setRecording(true);
      setRecSec(0);
    } catch (error) {
      showError(`无法访问麦克风: ${(error as Error).message}`);
    }
  };

  const stopRecording = async () => {
    if (!recording) return;
    const stream = streamRef.current;
    const ctx = audioCtxRef.current;
    streamRef.current = null;
    audioCtxRef.current = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (ctx) {
      if (processorRef.current) {
        processorRef.current.onaudioprocess = null;
        processorRef.current.disconnect();
        processorRef.current = null;
      }
      await ctx.close().catch(() => {});
    }
    setRecording(false);

    const audio = concatChunks(chunksRef.current);
    chunksRef.current = [];
    if (audio.length < 16000 * 2) {
      showError("录音太短，请至少录 2 秒");
      return;
    }
    await doRegister(audio);
  };

  const handleFileUpload = async (file: File) => {
    setUploading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new AudioContext({ sampleRate: 16000 });
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      const audio = resampleTo16k(decoded);
      await ctx.close().catch(() => {});
      if (audio.length < 16000 * 2) {
        showError("音频太短，请至少提供 2 秒语音");
        return;
      }
      await doRegister(audio);
    } catch (error) {
      showError(`音频解码失败: ${(error as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const doRegister = async (audio: Float32Array) => {
    const name = regName.trim();
    if (!name) {
      showError("请先填写说话人姓名");
      return;
    }
    setRegistering(true);
    try {
      const result = await registerVoiceprintSpeaker(name, audio, 16000);
      showSuccess(
        result.samples > 1
          ? `${name} 已追加第 ${result.samples} 个样本（均值已更新）`
          : `${name} 已注册`
      );
      setRegName("");
      await refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "注册失败");
    } finally {
      setRegistering(false);
    }
  };

  const removeSpeaker = async (speaker: VoiceprintSpeaker) => {
    if (!window.confirm(`确定删除说话人「${speaker.name}」？其声纹将无法用于识别。`)) return;
    try {
      await deleteVoiceprintSpeaker(speaker.name);
      showSuccess(`已删除 ${speaker.name}`);
      await refresh();
    } catch (error) {
      showError(error instanceof Error ? error.message : "删除失败");
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
          <h3 className="text-sm font-semibold text-slate-700">声纹服务配置</h3>
          <button onClick={testConnection} disabled={testing} className={ghostBtnCls}>
            {testing ? "测试中..." : "测试连接"}
          </button>
        </div>
        <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={fieldLabel}>服务状态</label>
            <div className="text-sm">
              {loading ? (
                <span className="text-slate-400">加载中...</span>
              ) : config?.serviceReachable ? (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-emerald-600">正常</span>
                  <span className="text-slate-400">
                    （阈值 {config.threshold ?? "-"} · {config.serviceStatus ?? ""}）
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
                  <span className="text-red-600">不可达</span>
                  <span className="text-slate-400">{config?.serviceStatus ?? ""}</span>
                </span>
              )}
            </div>
          </div>
          <div>
            <label className={fieldLabel}>启用服务端声纹识别</label>
            <div className="flex items-center gap-2 pt-1">
              <button
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled((v) => !v)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                  enabled ? "bg-brand" : "bg-slate-300"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                    enabled ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </button>
              <span className="text-sm text-slate-500">
                {enabled ? "录音时自动识别说话人（命中则显示人名）" : "关闭后回退前端启发式聚类"}
              </span>
            </div>
          </div>
          <div>
            <label className={fieldLabel}>服务地址（endpoint）</label>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className={inputCls} placeholder="http://127.0.0.1:10097" />
          </div>
          <div>
            <label className={fieldLabel}>识别阈值（0~1，推荐 0.35）</label>
            <input
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className={inputCls}
              inputMode="decimal"
              placeholder="0.35"
            />
            <p className="mt-1 text-xs text-slate-400">
              越高越严格（误识少、漏识多）；同人相似度 ~0.7，异人 ~0.0
            </p>
          </div>
        </div>
        <button onClick={saveConfig} disabled={saving || loading} className={btnCls}>
          {saving ? "保存中..." : "保存配置"}
        </button>
      </div>

      {/* 注册新说话人 */}
      <div className={cardCls}>
        <h3 className="mb-4 text-sm font-semibold text-slate-700">注册说话人</h3>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className={fieldLabel}>姓名</label>
            <input
              value={regName}
              onChange={(e) => setRegName(e.target.value)}
              className={inputCls}
              placeholder="例如：张三"
              maxLength={64}
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={registering || uploading}
              className={`${ghostBtnCls} ${
                recording
                  ? "border-red-300 bg-red-50 text-red-600 hover:bg-red-100"
                  : ""
              }`}
            >
              {recording ? `停止录音（${recSec.toFixed(1)}s）` : "🎙 麦克风录音"}
            </button>
            <label className={`${ghostBtnCls} cursor-pointer`}>
              {uploading ? "解析中..." : "📁 上传音频"}
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                disabled={uploading || recording || registering}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFileUpload(file);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          建议每人录 2~3 段 ≥2 秒语音（或上传不同环境录音），注册多段后系统取均值声纹，识别更稳。
        </p>
      </div>

      {/* 说话人列表 */}
      <div className={cardCls}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">说话人列表（{speakers.length}）</h3>
          <button onClick={() => void refresh()} className={ghostBtnCls}>
            刷新
          </button>
        </div>
        {speakers.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-400">
            暂无注册说话人。录音或上传音频注册后，转写将显示对应人名。
          </p>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="px-2 py-2 font-medium">姓名</th>
                <th className="px-2 py-2 font-medium">样本数</th>
                <th className="px-2 py-2 font-medium">首次注册</th>
                <th className="px-2 py-2 font-medium">最近更新</th>
                <th className="px-2 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {speakers.map((speaker) => (
                <tr key={speaker.name} className="border-b border-slate-100">
                  <td className="px-2 py-2 font-medium text-slate-700">{speaker.name}</td>
                  <td className="px-2 py-2 text-slate-600">{speaker.samples}</td>
                  <td className="px-2 py-2 text-xs text-slate-400">
                    {formatDateTime(speaker.createdAt)}
                  </td>
                  <td className="px-2 py-2 text-xs text-slate-400">
                    {formatDateTime(speaker.updatedAt)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => void removeSpeaker(speaker)}
                      className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 解码后 AudioBuffer（任意采样率）线性插值重采样到 16k 单声道 */
function resampleTo16k(buffer: AudioBuffer): Float32Array {
  const sourceRate = buffer.sampleRate;
  const targetRate = 16000;
  const input = buffer.getChannelData(0);
  if (sourceRate === targetRate) {
    return new Float32Array(input);
  }
  const ratio = sourceRate / targetRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = Math.min(index + 1, input.length - 1);
    output[i] = input[index] * (1 - fraction) + input[next] * fraction;
  }
  return output;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}
