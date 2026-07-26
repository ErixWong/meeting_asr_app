import { MeetingRecord, Voiceprint, AudioDevice } from "@/types";

export const MOCK_DEVICES: AudioDevice[] = [
  { deviceId: "default", label: "默认设备" },
  { deviceId: "jabra", label: "USB Jabra Speak 750" },
  { deviceId: "builtin", label: "内置麦克风 (Conexant)" },
  { deviceId: "bluetooth", label: "Microsoft Sound Mapper" },
];

export const MOCK_VOICEPRINTS: Voiceprint[] = [
  { spkId: 0, name: "张三", note: "产品经理" },
  { spkId: 1, name: "李四", note: "开发工程师" },
  { spkId: 2, name: "王五", note: "设计师" },
  { spkId: 3, name: "未命名", note: "" },
];

export const MOCK_MEETINGS: MeetingRecord[] = [
  {
    id: "m1",
    title: "产品评审会",
    date: "今天 14:30",
    durationLabel: "25 分钟",
    summary:
      "## 会议摘要\n\n- 讨论了新版本的产品需求\n- 确认了发布时间节点\n- 分配了开发任务\n\n## 待办事项\n\n- [ ] 张三：整理 PRD 文档\n- [ ] 李四：评估技术可行性",
    transcript: [
      { id: "s1", speaker: "张三", text: "大家好，今天我们讨论一下新版本的需求。", time: "00:01", timeSeconds: 1, isFinal: true },
      { id: "s2", speaker: "李四", text: "好的，我先汇报一下技术评估的进度。", time: "00:08", timeSeconds: 8, isFinal: true },
      { id: "s3", speaker: "王五", text: "设计稿我这边已经出了初版。", time: "00:15", timeSeconds: 15, isFinal: true },
    ],
  },
  {
    id: "m2",
    title: "每日站会",
    date: "今天 10:00",
    durationLabel: "12 分钟",
    summary: "## 站会纪要\n\n- 各成员同步了昨日进展\n- 确认无阻塞问题",
    transcript: [
      { id: "s1", speaker: "李四", text: "昨天完成了登录模块的开发。", time: "00:02", timeSeconds: 2, isFinal: true },
      { id: "s2", speaker: "王五", text: "我在做视觉稿的走查。", time: "00:06", timeSeconds: 6, isFinal: true },
    ],
  },
  {
    id: "m3",
    title: "需求讨论",
    date: "昨天 15:00",
    durationLabel: "45 分钟",
    summary: "## 需求讨论\n\n- 梳理了用户核心诉求\n- 确定了 MVP 范围",
    transcript: [
      { id: "s1", speaker: "张三", text: "我们先从用户最痛的点入手。", time: "00:03", timeSeconds: 3, isFinal: true },
    ],
  },
];

// simulated streaming transcript used during a demo recording
export const SIMULATED_STREAM: { speaker: string; text: string }[] = [
  { speaker: "发言人 A", text: "大家好，今天我们讨论一下这个项目的技术方案。" },
  { speaker: "发言人 B", text: "好的，我先汇报一下目前的进度。" },
  { speaker: "发言人 A", text: "那个接口的性能问题需要重点关注一下。" },
  { speaker: "发言人 C", text: "我这边会负责优化，预计下周完成。" },
  { speaker: "发言人 B", text: "同步一下，前端部分我这边也没问题。" },
];
