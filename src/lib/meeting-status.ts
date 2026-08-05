export type MeetingStatusMeta = {
  label: string;
  className: string;
};

export function getMeetingStatusMeta(status: string): MeetingStatusMeta {
  switch (status) {
    case "transcribed":
      return { label: "已转写", className: "bg-slate-100 text-slate-700" };
    case "llm_processing":
      return { label: "纪要生成中", className: "bg-sky-50 text-sky-700" };
    case "generated":
      return { label: "已生成", className: "bg-emerald-50 text-emerald-700" };
    case "sending":
      return { label: "发送中", className: "bg-sky-50 text-sky-700" };
    case "sent":
      return { label: "已发送", className: "bg-emerald-50 text-emerald-700" };
    case "llm_failed":
      return { label: "纪要失败", className: "bg-red-50 text-red-700" };
    case "send_failed":
      return { label: "发送失败", className: "bg-red-50 text-red-700" };
    case "transcribe_failed":
      return { label: "转写失败", className: "bg-red-50 text-red-700" };
    case "paused":
      return { label: "已暂停", className: "bg-amber-50 text-amber-700" };
    default:
      return { label: status || "未知状态", className: "bg-slate-100 text-slate-600" };
  }
}
