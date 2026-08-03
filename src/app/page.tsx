"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  RecordStatus,
  MeetingAsrResult,
  MeetingAsrResultDetail,
  MeetingLlmResult,
  MeetingRecord,
  MeetingSendRecord,
  PromptTemplate,
  TranscriptSegment,
  AudioDevice,
} from "@/types";
import { FunASRClient, getAudioDevices } from "@/lib/funasr";
import { getMeetingStatusMeta } from "@/lib/meeting-status";
import { extractFeatures, clusterSpeakers, VoiceprintFeature } from "@/lib/voiceprint";
import DeviceSelector from "@/components/main/DeviceSelector";
import MarkdownPreview from "@/components/main/MarkdownPreview";
import RecordingControls from "@/components/main/RecordingControls";
import TranscriptView from "@/components/main/TranscriptView";
import HistoryList from "@/components/main/HistoryList";
import { formatTime } from "@/components/main/RecordingControls";

let segCounter = 0;

type ActionNotice = {
  type: "success" | "error" | "info";
  message: string;
};

export default function MeetingPage() {
  const [status, setStatus] = useState<RecordStatus>("idle");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [device, setDevice] = useState("default");
  const [elapsed, setElapsed] = useState(0);
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [selected, setSelected] = useState<MeetingRecord | null>(null);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [viewTab, setViewTab] = useState<"transcript" | "summary" | "asrRaw">("transcript");
  const [summaryGenerating, setSummaryGenerating] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryText, setSummaryText] = useState("");
  const [llmResults, setLlmResults] = useState<MeetingLlmResult[]>([]);
  const [selectedLlmResultId, setSelectedLlmResultId] = useState<string | null>(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [selectedPromptTemplateId, setSelectedPromptTemplateId] = useState<string>("");
  const [mailTo, setMailTo] = useState("");
  const [mailCc, setMailCc] = useState("");
  const [sendRecords, setSendRecords] = useState<MeetingSendRecord[]>([]);
  const [asrResults, setAsrResults] = useState<MeetingAsrResult[]>([]);
  const [selectedAsrResult, setSelectedAsrResult] = useState<MeetingAsrResultDetail | null>(null);
  const [sendingMail, setSendingMail] = useState(false);
  const [asrReady, setAsrReady] = useState(false);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const asrClientRef = useRef<FunASRClient | null>(null);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedMeetingIdRef = useRef<string | null>(null);
  const summaryGeneratingRef = useRef(false);
  const summaryGeneratingMeetingIdRef = useRef<string | null>(null);
  const voiceprintFeaturesRef = useRef<VoiceprintFeature[]>([]);
  const speakerIdsRef = useRef<number[]>([]);

  const showNotice = useCallback((type: ActionNotice["type"], message: string) => {
    setNotice({ type, message });
  }, []);

  const updateSummaryGenerating = useCallback((value: boolean, meetingId?: string | null) => {
    summaryGeneratingRef.current = value;
    summaryGeneratingMeetingIdRef.current = value ? meetingId ?? summaryGeneratingMeetingIdRef.current : null;
    setSummaryGenerating(value);
  }, []);

  const requestJson = useCallback(async <T = any,>(input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data as T;
  }, []);

  useEffect(() => {
    segmentsRef.current = liveSegments;
  }, [liveSegments]);

  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  useEffect(() => {
    selectedMeetingIdRef.current = selected?.id ?? null;
  }, [selected?.id]);

  const isActiveMeeting = useCallback((meetingId: string) => {
    return selectedMeetingIdRef.current === meetingId;
  }, []);

  const primeMeetingAsyncState = useCallback(async (meetingId: string) => {
    try {
      const [meetingData, llmData] = await Promise.all([
        requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}`),
        requestJson<{ llmResults?: MeetingLlmResult[] }>(`/api/meetings/${meetingId}/llm-results`).catch(() => ({ llmResults: [] })),
      ]);

      if (!isActiveMeeting(meetingId)) return;

      const latestMeeting = meetingData.meeting;
      if (latestMeeting) {
        setMeetings((prev) => prev.map((item) => (item.id === meetingId ? latestMeeting : item)));
        setSelected((prev) => (prev && prev.id === meetingId ? latestMeeting : prev));
      }

      const nextResults = llmData.llmResults ?? [];
      setLlmResults(nextResults);
      setSelectedLlmResultId(nextResults[0]?.id ?? null);
      if (nextResults[0]?.resultMarkdown) {
        setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, summary: nextResults[0].resultMarkdown } : prev));
      }
    } catch (error) {
      console.error("Failed to prime meeting async state:", error);
    }
  }, [isActiveMeeting, requestJson]);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => {
      setNotice(null);
    }, notice.type === "error" ? 7000 : 3500);

    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadRuntimeConfig = useCallback(async () => {
    const data = await requestJson<{ asr?: { isConfigured?: boolean } }>("/api/config");
    const nextAsrReady = Boolean(data.asr?.isConfigured);

    setAsrReady(nextAsrReady);

    return {
      asrReady: nextAsrReady,
    };
  }, [requestJson]);

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

    requestJson<{ meetings?: MeetingRecord[] }>("/api/meetings")
      .then((data) => {
        setMeetings(data.meetings ?? []);
      })
      .catch((error) => {
        console.error("Failed to load meetings:", error);
        showNotice("error", `会议列表加载失败: ${(error as Error).message}`);
      });

    requestJson<{ templates?: PromptTemplate[] }>("/api/admin/prompt-templates")
      .then((data) => {
        const activeTemplates = (data.templates ?? []).filter((template) => template.status === "active");
        setPromptTemplates(activeTemplates);
        setSelectedPromptTemplateId((prev) => prev || activeTemplates[0]?.id || "");
      })
      .catch((error) => {
        console.error("Failed to load prompt templates:", error);
      });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadRuntimeConfig, requestJson, showNotice]);

  const startRecording = useCallback(async () => {
    let nextAsrReady = asrReady;

    if (!nextAsrReady) {
      try {
        const latest = await loadRuntimeConfig();
        nextAsrReady = latest.asrReady;
      } catch (error) {
        console.error("Failed to refresh runtime config:", error);
      }
    }

    if (!nextAsrReady) {
      showNotice("error", "请先在后台配置可用的 ASR 服务");
      return;
    }

    setStatus("connecting");
    setLiveSegments([]);
    selectedMeetingIdRef.current = null;
    setSelected(null);
    voiceprintFeaturesRef.current = [];
    speakerIdsRef.current = [];

    try {
      const client = new FunASRClient();
      asrClientRef.current = client;

      await client.startRecording(
        {
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
            showNotice("error", `ASR 连接失败: ${error.message}`);
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
      showNotice("error", `启动录音失败: ${(error as Error).message}`);
    }
  }, [asrReady, device, loadRuntimeConfig, showNotice]);

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

    let recordingCaptureSessionId = "";
    if (asrClientRef.current) {
      const currentClient = asrClientRef.current;
      await currentClient.stopRecording();
      recordingCaptureSessionId = currentClient.getCaptureSessionId();
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
      const data = await requestJson<{ meeting?: MeetingRecord }>("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          sourceType: "live_recording",
          sourceFileName: null,
          durationSeconds: elapsedRef.current,
          captureSessionId: recordingCaptureSessionId || `capture-${Date.now()}`,
          transcriptSegments: finalSegments,
        }),
      });
      const meeting = data.meeting;
      if (meeting) {
        setMeetings((prev) => [meeting, ...prev]);
        selectedMeetingIdRef.current = meeting.id;
        setSelected(meeting);
        setLlmResults([]);
        setSelectedLlmResultId(null);
        setSendRecords([]);
        setAsrResults([]);
        setSelectedAsrResult(null);
        primeMeetingAsyncState(meeting.id).catch(console.error);
      }
      setLiveSegments([]);
      setStatus("idle");
      setElapsed(0);
    } catch (error) {
      console.error("Failed to save meeting:", error);
      showNotice("error", "会议保存失败");
      setStatus("idle");
    } finally {
      setSavingMeeting(false);
    }
  }, [primeMeetingAsyncState, requestJson, showNotice]);

  const handleCreateNew = useCallback(() => {
    selectedMeetingIdRef.current = null;
    setSelected(null);
    updateSummaryGenerating(false, null);
    setSendingMail(false);
    setLiveSegments([]);
    setStatus("idle");
    setElapsed(0);
    setLlmResults([]);
    setSelectedLlmResultId(null);
    setSendRecords([]);
    setAsrResults([]);
    setSelectedAsrResult(null);
  }, [updateSummaryGenerating]);

  const loadLlmResults = useCallback(async (meetingId: string) => {
    try {
      const data = await requestJson<{ llmResults?: MeetingLlmResult[] }>(`/api/meetings/${meetingId}/llm-results`);
      if (!isActiveMeeting(meetingId)) return;
      const nextResults = data.llmResults ?? [];
      setLlmResults(nextResults);
      setSelectedLlmResultId(nextResults[0]?.id ?? null);
      if (nextResults[0]?.resultMarkdown) {
        setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, summary: nextResults[0].resultMarkdown } : prev));
      }
    } catch (error) {
      console.error("Failed to load llm results:", error);
      if (!isActiveMeeting(meetingId)) return;
      setLlmResults([]);
      setSelectedLlmResultId(null);
    }
  }, [isActiveMeeting, requestJson]);

  const loadSendRecords = useCallback(async (meetingId: string) => {
    try {
      const data = await requestJson<{ sendRecords?: MeetingSendRecord[] }>(`/api/meetings/${meetingId}/send-records`);
      if (!isActiveMeeting(meetingId)) return;
      setSendRecords(data.sendRecords ?? []);
    } catch (error) {
      console.error("Failed to load send records:", error);
      if (!isActiveMeeting(meetingId)) return;
      setSendRecords([]);
    }
  }, [isActiveMeeting, requestJson]);

  const loadAsrResults = useCallback(async (meetingId: string) => {
    try {
      const data = await requestJson<{ asrResults?: MeetingAsrResult[] }>(`/api/meetings/${meetingId}/asr-results`);
      if (!isActiveMeeting(meetingId)) return;
      const nextResults = data.asrResults ?? [];
      setAsrResults(nextResults);

      if (nextResults[0]?.id) {
        const detailData = await requestJson<{ asrResult?: MeetingAsrResultDetail }>(`/api/meetings/${meetingId}/asr-results/${nextResults[0].id}`);
        if (!isActiveMeeting(meetingId)) return;
        setSelectedAsrResult(detailData.asrResult ?? null);
      } else {
        setSelectedAsrResult(null);
      }
    } catch (error) {
      console.error("Failed to load asr results:", error);
      if (!isActiveMeeting(meetingId)) return;
      setAsrResults([]);
      setSelectedAsrResult(null);
    }
  }, [isActiveMeeting, requestJson]);

  const loadAsrResultDetail = useCallback(async (meetingId: string, resultId: string) => {
    try {
      const data = await requestJson<{ asrResult?: MeetingAsrResultDetail }>(`/api/meetings/${meetingId}/asr-results/${resultId}`);
      if (!isActiveMeeting(meetingId)) return;
      setSelectedAsrResult(data.asrResult ?? null);
    } catch (error) {
      console.error("Failed to load asr result detail:", error);
      if (!isActiveMeeting(meetingId)) return;
      setSelectedAsrResult(null);
    }
  }, [isActiveMeeting, requestJson]);

  const refreshMeeting = useCallback(async (meetingId: string) => {
    const data = await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}`);
    const meeting = data.meeting;
    if (!meeting) return null;

    setMeetings((prev) => prev.map((item) => (item.id === meetingId ? meeting : item)));
    setSelected((prev) => (prev && prev.id === meetingId ? meeting : prev));
    return meeting;
  }, [requestJson]);

  useEffect(() => {
    if (!selected?.id || selected.status !== "llm_processing" || selected.summary) {
      return;
    }

    let disposed = false;

    const poll = async () => {
      try {
        await refreshMeeting(selected.id);
        await loadLlmResults(selected.id);
      } catch (error) {
        if (!disposed) {
          console.error("Failed to refresh llm processing meeting:", error);
        }
      }
    };

    poll().catch(console.error);
    const timer = window.setInterval(() => {
      poll().catch(console.error);
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadLlmResults, refreshMeeting, selected?.id, selected?.status, selected?.summary]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    let nextAsrReady = asrReady;
    if (!nextAsrReady) {
      try {
        const latest = await loadRuntimeConfig();
        nextAsrReady = latest.asrReady;
      } catch (error) {
        console.error("Failed to refresh runtime config:", error);
      }
    }

    if (!nextAsrReady) {
      showNotice("error", "请先在后台配置可用的 ASR 服务");
      return;
    }

    setStatus("connecting");
    setLiveSegments([]);
    selectedMeetingIdRef.current = null;
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
          const data = await requestJson<{ meeting?: MeetingRecord }>("/api/meetings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              sourceType: "file_upload",
              sourceFileName: file.name,
              durationSeconds: null,
              captureSessionId: client.getCaptureSessionId() || `capture-${Date.now()}`,
              transcriptSegments: allSegments,
            }),
          });
          const meeting = data.meeting;
          if (meeting) {
            setMeetings((prev) => [meeting, ...prev]);
            selectedMeetingIdRef.current = meeting.id;
            setSelected(meeting);
            setLlmResults([]);
            setSelectedLlmResultId(null);
            setSendRecords([]);
            setAsrResults([]);
            setSelectedAsrResult(null);
            primeMeetingAsyncState(meeting.id).catch(console.error);
          }
        }
      }

      setLiveSegments([]);
      setStatus("idle");
    } catch (err) {
      console.error("Upload transcribe failed:", err);
      showNotice("error", `音频识别失败: ${(err as Error).message}`);
      setStatus("idle");
    } finally {
      setSavingMeeting(false);
    }
  }, [asrReady, loadRuntimeConfig, primeMeetingAsyncState, requestJson, showNotice]);

  const generateSummary = useCallback(async (promptTemplateId?: string) => {
    if (!selected || summaryGeneratingRef.current) return;
    const meetingId = selected.id;
    updateSummaryGenerating(true, meetingId);
    try {
      const data = await requestJson<{ llmResult?: MeetingLlmResult }>(`/api/meetings/${meetingId}/llm-results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptTemplateId ? { promptTemplateId } : {}),
      });
      if (!isActiveMeeting(meetingId)) return;
      const llmResult = data.llmResult;
      if (llmResult?.resultMarkdown) {
        const updated = { ...selected, summary: llmResult.resultMarkdown };
        setSelected(updated);
        setSelectedLlmResultId(llmResult.id);
        setMeetings((prev) => prev.map((m) => m.id === meetingId ? updated : m));
        await loadLlmResults(meetingId);
        await refreshMeeting(meetingId);
        showNotice("success", "会议纪要已生成");
      } else {
        throw new Error("LLM 未返回会议纪要结果");
      }
    } catch (err) {
      console.error("Generate summary failed:", err);
      if (!isActiveMeeting(meetingId)) return;
      await refreshMeeting(meetingId).catch(console.error);
      showNotice("error", `生成会议纪要失败: ${(err as Error).message}`);
    } finally {
      if (summaryGeneratingMeetingIdRef.current === meetingId) {
        updateSummaryGenerating(false, null);
      }
    }
  }, [isActiveMeeting, loadLlmResults, refreshMeeting, requestJson, selected, showNotice, updateSummaryGenerating]);

  const sendSummary = useCallback(async () => {
    if (!selected || !selected.summary) return;
    const meetingId = selected.id;

    const toRecipients = mailTo
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const ccRecipients = mailCc
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (toRecipients.length === 0) {
      showNotice("error", "请至少填写一个主送邮箱");
      return;
    }

    setSendingMail(true);
    try {
      const currentResult = llmResults.find((item) => item.id === selectedLlmResultId) ?? llmResults[0];
      if (!currentResult) {
        throw new Error("当前会议还没有可发送的纪要结果");
      }

      await requestJson(`/api/meetings/${meetingId}/send-mail`, {
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

      if (!isActiveMeeting(meetingId)) return;
      await loadSendRecords(meetingId);
      await refreshMeeting(meetingId);
      showNotice("success", "会议纪要已发送");
    } catch (error) {
      console.error("Failed to send summary:", error);
      if (!isActiveMeeting(meetingId)) return;
      await refreshMeeting(meetingId).catch(console.error);
      await loadSendRecords(meetingId).catch(console.error);
      showNotice("error", `发送失败: ${(error as Error).message}`);
    } finally {
      if (isActiveMeeting(meetingId)) {
        setSendingMail(false);
      }
    }
  }, [isActiveMeeting, llmResults, loadSendRecords, mailCc, mailTo, refreshMeeting, requestJson, selected, selectedLlmResultId, showNotice]);

  const activePromptTemplates = promptTemplates.filter((template) => template.status === "active");
  const currentLlmResult = llmResults.find((item) => item.id === selectedLlmResultId) ?? llmResults[0] ?? null;
  const selectedPromptTemplate =
    activePromptTemplates.find((template) => template.id === selectedPromptTemplateId) ?? activePromptTemplates[0] ?? null;

  const selectLlmResult = useCallback((resultId: string) => {
    setSelectedLlmResultId(resultId);
    const next = llmResults.find((item) => item.id === resultId);
    if (next) {
      setSelected((prev) => prev ? { ...prev, summary: next.resultMarkdown } : prev);
      setEditingSummary(false);
    }
  }, [llmResults]);

  const deleteLlmResult = useCallback(
    async (resultId: string) => {
      if (!selected) return;
      const meetingId = selected.id;
      if (!window.confirm("确定删除该纪要版本？关联的发送记录也会一并删除。")) return;
      try {
        await requestJson(`/api/meetings/${meetingId}/llm-results?resultId=${encodeURIComponent(resultId)}`, {
          method: "DELETE",
        });
        if (!isActiveMeeting(meetingId)) return;
        await loadLlmResults(meetingId);
        await refreshMeeting(meetingId);
        showNotice("success", "纪要版本已删除");
      } catch (error) {
        console.error("Delete llm result failed:", error);
        if (!isActiveMeeting(meetingId)) return;
        showNotice("error", `删除失败: ${(error as Error).message}`);
      }
    },
    [isActiveMeeting, loadLlmResults, refreshMeeting, requestJson, selected, showNotice]
  );

  const saveSummaryEdit = useCallback(async () => {
    if (!selected) return;
    try {
      if (selectedLlmResultId) {
        await requestJson(`/api/meetings/${selected.id}/llm-results`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: selectedLlmResultId,
            resultMarkdown: summaryText,
          }),
        });
        await loadLlmResults(selected.id);
      }
      const updated = { ...selected, summary: summaryText };
      setSelected(updated);
      setMeetings((prev) => prev.map((m) => m.id === selected.id ? updated : m));
      setEditingSummary(false);
      showNotice("success", "会议纪要已保存");
    } catch (error) {
      console.error("Failed to save summary:", error);
      showNotice("error", `保存失败: ${(error as Error).message}`);
    }
  }, [loadLlmResults, requestJson, selected, selectedLlmResultId, showNotice, summaryText]);

  const selectedDeviceLabel =
    devices.find((d) => d.deviceId === device)?.label ?? "";
  const rawAsrPayloadText = selectedAsrResult
    ? JSON.stringify(selectedAsrResult.rawPayload, null, 2)
    : "";
  const asrConfigText = selectedAsrResult
    ? JSON.stringify(selectedAsrResult.asrConfigSnapshot, null, 2)
    : "";
  const selectedStatusMeta = selected ? getMeetingStatusMeta(selected.status) : null;
  const noticeClassName =
    notice?.type === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : notice?.type === "error"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-sky-200 bg-sky-50 text-sky-700";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice && (
        <div className={`flex items-center justify-between border-b px-6 py-2 text-sm ${noticeClassName}`}>
          <span>{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded px-2 py-0.5 text-xs opacity-80 transition hover:bg-white/60 hover:opacity-100"
          >
            关闭
          </button>
        </div>
      )}

      <div className="flex min-w-0 flex-1 overflow-hidden">
        <aside className="flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
          <div className="flex-1 overflow-y-auto">
            <HistoryList
              meetings={meetings}
              selectedId={selected?.id ?? null}
              onSelect={(m) => {
                selectedMeetingIdRef.current = m.id;
                setSelected(m);
                updateSummaryGenerating(false, null);
                setSendingMail(false);
                setLiveSegments([]);
                setViewTab("transcript");
                loadLlmResults(m.id).catch(console.error);
                loadSendRecords(m.id).catch(console.error);
                loadAsrResults(m.id).catch(console.error);
              }}
              onCreateNew={handleCreateNew}
              onRename={async (id, newTitle) => {
                try {
                  const data = await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ title: newTitle }),
                  });
                  const meeting = data.meeting;
                  if (meeting) {
                    setMeetings((prev) => prev.map((m) => m.id === id ? meeting : m));
                    if (selected?.id === id) setSelected(meeting);
                    showNotice("success", "会议已重命名");
                  }
                } catch (error) {
                  console.error("Failed to rename meeting:", error);
                  showNotice("error", "重命名失败");
                }
              }}
              onDelete={async (id) => {
                try {
                  await requestJson(`/api/meetings/${id}`, { method: "DELETE" });
                  setMeetings((prev) => prev.filter((m) => m.id !== id));
                  if (selected?.id === id) {
                    selectedMeetingIdRef.current = null;
                    setSelected(null);
                    setLlmResults([]);
                    setSelectedLlmResultId(null);
                    setSendRecords([]);
                    setAsrResults([]);
                    setSelectedAsrResult(null);
                  }
                  showNotice("success", "会议已删除");
                } catch (error) {
                  console.error("Failed to delete meeting:", error);
                  showNotice("error", "删除失败");
                }
              }}
            />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-w-0 flex-1 overflow-hidden p-6">
            {selected ? (
              <div className="flex h-full min-w-0 flex-col">
                <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-xl font-semibold text-slate-800">
                      {selected.title}
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <p className="text-sm text-slate-400">{selected.date} · {selected.durationLabel}</p>
                      {selectedStatusMeta && (
                        <span className={`rounded px-2 py-0.5 text-xs ${selectedStatusMeta.className}`}>
                          {selectedStatusMeta.label}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                      <button
                        onClick={() => setViewTab("transcript")}
                        className={`rounded-md px-3 py-1 text-sm ${
                          viewTab === "transcript"
                            ? "bg-white text-brand shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        转写记录
                      </button>
                      <button
                        onClick={() => {
                          setViewTab("summary");
                          setEditingSummary(false);
                        }}
                        className={`rounded-md px-3 py-1 text-sm ${
                          viewTab === "summary"
                            ? "bg-white text-brand shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        会议纪要
                      </button>
                      <button
                        onClick={() => {
                          setViewTab("asrRaw");
                          if (selected && asrResults.length === 0) {
                            loadAsrResults(selected.id).catch(console.error);
                          }
                        }}
                        className={`rounded-md px-3 py-1 text-sm ${
                          viewTab === "asrRaw"
                            ? "bg-white text-brand shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        原始 ASR
                      </button>
                    </div>
                  </div>
                </div>
                <div className="min-h-0 min-w-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white p-4">
                  {viewTab === "transcript" ? (
                    <TranscriptView segments={selected.transcript} isHistory />
                  ) : viewTab === "asrRaw" ? (
                    selectedAsrResult ? (
                      <div className="min-w-0 space-y-4 text-sm">
                        {asrResults.length > 0 && (
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <div>
                              <div className="text-sm font-medium text-slate-700">ASR 结果版本</div>
                              <div className="text-xs text-slate-400">仅用于查看识别结果，不影响会议纪要模板。</div>
                            </div>
                            <select
                              value={selectedAsrResult?.id ?? ""}
                              onChange={(e) => selected && loadAsrResultDetail(selected.id, e.target.value)}
                              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600"
                            >
                              {asrResults.map((result) => (
                                <option key={result.id} value={result.id}>
                                  {result.asrProvider} / {result.resultFormat}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className="grid min-w-0 gap-3 md:grid-cols-3">
                          <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="text-xs text-slate-400">Provider</div>
                            <div className="mt-1 break-words font-medium text-slate-700">{selectedAsrResult.asrProvider}</div>
                          </div>
                          <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="text-xs text-slate-400">Capture Session</div>
                            <div className="mt-1 truncate font-mono text-xs text-slate-700">{selectedAsrResult.captureSessionId}</div>
                          </div>
                          <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="text-xs text-slate-400">Format</div>
                            <div className="mt-1 break-words font-medium text-slate-700">{selectedAsrResult.resultFormat}</div>
                          </div>
                        </div>
                        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                          <div className="min-w-0">
                            <div className="mb-2 text-xs font-medium text-slate-500">ASR 配置快照</div>
                            <pre className="max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
                              {asrConfigText}
                            </pre>
                          </div>
                          <div className="min-w-0">
                            <div className="mb-2 text-xs font-medium text-slate-500">规范化文本</div>
                            <pre className="max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                              {selectedAsrResult.normalizedText || "-"}
                            </pre>
                          </div>
                        </div>
                        <div className="min-w-0">
                          <div className="mb-2 text-xs font-medium text-slate-500">原始 Payload</div>
                          <pre className="max-h-[28rem] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
                            {rawAsrPayloadText}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center text-slate-400">
                        <p>暂无原始 ASR 结果</p>
                      </div>
                    )
                  ) : (
                    <div className="flex min-h-full flex-col gap-4">
                      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-800">会议纪要版本</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {currentLlmResult
                              ? `当前版本 V${currentLlmResult.versionNo} / ${currentLlmResult.resultTitle}`
                              : "尚未生成纪要，请选择模板后生成。"}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {activePromptTemplates.length > 0 ? (
                            <select
                              value={selectedPromptTemplate?.id ?? ""}
                              onChange={(e) => setSelectedPromptTemplateId(e.target.value)}
                              className="min-w-44 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600"
                            >
                              {activePromptTemplates.map((template) => (
                                <option key={template.id} value={template.id}>
                                  {template.templateName}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-xs text-slate-400">将使用后台默认模板</span>
                          )}
                          <button
                            onClick={() => generateSummary(selectedPromptTemplate?.id)}
                            disabled={summaryGenerating}
                            className="rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark disabled:opacity-60"
                          >
                            {summaryGenerating ? "生成中..." : selected.summary ? "按模板生成新版本" : "生成纪要"}
                          </button>
                        </div>
                      </div>

                      {llmResults.length > 0 && (
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {llmResults.map((result) => (
                            <button
                              key={result.id}
                              onClick={() => selectLlmResult(result.id)}
                              className={`shrink-0 rounded-md border px-3 py-2 text-left text-sm ${
                                result.id === currentLlmResult?.id
                                  ? "border-brand bg-brand/5 text-brand"
                                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              }`}
                            >
                              <div className="font-medium">V{result.versionNo} / {result.resultTitle}</div>
                              <div className="mt-0.5 text-xs opacity-70">{result.generationMode}</div>
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="flex min-h-[18rem] flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
                        <div className="grid grid-cols-12 items-center gap-3 border-b border-slate-100 px-4 py-2">
                          <div className="col-span-9">
                            {currentLlmResult?.errorMessage ? (
                              <div className="text-xs text-amber-600">⚠️ {currentLlmResult.errorMessage}</div>
                            ) : (
                              <span className="text-xs text-slate-400">纪要内容</span>
                            )}
                          </div>
                          <div className="col-span-3 flex justify-end">
                            {currentLlmResult && (
                              <button
                                onClick={() => deleteLlmResult(currentLlmResult.id)}
                                className="rounded-md border border-slate-200 px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                              >
                                删除该版本
                              </button>
                            )}
                          </div>
                        </div>
                        {summaryGenerating ? (
                          <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center text-slate-400">
                            <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                            <p>正在生成会议纪要...</p>
                          </div>
                        ) : selected.summary ? (
                          editingSummary ? (
                            <textarea
                              value={summaryText}
                              onChange={(e) => setSummaryText(e.target.value)}
                              className="scroll-thin flex-1 min-h-[18rem] w-full resize-none whitespace-pre-wrap p-4 text-[15px] leading-relaxed text-slate-700 focus:outline-none"
                            />
                          ) : (
                            <div className="scroll-thin flex-1 min-h-[18rem] overflow-y-auto p-4">
                              <MarkdownPreview markdown={selected.summary} />
                            </div>
                          )
                        ) : (
                          <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center px-4 text-center text-slate-400">
                            <p>这个会议还没有纪要版本。</p>
                            <p className="mt-1 text-sm">选择模板后生成，生成结果会作为一个独立版本保留。</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  {viewTab === "transcript" && (
                  <button
                    onClick={async () => {
                      const text = selected.transcript.map((s) => s.text).join("");
                      try {
                        await navigator.clipboard.writeText(text);
                        showNotice("success", "转写全文已复制");
                      } catch (error) {
                        console.error("Failed to copy transcript:", error);
                        showNotice("error", "复制失败，请检查浏览器剪贴板权限");
                      }
                    }}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  >
                    复制全文
                  </button>
                  )}
                  {viewTab === "summary" && selected.summary && (
                    <>
                      {editingSummary ? (
                        <>
                          <button
                            onClick={saveSummaryEdit}
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
                              {record.errorMessage && (
                                <div className="mt-1 text-xs text-red-500">
                                  {record.errorMessage}
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
              <div className="mx-auto flex h-full max-w-5xl flex-col rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-800">新增录音</h2>
                    <p className="mt-1 text-sm text-slate-400">录音和上传只在这里操作；查看历史会议时不显示录音控件。</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <DeviceSelector
                      devices={devices}
                      value={device}
                      onChange={setDevice}
                    />
                    {status === "recording" && (
                      <div className="flex items-center gap-1 text-xs text-slate-400">
                        <span>音量</span>
                        <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200">
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
                      className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      上传音频
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

          {!selected && (
            <div className="border-t border-slate-100 bg-slate-50 px-6 py-1 text-xs text-slate-400">
              FunASR: {status === "recording" || status === "paused" ? "已连接" : "待连接"} | 设备: {selectedDeviceLabel}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
