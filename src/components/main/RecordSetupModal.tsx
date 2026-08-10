"use client";

import { AudioDevice } from "@/types";
import DeviceSelector from "./DeviceSelector";

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
  onClose: () => void;
  onConfirm: () => void;
}

export default function RecordSetupModal({
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
  onClose,
  onConfirm,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-y-auto rounded-2xl border border-slate-100 bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand/10 text-lg">
              🎙️
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">开始录音</h3>
              <p className="text-xs text-slate-400">设置采集方式后开始录制会议</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭开始录音弹窗"
          >
            ×
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <DeviceSelector
            devices={devices}
            micDeviceId={micDeviceId}
            onMicChange={onMicChange}
            onRequestMicRefresh={onRequestMicRefresh}
            micRefreshing={micRefreshing}
            speakerEnabled={speakerEnabled}
            onSpeakerChange={onSpeakerChange}
            asrLang={asrLang}
            onLangChange={onLangChange}
            translationEnabled={translationEnabled}
            onTranslationChange={onTranslationChange}
            targetLang={targetLang}
            onTargetLangChange={onTargetLangChange}
          />

          <div className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-relaxed text-slate-500">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-slate-600">
              <span className="text-slate-400">ℹ</span> 采集说明
            </div>
            <ul className="ml-1 space-y-1">
              <li>
                <span className="text-slate-600">🎤 麦克风</span>
                ：录制本地声音（你自己的发言）
              </li>
              <li>
                <span className="text-slate-600">🔊 系统声音</span>
                ：录制扬声器播放的内容。要采集对方的声音，请选择系统声音
              </li>
            </ul>
            {speakerEnabled && (
              <>
                <div className="mt-2 mb-1 font-medium text-slate-600">系统声音开启：</div>
                <ol className="ml-1 list-decimal space-y-0.5 pl-4">
                  <li>开始录音时会弹出共享窗口</li>
                  <li>请选择「整个屏幕」（可采到所有应用的声音）</li>
                  <li>并确认共享声音</li>
                </ol>
              </>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 transition-colors hover:bg-slate-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-dark"
          >
            开始录音
          </button>
        </div>
      </div>
    </div>
  );
}
