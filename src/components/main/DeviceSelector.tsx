"use client";

import { AudioDevice } from "@/types";

interface Props {
  devices: AudioDevice[];
  micDeviceId: string | null;
  onMicChange: (deviceId: string | null) => void;
  onRequestMicRefresh: () => void;
  micRefreshing?: boolean;
  speakerEnabled: boolean;
  onSpeakerChange: (enabled: boolean) => void;
  asrLang: string;
  onLangChange: (lang: string) => void;
  translationEnabled: boolean;
  onTranslationChange: (enabled: boolean) => void;
  targetLang: string;
  onTargetLangChange: (lang: string) => void;
  disabled?: boolean;
}

const NO_RECORDING = "不录音";

const ASR_LANGUAGES = [
  { value: "auto", label: "自动检测" },
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "yue", label: "粤语" },
];

const TRANSLATE_LANGUAGES = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
];

export default function DeviceSelector({
  devices,
  micDeviceId,
  onMicChange,
  onRequestMicRefresh,
  micRefreshing = false,
  speakerEnabled,
  onSpeakerChange,
  asrLang,
  onLangChange,
  translationEnabled,
  onTranslationChange,
  targetLang,
  onTargetLangChange,
  disabled = false,
}: Props) {
  const mics = devices.filter((d) => d.deviceId !== "speaker");
  const sameAsSource = asrLang !== "auto" && asrLang === targetLang;

  const fieldCls =
    "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60";

  return (
    <div className="space-y-4">
      {/* 麦克风 */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-500">麦克风 · 录制你的发言</label>
        <div className="flex gap-2">
          <select
            value={micDeviceId ?? ""}
            onChange={(e) => onMicChange(e.target.value || null)}
            onMouseDown={() => onRequestMicRefresh()}
            onFocus={() => onRequestMicRefresh()}
            disabled={disabled}
            className={fieldCls}
          >
            <option value="">{NO_RECORDING}</option>
            {mics.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onRequestMicRefresh}
            disabled={disabled || micRefreshing}
            title="刷新/授权后重新读取麦克风设备"
            className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {micRefreshing ? "…" : "🔄"}
          </button>
        </div>
      </div>

      {/* 系统声音 */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-500">系统声音 · 录制扬声器播放内容</label>
        <select
          value={speakerEnabled ? "speaker" : ""}
          onChange={(e) => onSpeakerChange(e.target.value === "speaker")}
          disabled={disabled}
          className={fieldCls}
        >
          <option value="">{NO_RECORDING}</option>
          <option value="speaker">系统声音</option>
        </select>
      </div>

      {/* 识别语种 */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-500">识别语种</label>
        <select
          value={asrLang}
          onChange={(e) => onLangChange(e.target.value)}
          disabled={disabled}
          className={fieldCls}
        >
          {ASR_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      {/* 自动翻译 */}
      <div>
        <label
          className="flex cursor-pointer items-center justify-between gap-2 text-xs font-medium text-slate-500"
          title={sameAsSource ? "目标语言与识别语种相同，勾选后将自动切换" : undefined}
        >
          <span className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={translationEnabled}
              onChange={(e) => onTranslationChange(e.target.checked)}
              disabled={disabled}
              className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
            />
            自动翻译
          </span>
          <select
            value={targetLang}
            onChange={(e) => onTargetLangChange(e.target.value)}
            disabled={disabled}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-600 shadow-sm outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {TRANSLATE_LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
