"use client";

import { AudioDevice } from "@/types";

interface Props {
  devices: AudioDevice[];
  micDeviceId: string | null;
  onMicChange: (deviceId: string | null) => void;
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

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm text-slate-500">采集</span>
      <label className="flex items-center gap-1 text-sm text-slate-600">
        🎤 麦克风
        <select
          value={micDeviceId ?? ""}
          onChange={(e) => onMicChange(e.target.value || null)}
          disabled={disabled}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
        >
          <option value="">{NO_RECORDING}</option>
          {mics.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-sm text-slate-600">
        🔊 系统声音
        <select
          value={speakerEnabled ? "speaker" : ""}
          onChange={(e) => onSpeakerChange(e.target.value === "speaker")}
          disabled={disabled}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
        >
          <option value="">{NO_RECORDING}</option>
          <option value="speaker">系统声音</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-sm text-slate-600">
        🌐 语种
        <select
          value={asrLang}
          onChange={(e) => onLangChange(e.target.value)}
          disabled={disabled}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
        >
          {ASR_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-sm text-slate-600" title={sameAsSource ? "目标语言与识别语种相同，翻译不可用" : undefined}>
        <input
          type="checkbox"
          checked={translationEnabled && !sameAsSource}
          onChange={(e) => onTranslationChange(e.target.checked)}
          disabled={disabled || sameAsSource}
          className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand disabled:opacity-60"
        />
        自动翻译
        <select
          value={targetLang}
          onChange={(e) => onTargetLangChange(e.target.value)}
          disabled={disabled || sameAsSource}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
        >
          {TRANSLATE_LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
