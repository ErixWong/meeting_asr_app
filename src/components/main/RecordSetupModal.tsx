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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-800">开始录音</h3>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭开始录音弹窗"
          >
            ×
          </button>
        </div>

        <div className="mt-4 space-y-4">
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

          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <div className="font-medium">采集说明：</div>
            <ul className="ml-4 list-disc">
              <li>🎤 麦克风：录制本地声音（你自己的发言）</li>
              <li>
                🔊 系统声音：录制扬声器播放的声音。网络会议中对方说话的声音在扬声器里，
                要采集对方的声音，请选择录制系统声音
              </li>
            </ul>
            {speakerEnabled && (
              <>
                <div className="mt-1 font-medium">系统声音开启：</div>
                <ol className="ml-4 list-decimal">
                  <li>开始录音时会弹出共享窗口</li>
                  <li>请选择「整个屏幕」（可采到所有应用的声音）</li>
                  <li>并确认共享声音</li>
                </ol>
              </>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-brand px-4 py-1.5 text-sm text-white hover:bg-brand-dark"
          >
            开始录音
          </button>
        </div>
      </div>
    </div>
  );
}
