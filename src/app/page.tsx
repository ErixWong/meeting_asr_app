"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { RecordStatus, MeetingLlmResult, MeetingRecord, MeetingSendRecord, TranscriptSegment, AudioDevice } from "@/types";
import { FunASRClient, getAudioDevices } from "@/lib/funasr";
import { extractFeatures, clusterSpeakers, VoiceprintFeature } from "@/lib/voiceprint";
import DeviceSelector from "@/components/main/DeviceSelector";
import RecordingControls from "@/components/main/RecordingControls";
import TranscriptView from "@/components/main/TranscriptView";
import HistoryList from "@/components/main/HistoryList";
import { formatTime } from "@/components/main/RecordingControls";

let segCounter = 0;

export default function MeetingPage() {
  const [status, setStatus] = useState<RecordStatus>("idle");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [device, setDevice] = useState("default");
  const [elapsed, setElapsed] = useState(0);
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [selected, setSelected] = useState<MeetingRecord | null>(null);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [viewTab, setViewTab] = useState<"transcript" | "summary">("transcript");
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [llmResults, setLlmResults] = useState<MeetingLlmResult[]>([]);
  const [selectedLlmResultId, setSelectedLlmResultId] = useState<string | null>(null);
  const [mailTo, setMailTo] = useState("");
  const [mailCc, setMailCc] = useState("");
  const [sendRecords, setSendRecords] = useState<MeetingSendRecord[]>([]);
  const [sendingMail, setSendingMail] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasCustomFunasr, setHasCustomFunasr] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const asrClientRef = useRef<FunASRClient | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceprintFeaturesRef = useRef<VoiceprintFeature[]>([]);
  const speakerIdsRef = useRef<number[]>([]);

  useEffect(() => {
    segmentsRef.current = liveSegments;
  }, [liveSegments]);

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  const loadRuntimeConfig = useCallback(async () => {
    const res = await fetch("/api/config");
    const data = await res.json();
    const nextWorkspaceId = data.workspaceId || "";
    const nextApiKey = data.apiKey || "";
    const nextHasCustomFunasr = Boolean(data.hasCustomFunasr);

    setWorkspaceId(nextWorkspaceId);
    setApiKey(nextApiKey);
    setHasCustomFunasr(nextHasCustomFunasr);

    return {
      workspaceId: nextWorkspaceId,
      apiKey: nextApiKey,
      hasCustomFunasr: nextHasCustomFunasr,
    };
  }, []);

  useEffect(() => {
    getAudioDevices().then((deviceList) => {
      const mapped: AudioDevice[] = deviceList.map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
      }));
      if (mapped.length === 0) {
        mapped.push({ deviceId: "default", label: "默认麦克风" });
      }
      setDevices(mapped);
      if (mapped.length > 0) setDevice(mapped[0].deviceId);
    });

    loadRuntimeConfig().catch(console.error);

    fetch("/api/meetings")
      .then((res) => res.json())
      .then((data) => {
        setMeetings(data.meetings ?? []);
      })
      .catch((error) => console.error("Failed to load meetings:", error));

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadRuntimeConfig]);

  const startRecording = useCallback(async () => {
    let nextHasCustomFunasr = hasCustomFunasr;
    let nextWorkspaceId = workspaceId;
    let nextApiKey = apiKey;

    if (!nextHasCustomFunasr && (!nextWorkspaceId || !nextApiKey)) {
      try {
        const latest = await loadRuntimeConfig();
        nextHasCustomFunasr = latest.hasCustomFunasr;
        nextWorkspaceId = latest.workspaceId;
        nextApiKey = latest.apiKey;
      } catch (error) {
        console.error("Failed to refresh runtime config:", error);
      }
    }

    if (!nextHasCustomFunasr && (!nextWorkspaceId || !nextApiKey)) {
      alert("请先在 .env.local 中配置 FUNASR_SERVER_WS_URL，或配置 DASHSCOPE_API_KEY 和 FUNASR_WORKSPACE_ID");
      return;
    }

    setStatus("connecting");
    setLiveSegments([]);
    setSelected(null);
    voiceprintFeaturesRef.current = [];
    speakerIdsRef.current = [];

    try {
      const client = new FunASRClient();
      asrClientRef.current = client;

      await client.startRecording(
        {
          apiKey: nextApiKey,
          workspaceId: nextWorkspaceId,
          onResult: (text, isFinal, speakerId, audioData) => {
            let clusterSpeakerId = speakerId;

            if (isFinal && audioData && audioData.length > 1000) {
              try {
                const features = extractFeatures(audioData, 16000);
                voiceprintFeaturesRef.current.push(features);

                if (voiceprintFeaturesRef.current.length >= 2) {
                  const ids = clusterSpeakers(voiceprintFeaturesRef.current, 0.6);
                  speakerIdsRef.current = ids;
                  clusterSpeakerId = ids[ids.length - 1];
                } else {
                  speakerIdsRef.current = [0];
                  clusterSpeakerId = 0;
                }
              } catch (e) {
                console.warn("[Voiceprint] Feature extraction failed:", e);
              }
            }

            setLiveSegments((prev) => {
              const lastSeg = prev[prev.length - 1];

              if (isFinal) {
                if (lastSeg && !lastSeg.isFinal) {
                  const updated = [...prev];
                  updated[updated.length - 1] = { ...lastSeg, text, isFinal: true, speakerId: clusterSpeakerId };
                  return updated;
                }
                return [
                  ...prev,
                  {
                    id: `live-${segCounter++}`,
                    speaker: "",
                    speakerId: clusterSpeakerId,
                    text,
                    time: formatTime(elapsedRef.current),
                    timeSeconds: elapsedRef.current,
                    isFinal: true,
                  },
                ];
              } else {
                if (lastSeg && !lastSeg.isFinal) {
                  const updated = [...prev];
                  updated[updated.length - 1] = { ...lastSeg, text };
                  return updated;
                }
                return [
                  ...prev,
                  {
                    id: `live-${segCounter++}`,
                    speaker: "",
                    speakerId: clusterSpeakerId,
                    text,
                    time: formatTime(elapsedRef.current),
                    timeSeconds: elapsedRef.current,
                    isFinal: false,
                  },
                ];
              }
            });
          },
          onError: (error) => {
            console.error("FunASR error:", error);
            setStatus("idle");
            alert(`ASR 连接失败: ${error.message}`);
          },
          onStatusChange: (s) => {
            if (s === "recording") {
              setStatus("recording");
              setElapsed(0);
              timerRef.current = setInterval(
                () => setElapsed((e) => e + 1),
                1000
              );
            }
          },
        },
        device
      );
    } catch (error) {
      console.error("Failed to start recording:", error);
      setStatus("idle");
    }
  }, [hasCustomFunasr, workspaceId, apiKey, device, loadRuntimeConfig]);

  const pauseRecording = useCallback(() => {
    if (asrClientRef.current) {
      asrClientRef.current.pause();
      setStatus("paused");
      if (timerRef.current) clearInterval(timerRef.current);
    }
  }, []);

  const resumeRecording = useCallback(() => {
    if (asrClientRef.current) {
      asrClientRef.current.resume();
      setStatus("recording");
      timerRef.current = setInterval(
        () => setElapsed((e) => e + 1),
        1000
      );
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setStatus("generating");

    if (asrClientRef.current) {
      await asrClientRef.current.stopRecording();
      asrClientRef.current = null;
    }

    const finalSegments = segmentsRef.current.filter((s) => s.isFinal);
    if (finalSegments.length === 0) {
      setStatus("idle");
      return;
    }

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    const defaultName = `录音 ${dateStr}`;

    const name = window.prompt("请输入录音名称：", defaultName);
    if (name === null) {
      setStatus("idle");
      return;
    }
    const title = name.trim() || defaultName;
    setSavingMeeting(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          sourceType: "live_recording",
          sourceFileName: null,
          durationSeconds: elapsedRef.current,
          captureSessionId: `capture-${Date.now()}`,
          transcriptSegments: finalSegments,
        }),
      });
      const data = await res.json();
      if (data.meeting) {
        setMeetings((prev) => [data.meeting, ...prev]);
        setSelected(data.meeting);
        setLlmResults([]);
        setSelectedLlmResultId(null);
        setSendRecords([]);
      }
      setLiveSegments([]);
      setStatus("idle");
      setElapsed(0);
    } catch (error) {
      console.error("Failed to save meeting:", error);
      alert("会议保存失败");
      setStatus("idle");
    } finally {
      setSavingMeeting(false);
    }
  }, []);

  const handleCreateNew = useCallback(() => {
    setSelected(null);
    setLiveSegments([]);
    setStatus("idle");
    setElapsed(0);
    setLlmResults([]);
    setSelectedLlmResultId(null);
    setSendRecords([]);
  }, []);

  const loadLlmResults = useCallback(async (meetingId: string) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/llm-results`);
      const data = await res.json();
      const nextResults = data.llmResults ?? [];
      setLlmResults(nextResults);
      setSelectedLlmResultId(nextResults[0]?.id ?? null);
      if (nextResults[0]?.resultMarkdown) {
        setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, summary: nextResults[0].resultMarkdown } : prev));
      }
    } catch (error) {
      console.error("Failed to load llm results:", error);
      setLlmResults([]);
      setSelectedLlmResultId(null);
    }
  }, []);

  const loadSendRecords = useCallback(async (meetingId: string) => {
    try {
      const res = await fetch(`/api/meetings/${meetingId}/send-records`);
      const data = await res.json();
      setSendRecords(data.sendRecords ?? []);
    } catch (error) {
      console.error("Failed to load send records:", error);
      setSendRecords([]);
    }
  }, []);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setStatus("connecting");
    setLiveSegments([]);
    setSelected(null);

    const client = new FunASRClient();
    asrClientRef.current = client;

    const allSegments: TranscriptSegment[] = [];

    try {
      let uploadTimeSeconds = 0;
      await client.transcribeFile(
        file,
        (text, isFinal, speakerId) => {
          if (isFinal) {
            setLiveSegments((prev) => {
              const lastSeg = prev[prev.length - 1];
              if (lastSeg && !lastSeg.isFinal) {
                const updated = [...prev];
                updated[updated.length - 1] = { ...lastSeg, text, isFinal: true, speakerId };
                allSegments.length = 0;
                allSegments.push(...updated.filter((s) => s.isFinal));
                return updated;
              }
              const newSeg: TranscriptSegment = {
                id: `live-${segCounter++}`,
                speaker: "",
                speakerId,
                text,
                time: formatTime(uploadTimeSeconds),
                timeSeconds: uploadTimeSeconds,
                isFinal: true,
              };
              allSegments.push(newSeg);
              return [...prev, newSeg];
            });
          } else {
            setStatus("recording");
            setLiveSegments((prev) => {
              const lastSeg = prev[prev.length - 1];
              if (lastSeg && !lastSeg.isFinal) {
                const updated = [...prev];
                updated[updated.length - 1] = { ...lastSeg, text };
                return updated;
              }
              return [
                ...prev,
                {
                  id: `live-${segCounter++}`,
                  speaker: "",
                  speakerId,
                  text,
                  time: formatTime(uploadTimeSeconds),
                  timeSeconds: uploadTimeSeconds,
                  isFinal: false,
                },
              ];
            });
          }
        },
        (progress) => {
          console.log("[Upload] progress:", progress + "%");
        }
      );

      if (allSegments.length > 0) {
        const now = new Date();
        const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
        const defaultName = file.name.replace(/\.[^.]+$/, "") || `上传 ${dateStr}`;

        const name = window.prompt("请输入录音名称：", defaultName);
        if (name !== null) {
          const title = name.trim() || defaultName;
          setSavingMeeting(true);
          const res = await fetch("/api/meetings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              sourceType: "file_upload",
              sourceFileName: file.name,
              durationSeconds: null,
              captureSessionId: `capture-${Date.now()}`,
              transcriptSegments: allSegments,
            }),
          });
          const data = await res.json();
          if (data.meeting) {
            setMeetings((prev) => [data.meeting, ...prev]);
            setSelected(data.meeting);
            setLlmResults([]);
            setSelectedLlmResultId(null);
            setSendRecords([]);
          }
        }
      }

      setLiveSegments([]);
      setStatus("idle");
    } catch (err) {
      console.error("Upload transcribe failed:", err);
      alert("音频识别失败：" + (err as Error).message);
      setStatus("idle");
    } finally {
      setSavingMeeting(false);
    }
  }, []);

  const generateSummary = useCallback(async () => {
    if (!selected) return;
    setSummaryGenerating(true);
    try {
      const res = await fetch(`/api/meetings/${selected.id}/llm-results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.llmResult?.resultMarkdown) {
        const updated = { ...selected, summary: data.llmResult.resultMarkdown };
        setSelected(updated);
        setMeetings((prev) => prev.map((m) => m.id === selected.id ? updated : m));
        await loadLlmResults(selected.id);
      } else if (data.error) {
        throw new Error(data.error);
      }
    } catch (err) {
      console.error("Generate summary failed:", err);
      alert("生成会议纪要失败");
    } finally {
      setSummaryGenerating(false);
    }
  }, [loadLlmResults, selected]);

  const sendSummary = useCallback(async () => {
    if (!selected || !selected.summary) return;

    const toRecipients = mailTo
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const ccRecipients = mailCc
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (toRecipients.length === 0) {
      alert("请至少填写一个主送邮箱");
      return;
    }

    setSendingMail(true);
    try {
      const currentResult = llmResults.find((item) => item.id === selectedLlmResultId) ?? llmResults[0];
      if (!currentResult) {
        throw new Error("当前会议还没有可发送的纪要结果");
      }

      const sendRes = await fetch(`/api/meetings/${selected.id}/send-mail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingLlmResultId: currentResult.id,
          subject: `[会议纪要] ${selected.title}`,
          toRecipients,
          ccRecipients,
          mailTemplateType: "formal_minutes_mail",
        }),
      });
      const sendData = await sendRes.json();
      if (sendData.error) {
        throw new Error(sendData.error);
      }

      await loadSendRecords(selected.id);
      alert("会议纪要已发送");
    } catch (error) {
      console.error("Failed to send summary:", error);
      alert(`发送失败: ${(error as Error).message}`);
    } finally {
      setSendingMail(false);
    }
  }, [llmResults, loadSendRecords, mailCc, mailTo, selected, selectedLlmResultId]);

  const selectedDeviceLabel =
    devices.find((d) => d.deviceId === device)?.label ?? "";

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-2 text-lg font-semibold text-slate-800">
          <span>🎙</span> 智能会议纪要系统
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin"
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-50"
          >
            ⚙ 管理
          </Link>

        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex-1 overflow-y-auto">
            <HistoryList
              meetings={meetings}
              selectedId={selected?.id ?? null}
              onSelect={(m) => {
                setSelected(m);
                setLiveSegments([]);
                setViewTab("transcript");
                loadLlmResults(m.id).catch(console.error);
                loadSendRecords(m.id).catch(console.error);
              }}
              onCreateNew={handleCreateNew}
              onRename={(id, newTitle) => {
                setMeetings((prev) => prev.map((m) => m.id === id ? { ...m, title: newTitle } : m));
                if (selected?.id === id) setSelected((prev) => prev ? { ...prev, title: newTitle } : prev);
              }}
              onDelete={(id) => {
                setMeetings((prev) => prev.filter((m) => m.id !== id));
                if (selected?.id === id) setSelected(null);
                if (selected?.id === id) {
                  setLlmResults([]);
                  setSelectedLlmResultId(null);
                }
                if (selected?.id === id) setSendRecords([]);
              }}
            />
          </div>
          <div className="shrink-0 border-t border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
            热词增强由管理员在后台统一维护，当前录音页不再单独编辑热词。
          </div>
        </aside>

        <main className="flex flex-1 flex-col">
          <div className="flex-1 overflow-hidden p-6">
            {selected ? (
              <div className="flex h-full flex-col">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-800">
                      {selected.title}
                    </h2>
                    <p className="text-sm text-slate-400">{selected.date} · {selected.durationLabel}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {viewTab === "summary" && llmResults.length > 0 && (
                      <select
                        value={selectedLlmResultId ?? ""}
                        onChange={(e) => {
                          const nextId = e.target.value;
                          setSelectedLlmResultId(nextId);
                          const next = llmResults.find((item) => item.id === nextId);
                          if (next) {
                            setSelected((prev) => prev ? { ...prev, summary: next.resultMarkdown } : prev);
                            setEditingSummary(false);
                          }
                        }}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600"
                      >
                        {llmResults.map((result) => (
                          <option key={result.id} value={result.id}>
                            V{result.versionNo} · {result.resultTitle}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                      <button
                        onClick={() => setViewTab("transcript")}
                        className={`rounded-md px-3 py-1 text-sm ${
                          viewTab === "transcript"
                            ? "bg-white text-brand shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        会议录音
                      </button>
                      <button
                        onClick={() => {
                          if (!selected.summary) {
                            generateSummary();
                          }
                          setViewTab("summary");
                          setEditingSummary(false);
                        }}
                        className={`rounded-md px-3 py-1 text-sm ${
                          viewTab === "summary"
                            ? "bg-white text-brand shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        生成会议纪要
                      </button>
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-auto rounded-xl border border-slate-200 bg-white p-4">
                  {viewTab === "transcript" ? (
                    <TranscriptView segments={selected.transcript} isHistory />
                  ) : summaryGenerating ? (
                    <div className="flex h-full flex-col items-center justify-center text-slate-400">
                      <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                      <p>正在生成会议纪要...</p>
                    </div>
                  ) : selected.summary ? (
                    editingSummary ? (
                      <textarea
                        value={summaryText}
                        onChange={(e) => setSummaryText(e.target.value)}
                        className="scroll-thin h-full w-full resize-none whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700 focus:outline-none"
                      />
                    ) : (
                      <div className="scroll-thin h-full overflow-y-auto whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
                        {selected.summary}
                      </div>
                    )
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center text-slate-400">
                      <p>点击上方"生成会议纪要"按钮开始生成</p>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => {
                      const text = selected.transcript.map((s) => s.text).join("");
                      navigator.clipboard.writeText(text);
                    }}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  >
                    复制全文
                  </button>
                  {viewTab === "summary" && selected.summary && (
                    <>
                      {editingSummary ? (
                        <>
                          <button
                            onClick={async () => {
                              const updated = { ...selected, summary: summaryText };
                              setSelected(updated);
                              setMeetings((prev) => prev.map((m) => m.id === selected.id ? updated : m));
                              if (selectedLlmResultId) {
                                await fetch(`/api/meetings/${selected.id}/llm-results`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    id: selectedLlmResultId,
                                    resultMarkdown: summaryText,
                                  }),
                                });
                                await loadLlmResults(selected.id);
                              }
                              setEditingSummary(false);
                            }}
                            className="rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark"
                          >
                            保存
                          </button>
                          <button
                            onClick={() => setEditingSummary(false)}
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => {
                            setSummaryText(selected.summary);
                            setEditingSummary(true);
                          }}
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                        >
                          编辑纪要
                        </button>
                      )}
                      <button
                        onClick={() => sendSummary()}
                        disabled={sendingMail}
                        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-60"
                      >
                        {sendingMail ? "发送中..." : "发送纪要"}
                      </button>
                    </>
                  )}
                </div>
                {viewTab === "summary" && selected.summary && (
                  <div className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">主送</label>
                      <input
                        value={mailTo}
                        onChange={(e) => setMailTo(e.target.value)}
                        placeholder="a@example.com,b@example.com"
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">抄送</label>
                      <input
                        value={mailCc}
                        onChange={(e) => setMailCc(e.target.value)}
                        placeholder="c@example.com"
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <div className="mb-2 text-xs font-medium text-slate-500">发送记录</div>
                      {sendRecords.length === 0 ? (
                        <div className="text-sm text-slate-400">暂无发送记录</div>
                      ) : (
                        <div className="space-y-2">
                          {sendRecords.map((record) => (
                            <div key={record.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-medium text-slate-700">{record.subject}</span>
                                <span className={`text-xs ${record.status === "sent" ? "text-emerald-600" : "text-red-600"}`}>
                                  {record.status}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                To: {record.toRecipients.join(", ") || "-"}
                              </div>
                              {record.ccRecipients.length > 0 && (
                                <div className="mt-1 text-xs text-slate-400">
                                  Cc: {record.ccRecipients.join(", ")}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="mx-auto flex h-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white">
                {status === "recording" || status === "paused" || status === "connecting" ? (
                  <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2 text-sm">
                    <span
                      className={
                        status === "recording"
                          ? "rec-dot"
                          : status === "paused"
                          ? "h-3 w-3 rounded-full bg-amber-400"
                          : "h-3 w-3 rounded-full bg-amber-400"
                      }
                    />
                    <span className="text-slate-600">
                      {status === "recording"
                        ? `录音中 ${formatTime(elapsed)}`
                        : status === "paused"
                        ? `已暂停 ${formatTime(elapsed)}`
                        : savingMeeting
                        ? "保存会议中..."
                        : "连接中..."}
                    </span>
                    <span className="ml-auto text-slate-400">
                      FunASR:{" "}
                      {status === "recording" ? (
                        <span className="text-green-600">已连接</span>
                      ) : (
                        "连接中"
                      )}
                    </span>
                  </div>
                ) : null}
                <div className="flex-1 overflow-auto">
                  <TranscriptView segments={liveSegments} />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-slate-200 bg-white px-6 py-3">
            <DeviceSelector
              devices={devices}
              value={device}
              onChange={setDevice}
            />
            <div className="flex items-center gap-3">
              {status === "recording" && (
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <span>音量</span>
                  <div className="h-2 w-32 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full w-3/5 animate-pulse bg-green-500" />
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={handleUpload}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={status !== "idle" && status !== "done"}
                className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
              >
                📁 上传音频
              </button>
              <RecordingControls
                status={status}
                onStart={startRecording}
                onPause={pauseRecording}
                onResume={resumeRecording}
                onStop={stopRecording}
              />
            </div>
          </div>

          <div className="border-t border-slate-100 bg-slate-50 px-6 py-1 text-xs text-slate-400">
            FunASR: {status === "recording" || status === "paused" ? "已连接" : "待连接"} | 设备: {selectedDeviceLabel}
          </div>
        </main>
      </div>
    </div>
  );
}
