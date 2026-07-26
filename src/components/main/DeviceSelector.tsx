"use client";

import { AudioDevice } from "@/types";

interface Props {
  devices: AudioDevice[];
  value: string;
  onChange: (id: string) => void;
}

export default function DeviceSelector({ devices, value, onChange }: Props) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-500">声卡</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}
