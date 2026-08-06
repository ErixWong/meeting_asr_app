"use client";

import { AudioDevice } from "@/types";

interface Props {
  devices: AudioDevice[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export default function DeviceSelector({ devices, selected, onChange, disabled = false }: Props) {
  const mics = devices.filter((d) => d.deviceId !== "speaker");
  const speakerSelected = selected.includes("speaker");

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((item) => item !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-sm text-slate-500">采集</span>
      {mics.map((device) => (
        <label
          key={device.deviceId}
          className="flex cursor-pointer items-center gap-1 text-sm text-slate-600"
        >
          <input
            type="checkbox"
            checked={selected.includes(device.deviceId)}
            onChange={() => toggle(device.deviceId)}
            disabled={disabled}
            className="accent-brand"
          />
          🎤 {device.label}
        </label>
      ))}
      <label className="flex cursor-pointer items-center gap-1 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={speakerSelected}
          onChange={() => toggle("speaker")}
          disabled={disabled}
          className="accent-brand"
        />
        🔊 系统声音
      </label>
      {speakerSelected && (
        <span className="text-xs text-amber-600">
          开始录音时会弹出共享窗口，请选择「整个屏幕」（可采到所有应用的声音）并确认共享声音
        </span>
      )}
    </div>
  );
}
