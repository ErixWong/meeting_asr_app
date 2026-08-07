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
import {
  finalizeTranscriptSegments,
  updateTranscriptSegments,
  type TranscriptResult,
} from "@/lib/transcript-state";
import DeviceSelector from "@/components/main/DeviceSelector";
import MarkdownPreview from "@/components/main/MarkdownPreview";
import RecordingControls from "@/components/main/RecordingControls";
import TranscriptView from "@/components/main/TranscriptView";
import TranslationView, { TranslationBlock } from "@/components/main/TranslationView";
import HistoryList from "@/components/main/HistoryList";
import AsrResultDetailView from "@/components/main/AsrResultDetailView";
import { formatTime } from "@/components/main/RecordingControls";
import { useAuthSession } from "@/lib/use-auth-session";

let segCounter = 0;
const PARTIAL_RENDER_INTERVAL_MS = 150;
const TRANSLATE_TRIGGER_SENTENCES = 3;
const TRANSLATE_TRIGGER_INTERVAL_MS = 10_000;
const TRANSLATE_BUFFER_CHARS_MAX = 2000;

function formatAsrCreatedAt(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type ActionNotice = {
  type: "success" | "error" | "info";
  message: string;
};

type TranscriptCommitListener = (segments: TranscriptSegment[]) => void;

type PendingPartial = TranscriptResult & {
  generation: number;
};

type PendingTranslation = {
  text: string;
  time: string;
  timeSeconds: number;
};

class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export default function MeetingPage() {
  const [status, setStatus] = useState<RecordStatus>("idle");
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [speakerEnabled, setSpeakerEnabled] = useState(false);
  const [asrLang, setAsrLang] = useState<string>("auto");
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [targetLang, setTargetLang] = useState<string>("en");
  const [translations, setTranslations] = useState<TranslationBlock[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [liveSegments, setLiveSegments] = useState<TranscriptSegment[]>([]);
  const [selected, setSelected] = useState<MeetingRecord | null>(null);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [viewTab, setViewTab] = useState<"transcript" | "summary" | "asrRaw">("summary");
  const { user: currentUser } = useAuthSession(true);
  const isAdmin = Boolean(currentUser?.roles?.includes("system_admin"));
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
  const [asrErrorMessage, setAsrErrorMessage] = useState<string | null>(null);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const asrClientsRef = useRef<Map<string, FunASRClient>>(new Map());
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedMeetingIdRef = useRef<string | null>(null);
  const summaryGeneratingRef = useRef(false);
  const summaryGeneratingMeetingIdRef = useRef<string | null>(null);
  const voiceprintFeaturesRef = useRef<Map<string, VoiceprintFeature[]>>(new Map());
  const speakerIdsRef = useRef<Map<string, number[]>>(new Map());
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPartialRef = useRef<PendingPartial | null>(null);
  const transcriptGenerationRef = useRef(0);
  const transcriptSessionRef = useRef(0);
  const lastPartialRenderAtRef = useRef(0);
  const asrRecoveryRef = useRef(false);
  const persistedMeetingIdRef = useRef<string | null>(null);
  const persistedSegmentCountRef = useRef(0);
  const checkpointPromiseRef = useRef<Promise<void> | null>(null);
  const translationEnabledRef = useRef(false);
  const targetLangRef = useRef("en");
  const asrLangRef = useRef("auto");
  const pendingTranslateRef = useRef<PendingTranslation[]>([]);
  const translateInFlightRef = useRef(false);
  const translateGenerationRef = useRef(0);
  const translateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translateScheduledRef = useRef(false);
  const lastTranslateAtRef = useRef(0);
  const translationIdCounterRef = useRef(0);

  const showNotice = useCallback((type: ActionNotice["type"], message: string) => {
    setNotice({ type, message });
  }, []);

  const pickFallbackTargetLang = useCallback((lang: string) => (lang === "en" ? "zh" : "en"), []);

  const handleTranslationChange = useCallback(
    (enabled: boolean) => {
      if (enabled && asrLangRef.current !== "auto" && asrLangRef.current === targetLangRef.current) {
        const next = pickFallbackTargetLang(asrLangRef.current);
        targetLangRef.current = next;
        setTargetLang(next);
        showNotice("info", "目标语言与识别语种相同，已自动切换");
      }
      translationEnabledRef.current = enabled;
      setTranslationEnabled(enabled);
      if (!enabled) {
        resetTranslateRef.current();
      }
    },
    [pickFallbackTargetLang, showNotice]
  );

  const handleTargetLangChange = useCallback(
    (lang: string) => {
      targetLangRef.current = lang;
      setTargetLang(lang);
      if (asrLangRef.current !== "auto" && lang === asrLangRef.current) {
        const next = pickFallbackTargetLang(lang);
        targetLangRef.current = next;
        setTargetLang(next);
        showNotice("info", "目标语言不能与识别语种相同，已自动切换");
      }
    },
    [pickFallbackTargetLang, showNotice]
  );

  const handleAsrLangChange = useCallback(
    (lang: string) => {
      asrLangRef.current = lang;
      setAsrLang(lang);
      if (lang !== "auto" && lang === targetLangRef.current && translationEnabledRef.current) {
        const next = pickFallbackTargetLang(lang);
        targetLangRef.current = next;
        setTargetLang(next);
        showNotice("info", "目标语言与识别语种相同，已自动切换");
      }
    },
    [pickFallbackTargetLang, showNotice]
  );

  const updateSummaryGenerating = useCallback((value: boolean, meetingId?: string | null) => {
    summaryGeneratingRef.current = value;
    summaryGeneratingMeetingIdRef.current = value ? meetingId ?? summaryGeneratingMeetingIdRef.current : null;
    setSummaryGenerating(value);
  }, []);

  const clearPendingPartial = useCallback(() => {
    if (partialTimerRef.current !== null) {
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    pendingPartialRef.current = null;
  }, []);

  const resetTranscriptScheduler = useCallback(() => {
    transcriptGenerationRef.current += 1;
    transcriptSessionRef.current += 1;
    clearPendingPartial();
    lastPartialRenderAtRef.current = 0;
  }, [clearPendingPartial]);

  const commitTranscriptResult = useCallback(
    (result: TranscriptResult, onCommitted?: TranscriptCommitListener) => {
      setLiveSegments((prev) => {
        const next = updateTranscriptSegments(prev, result, () => `live-${segCounter++}`);
        segmentsRef.current = next;
        onCommitted?.(next);
        return next;
      });
    },
    []
  );

  const flushPendingPartial = useCallback(() => {
    partialTimerRef.current = null;
    const pending = pendingPartialRef.current;
    pendingPartialRef.current = null;

    if (!pending || pending.generation !== transcriptGenerationRef.current) return;

    lastPartialRenderAtRef.current = Date.now();
    commitTranscriptResult(pending);
  }, [commitTranscriptResult]);

  const queuePartialResult = useCallback(
    (result: TranscriptResult) => {
      pendingPartialRef.current = {
        ...result,
        generation: transcriptGenerationRef.current,
      };

      if (partialTimerRef.current !== null) return;

      const elapsedSinceLastRender = Date.now() - lastPartialRenderAtRef.current;
      const delay = lastPartialRenderAtRef.current === 0
        ? 0
        : Math.max(0, PARTIAL_RENDER_INTERVAL_MS - elapsedSinceLastRender);
      partialTimerRef.current = setTimeout(flushPendingPartial, delay);
    },
    [flushPendingPartial]
  );

  function scheduleTranslateTimer() {
    if (translateScheduledRef.current) return;
    if (pendingTranslateRef.current.length === 0) return;
    translateScheduledRef.current = true;
    translateTimerRef.current = setTimeout(() => {
      translateTimerRef.current = null;
      translateScheduledRef.current = false;
      processTranslateBuffer();
    }, TRANSLATE_TRIGGER_INTERVAL_MS);
  }

  function processTranslateBuffer(force = false) {
    if (!translationEnabledRef.current) return;
    const pending = pendingTranslateRef.current;
    if (pending.length === 0) return;
    if (translateInFlightRef.current) {
      scheduleTranslateTimer();
      return;
    }
    const totalChars = pending.reduce((sum, item) => sum + item.text.length, 0);
    const due = Date.now() - lastTranslateAtRef.current >= TRANSLATE_TRIGGER_INTERVAL_MS;
    if (!force && pending.length < TRANSLATE_TRIGGER_SENTENCES && totalChars <= TRANSLATE_BUFFER_CHARS_MAX && !due) {
      scheduleTranslateTimer();
      return;
    }

    translateInFlightRef.current = true;
    const generation = translateGenerationRef.current;
    const batch = pending;
    pendingTranslateRef.current = [];
    const targetLangCode = targetLangRef.current;
    void (async () => {
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentences: batch.map((item) => item.text), targetLang: targetLangCode }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; text?: unknown };
        if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
        const text = String(data.text ?? "").trim();
        if (!text) throw new Error("Empty translation response");
        if (generation !== translateGenerationRef.current) return;
        setTranslations((prev) => [
          ...prev,
          {
            id: ++translationIdCounterRef.current,
            text,
            time: batch[0].time,
            timeSeconds: batch[0].timeSeconds,
          },
        ]);
      } catch (error) {
        if (generation !== translateGenerationRef.current) return;
        console.warn("Translation failed, buffer retained for retry:", error);
        const merged = [...batch, ...pendingTranslateRef.current];
        while (
          merged.length > 0 &&
          merged.reduce((sum, item) => sum + item.text.length, 0) > TRANSLATE_BUFFER_CHARS_MAX
        ) {
          merged.shift();
        }
        pendingTranslateRef.current = merged;
      } finally {
        if (generation === translateGenerationRef.current) {
          translateInFlightRef.current = false;
          lastTranslateAtRef.current = Date.now();
          scheduleTranslateTimer();
        }
      }
    })();
  }

  const processTranslateRef = useRef<() => void>(() => {});
  processTranslateRef.current = processTranslateBuffer;

  const feedTranslationBuffer = useCallback((result: TranscriptResult) => {
    if (!translationEnabledRef.current) return;
    if (asrLangRef.current !== "auto" && asrLangRef.current === targetLangRef.current) return;
    const text = result.text.trim();
    if (!text) return;
    pendingTranslateRef.current.push({ text, time: result.time, timeSeconds: result.timeSeconds });
    processTranslateRef.current();
  }, []);

  function resetTranslationScheduler() {
    if (translateTimerRef.current !== null) {
      clearTimeout(translateTimerRef.current);
      translateTimerRef.current = null;
    }
    translateScheduledRef.current = false;
    pendingTranslateRef.current = [];
    translateInFlightRef.current = false;
    translateGenerationRef.current += 1;
    lastTranslateAtRef.current = 0;
    setTranslations([]);
  }

  function flushTranslationBuffer() {
    if (pendingTranslateRef.current.length === 0 || translateInFlightRef.current) return;
    processTranslateBuffer(true);
  }

  const flushTranslateRef = useRef<() => void>(() => {});
  flushTranslateRef.current = flushTranslationBuffer;

  const resetTranslateRef = useRef<() => void>(() => {});
  resetTranslateRef.current = resetTranslationScheduler;

  const commitFinalResult = useCallback(
    (result: TranscriptResult, onCommitted?: TranscriptCommitListener) => {
      transcriptGenerationRef.current += 1;
      clearPendingPartial();
      lastPartialRenderAtRef.current = 0;
      commitTranscriptResult(result, onCommitted);
      feedTranslationBuffer(result);
    },
    [clearPendingPartial, commitTranscriptResult, feedTranslationBuffer]
  );

  const handleTranscriptResult = useCallback(
    (result: TranscriptResult, onCommitted?: TranscriptCommitListener) => {
      if (result.isFinal) {
        commitFinalResult(result, onCommitted);
      } else {
        queuePartialResult(result);
      }
    },
    [commitFinalResult, queuePartialResult]
  );

  useEffect(() => {
    return () => {
      resetTranscriptScheduler();
      resetTranslateRef.current();
    };
  }, [resetTranscriptScheduler]);

  const requestJson = useCallback(async <T = unknown,>(input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const data: unknown = await res.json().catch(() => ({}));
    const error = typeof data === "object" && data !== null && "error" in data
      ? String(data.error)
      : `Request failed: ${res.status}`;
    if (!res.ok || (typeof data === "object" && data !== null && "error" in data)) {
      throw new ApiRequestError(error, res.status);
    }
    return data as T;
  }, []);

  const materializeCheckpointTranscript = useCallback(() => {
    if (partialTimerRef.current !== null) {
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }

    const pending = pendingPartialRef.current;
    pendingPartialRef.current = null;
    let nextSegments = segmentsRef.current;

    if (pending && pending.generation === transcriptGenerationRef.current) {
      lastPartialRenderAtRef.current = Date.now();
      nextSegments = updateTranscriptSegments(nextSegments, pending, () => `live-${segCounter++}`);
    }

    nextSegments = finalizeTranscriptSegments(nextSegments);
    segmentsRef.current = nextSegments;
    setLiveSegments(nextSegments);
    return nextSegments;
  }, []);

  const saveAsrCheckpoint = useCallback(async (segments: TranscriptSegment[], errorMessage: string) => {
    if (segments.length === 0 || !segments.some((segment) => segment.text.trim())) return;

    const captureSessionId = asrClientsRef.current.values().next().value?.getCaptureSessionId() || `capture-${Date.now()}`;
    let meetingId = persistedMeetingIdRef.current;

    if (!meetingId) {
      const now = new Date();
      const pad = (value: number) => value.toString().padStart(2, "0");
      const title = `录音 ${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const data = await requestJson<{ meeting?: MeetingRecord }>("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          sourceType: "live_recording",
          sourceFileName: null,
          durationSeconds: elapsedRef.current,
          captureSessionId,
          transcriptSegments: segments,
          triggerLlm: false,
        }),
      });
      const createdMeeting = data.meeting;
      meetingId = createdMeeting?.id ?? null;
      if (!meetingId) throw new Error("ASR checkpoint meeting was not created");
      persistedMeetingIdRef.current = meetingId;
      persistedSegmentCountRef.current = segments.length;
      if (createdMeeting) {
        setMeetings((prev) => [createdMeeting, ...prev]);
      }
    } else {
      const appendedSegments = segments.slice(persistedSegmentCountRef.current);
      if (appendedSegments.length > 0) {
        await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appendTranscriptSegments: appendedSegments,
            captureSessionId,
          }),
        });
        persistedSegmentCountRef.current = segments.length;
      }
    }

    const pausedData = await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "paused",
        lastErrorMessage: errorMessage,
      }),
    });
    const pausedMeeting = pausedData.meeting;
    if (pausedMeeting) {
      setMeetings((prev) => {
        const exists = prev.some((meeting) => meeting.id === pausedMeeting.id);
        return exists
          ? prev.map((meeting) => meeting.id === pausedMeeting.id ? pausedMeeting : meeting)
          : [pausedMeeting, ...prev];
      });
    }
  }, [requestJson]);

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
      setMicDeviceId((prev) => {
        if (prev !== null && mapped.some((d) => d.deviceId === prev)) return prev;
        return mapped.find((d) => d.deviceId !== "speaker")?.deviceId ?? null;
      });
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
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [loadRuntimeConfig, requestJson, showNotice]);

  const startRecording = useCallback(async (preserveTranscript = false) => {
    if (!preserveTranscript) {
      resetTranslationScheduler();
    }
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

    const activeDevices: string[] = [];
    if (micDeviceId) activeDevices.push(micDeviceId);
    if (speakerEnabled) activeDevices.push("speaker");
    if (activeDevices.length === 0) {
      showNotice("error", "请至少选择一个采集来源");
      return;
    }

    setStatus("connecting");
    setAsrErrorMessage(null);
    resetTranscriptScheduler();
    const recordingSession = transcriptSessionRef.current;
    asrRecoveryRef.current = false;
    if (!preserveTranscript) {
      persistedMeetingIdRef.current = null;
      persistedSegmentCountRef.current = 0;
      setLiveSegments([]);
      selectedMeetingIdRef.current = null;
      setSelected(null);
      voiceprintFeaturesRef.current = new Map();
      speakerIdsRef.current = new Map();
    }

    const clients = new Map<string, FunASRClient>();
    asrClientsRef.current = clients;
    const started: FunASRClient[] = [];

    try {
      for (const deviceId of activeDevices) {
        const client = new FunASRClient();
        clients.set(deviceId, client);
        const source: "mic" | "speaker" = deviceId === "speaker" ? "speaker" : "mic";
        const channelKey = deviceId;

        await client.startRecording(
          {
            onResult: (text, isFinal, speakerId, audioData) => {
              if (recordingSession !== transcriptSessionRef.current) return;

              let clusterSpeakerId = speakerId;

              if (isFinal && audioData && audioData.length > 1000) {
                try {
                  const features = extractFeatures(audioData, 16000);
                  const channelFeatures = voiceprintFeaturesRef.current.get(channelKey) ?? [];
                  channelFeatures.push(features);
                  voiceprintFeaturesRef.current.set(channelKey, channelFeatures);

                  if (channelFeatures.length >= 2) {
                    const ids = clusterSpeakers(channelFeatures, 0.6);
                    speakerIdsRef.current.set(channelKey, ids);
                    clusterSpeakerId = ids[ids.length - 1];
                  } else {
                    speakerIdsRef.current.set(channelKey, [0]);
                    clusterSpeakerId = 0;
                  }
                } catch (e) {
                  console.warn("[Voiceprint] Feature extraction failed:", e);
                }
              }

              handleTranscriptResult({
                text,
                isFinal,
                speakerId: clusterSpeakerId,
                source,
                deviceId: source === "mic" ? deviceId : undefined,
                time: formatTime(elapsedRef.current),
                timeSeconds: elapsedRef.current,
              });
            },
            onError: (error) => {
              console.error("FunASR error:", error);
              for (const activeClient of asrClientsRef.current.values()) {
                activeClient.stopRecording().catch((e) => console.warn("Failed to stop ASR session:", e));
              }
              asrClientsRef.current = new Map();
              if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
              }
              const checkpointSegments = materializeCheckpointTranscript();
              resetTranscriptScheduler();
              asrRecoveryRef.current = true;
              setAsrErrorMessage(error.message);
              setStatus("paused");
              showNotice("error", `ASR 连接失败，录音已暂停: ${error.message}`);

              if (!checkpointPromiseRef.current) {
                const checkpointPromise = saveAsrCheckpoint(checkpointSegments, error.message);
                checkpointPromiseRef.current = checkpointPromise;
                void checkpointPromise
                  .catch((checkpointError) => {
                    const message = checkpointError instanceof Error ? checkpointError.message : String(checkpointError);
                    setAsrErrorMessage(`${error.message}（自动保存失败：${message}）`);
                    showNotice("error", `ASR 已暂停，但自动保存失败: ${message}`);
                  })
                  .finally(() => {
                    if (checkpointPromiseRef.current === checkpointPromise) {
                      checkpointPromiseRef.current = null;
                    }
                  });
              }
            },
            onStatusChange: (s) => {
              if (s === "recording") {
                setStatus("recording");
                if (timerRef.current === null) {
                  if (!preserveTranscript) setElapsed(0);
                  timerRef.current = setInterval(
                    () => setElapsed((e) => e + 1),
                    1000
                  );
                }
              }
            },
            lang: asrLang,
          },
          deviceId
        );
        started.push(client);
      }
    } catch (error) {
      console.error("Failed to start recording:", error);
      for (const activeClient of started) {
        activeClient.stopRecording().catch((e) => console.warn("Failed to clean up ASR session:", e));
      }
      asrClientsRef.current = new Map();
      resetTranscriptScheduler();
      if (preserveTranscript) {
        asrRecoveryRef.current = true;
        const message = (error as Error).message;
        setAsrErrorMessage(message);
        setStatus("paused");
        showNotice("error", `ASR 重连失败，录音仍已暂停: ${message}`);
      } else {
        asrRecoveryRef.current = false;
        setStatus("idle");
        showNotice("error", `启动录音失败: ${(error as Error).message}`);
      }
    }
  }, [
    asrReady,
    asrLang,
    micDeviceId,
    speakerEnabled,
    handleTranscriptResult,
    loadRuntimeConfig,
    materializeCheckpointTranscript,
    resetTranscriptScheduler,
    saveAsrCheckpoint,
    showNotice,
  ]);

  const pauseRecording = useCallback(() => {
    if (asrClientsRef.current.size === 0) return;
    asrRecoveryRef.current = false;
    setAsrErrorMessage(null);
    for (const activeClient of asrClientsRef.current.values()) {
      activeClient.pause();
    }
    setStatus("paused");
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resumeRecording = useCallback(async () => {
    if (asrRecoveryRef.current) {
      if (checkpointPromiseRef.current) {
        await checkpointPromiseRef.current.catch((error) => {
          console.warn("ASR checkpoint did not complete before resume:", error);
        });
      }

      for (const activeClient of asrClientsRef.current.values()) {
        await activeClient.stopRecording().catch((error) => {
          console.warn("Failed to clean up failed ASR session:", error);
        });
      }
      asrClientsRef.current = new Map();

      await startRecording(true);
      return;
    }

    if (asrClientsRef.current.size > 0) {
      setAsrErrorMessage(null);
      for (const activeClient of asrClientsRef.current.values()) {
        activeClient.resume();
      }
      setStatus("recording");
      timerRef.current = setInterval(
        () => setElapsed((e) => e + 1),
        1000
      );
    }
  }, [startRecording]);

  const stopRecording = useCallback(async () => {
    flushTranslateRef.current();
    if (checkpointPromiseRef.current) {
      await checkpointPromiseRef.current.catch((error) => {
        console.warn("ASR checkpoint did not complete before stop:", error);
      });
    }

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setStatus("generating");

    let recordingCaptureSessionId = "";
    if (asrClientsRef.current.size > 0) {
      const firstClient = asrClientsRef.current.values().next().value;
      for (const activeClient of asrClientsRef.current.values()) {
        await activeClient.stopRecording();
      }
      recordingCaptureSessionId = firstClient?.getCaptureSessionId() ?? "";
      asrClientsRef.current = new Map();
    }

    resetTranscriptScheduler();
    const finalSegments = segmentsRef.current.filter((segment) => segment.isFinal);
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
      const existingMeetingId = persistedMeetingIdRef.current;
      const data = existingMeetingId
        ? await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${existingMeetingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              appendTranscriptSegments: finalSegments.slice(persistedSegmentCountRef.current),
              captureSessionId: recordingCaptureSessionId || `capture-${Date.now()}`,
              title,
              status: "transcribed",
              lastErrorMessage: null,
              finalize: true,
            }),
          })
        : await requestJson<{ meeting?: MeetingRecord }>("/api/meetings", {
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
        setMeetings((prev) => {
          const exists = prev.some((item) => item.id === meeting.id);
          return exists
            ? prev.map((item) => item.id === meeting.id ? meeting : item)
            : [meeting, ...prev];
        });
        selectedMeetingIdRef.current = meeting.id;
        setSelected(meeting);
        setLlmResults([]);
        setSelectedLlmResultId(null);
        setSendRecords([]);
        setAsrResults([]);
        setSelectedAsrResult(null);
        primeMeetingAsyncState(meeting.id).catch(console.error);
      }
      persistedMeetingIdRef.current = null;
      persistedSegmentCountRef.current = 0;
      setLiveSegments([]);
      setAsrErrorMessage(null);
      setStatus("idle");
      setElapsed(0);
    } catch (error) {
      console.error("Failed to save meeting:", error);
      showNotice("error", "会议保存失败");
      setStatus("idle");
    } finally {
      setSavingMeeting(false);
    }
  }, [primeMeetingAsyncState, requestJson, resetTranscriptScheduler, showNotice]);

  const handleCreateNew = useCallback(() => {
    resetTranscriptScheduler();
    resetTranslateRef.current();
    asrRecoveryRef.current = false;
    persistedMeetingIdRef.current = null;
    persistedSegmentCountRef.current = 0;
    setAsrErrorMessage(null);
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
  }, [resetTranscriptScheduler, updateSummaryGenerating]);

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
      if (error instanceof ApiRequestError && error.status === 401) return;
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
      if (error instanceof ApiRequestError && error.status === 401) return;
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
      if (error instanceof ApiRequestError && error.status === 401) return;
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
      if (error instanceof ApiRequestError && error.status === 401) return;
      console.error("Failed to load asr result detail:", error);
      if (!isActiveMeeting(meetingId)) return;
      setSelectedAsrResult(null);
    }
  }, [isActiveMeeting, requestJson]);

  const refreshMeeting = useCallback(async (meetingId: string) => {
    const data = await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}?view=light`);
    const meeting = data.meeting;
    if (!meeting) return null;

    setMeetings((prev) => prev.map((item) => (item.id === meetingId ? meeting : item)));
    setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, ...meeting, transcript: prev.transcript } : meeting));
    return meeting;
  }, [requestJson]);

  useEffect(() => {
    if (!selected?.id || selected.status !== "llm_processing") {
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
    resetTranscriptScheduler();
    const uploadSession = transcriptSessionRef.current;
    setLiveSegments([]);
    selectedMeetingIdRef.current = null;
    setSelected(null);

    const client = new FunASRClient();
    asrClientsRef.current = new Map([["upload", client]]);

    const allSegments: TranscriptSegment[] = [];

    try {
      const uploadTimeSeconds = 0;
      await client.transcribeFile(
        file,
        (text, isFinal, speakerId) => {
          if (uploadSession !== transcriptSessionRef.current) return;

          if (!isFinal) {
            setStatus("recording");
          }

          handleTranscriptResult(
            {
              text,
              isFinal,
              speakerId,
              time: formatTime(uploadTimeSeconds),
              timeSeconds: uploadTimeSeconds,
            },
            isFinal
              ? (segments) => {
                  allSegments.length = 0;
                  allSegments.push(...segments.filter((segment) => segment.isFinal));
                }
              : undefined
          );
        },
        (progress) => {
          console.log("[Upload] progress:", progress + "%");
        },
        asrLang
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

      resetTranscriptScheduler();
      setLiveSegments([]);
      setStatus("idle");
    } catch (err) {
      console.error("Upload transcribe failed:", err);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      asrClientsRef.current = new Map();
      flushPendingPartial();
      resetTranscriptScheduler();
      showNotice("error", `音频识别失败: ${(err as Error).message}`);
      setStatus("idle");
    } finally {
      setSavingMeeting(false);
    }
  }, [
    asrReady,
    asrLang,
    flushPendingPartial,
    handleTranscriptResult,
    loadRuntimeConfig,
    primeMeetingAsyncState,
    requestJson,
    resetTranscriptScheduler,
    showNotice,
  ]);

  const generateSummary = useCallback(async (promptTemplateId?: string) => {
    if (!selected || summaryGeneratingRef.current) return;
    const meetingId = selected.id;
    updateSummaryGenerating(true, meetingId);
    try {
      await requestJson(`/api/meetings/${meetingId}/llm-results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promptTemplateId ? { promptTemplateId } : {}),
      });
      if (!isActiveMeeting(meetingId)) return;
      setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, status: "llm_processing" } : prev));
      showNotice("info", "会议纪要生成已开始，完成后自动更新");
    } catch (err) {
      console.error("Generate summary failed:", err);
      if (!isActiveMeeting(meetingId)) return;
      await refreshMeeting(meetingId).catch(console.error);
      if (err instanceof ApiRequestError && err.status === 409) {
        showNotice("info", "纪要正在生成中，请稍候");
      } else {
        showNotice("error", `生成会议纪要失败: ${(err as Error).message}`);
      }
    } finally {
      if (summaryGeneratingMeetingIdRef.current === meetingId) {
        updateSummaryGenerating(false, null);
      }
    }
  }, [isActiveMeeting, refreshMeeting, requestJson, selected, showNotice, updateSummaryGenerating]);

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

  const selectedDeviceLabel = (() => {
    const parts: string[] = [];
    if (micDeviceId) {
      const label = devices.find((d) => d.deviceId === micDeviceId)?.label ?? micDeviceId;
      parts.push(`🎤 ${label}`);
    }
    if (speakerEnabled) parts.push("🔊 系统声音");
    return parts.join("、") || "未选择";
  })();
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
                 resetTranscriptScheduler();
                 asrRecoveryRef.current = false;
                 persistedMeetingIdRef.current = null;
                 persistedSegmentCountRef.current = 0;
                 setAsrErrorMessage(null);
                 selectedMeetingIdRef.current = m.id;
                setSelected(m);
                updateSummaryGenerating(false, null);
                setSendingMail(false);
                setLiveSegments([]);
                setViewTab("summary");
                loadLlmResults(m.id).catch(console.error);
                loadSendRecords(m.id).catch(console.error);
                loadAsrResults(m.id).catch(console.error);
                requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${m.id}`)
                  .then((data) => {
                    const meeting = data.meeting;
                    if (!meeting || selectedMeetingIdRef.current !== m.id) return;
                    setSelected(meeting);
                    setMeetings((prev) => prev.map((item) => (item.id === m.id ? meeting : item)));
                  })
                  .catch(console.error);
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
                        onClick={() => setViewTab("transcript")}
                        className={`rounded-md px-3 py-1 text-sm ${
                          viewTab === "transcript"
                            ? "bg-white text-brand shadow-sm"
                            : "text-slate-500"
                        }`}
                      >
                        转写记录
                      </button>
                      {isAdmin && (
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
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-4">
                  {viewTab === "transcript" ? (
                    <TranscriptView segments={selected.transcript} />
                  ) : viewTab === "asrRaw" ? (
                    asrResults.length === 0 ? (
                      <div className="flex h-full flex-col items-center justify-center text-slate-400">
                        <p>暂无原始 ASR 结果</p>
                      </div>
                    ) : (
                      <div className="flex min-h-0 flex-1 gap-4">
                        <div className="flex w-72 shrink-0 flex-col">
                          <div>
                            <div className="text-sm font-semibold text-slate-700">ASR 识别记录</div>
                            <div className="mt-0.5 text-xs text-slate-400">每次转写写入一条记录，点击查看详情。</div>
                          </div>
                          <div className="scroll-thin mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
                            {asrResults.map((result) => {
                              const active = selectedAsrResult?.id === result.id;
                              return (
                                <button
                                  key={result.id}
                                  onClick={() => selected && loadAsrResultDetail(selected.id, result.id)}
                                  className={`mb-1 w-full rounded-lg border-l-2 px-3 py-2 text-left transition ${
                                    active ? "border-brand bg-brand/5" : "border-transparent hover:bg-slate-100"
                                  }`}
                                >
                                  <div className="truncate text-sm font-medium text-slate-700">
                                    {result.asrProvider} / {result.resultFormat}
                                  </div>
                                  <div className="mt-0.5 truncate text-xs text-slate-400">
                                    {formatAsrCreatedAt(result.createdAt)} · {result.captureSessionId}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="scroll-thin min-w-0 flex-1 overflow-y-auto pl-2">
                          {selectedAsrResult ? (
                            <AsrResultDetailView result={selectedAsrResult} />
                          ) : (
                            <div className="flex h-full flex-col items-center justify-center text-slate-400">
                              <p>选择左侧记录查看详情</p>
                            </div>
                          )}
                        </div>
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
              <div className="flex h-full w-full flex-col rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-800">新增录音</h2>
                    <p className="mt-1 text-sm text-slate-400">录音和上传只在这里操作；查看历史会议时不显示录音控件。</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <DeviceSelector
                      devices={devices}
                      micDeviceId={micDeviceId}
                      onMicChange={setMicDeviceId}
                      speakerEnabled={speakerEnabled}
                      onSpeakerChange={setSpeakerEnabled}
                      asrLang={asrLang}
                      onLangChange={handleAsrLangChange}
                      translationEnabled={translationEnabled}
                      onTranslationChange={handleTranslationChange}
                      targetLang={targetLang}
                      onTargetLangChange={handleTargetLangChange}
                      disabled={status === "recording" || status === "paused" || status === "connecting"}
                    />
                    {status === "recording" && (
                      <div className="flex items-center gap-1 text-xs text-slate-400">
                        <span>音量</span>
                        <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200">
                          <div className="h-full w-3/5 animate-pulse bg-green-500" />
                        </div>
                      </div>
                    )}
                    <RecordingControls
                      status={status}
                      onStart={startRecording}
                      onPause={pauseRecording}
                      onResume={resumeRecording}
                      onStop={stopRecording}
                    />
                    <div className="hidden h-6 w-px bg-slate-200 sm:block" />
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
                  </div>
                 </div>
                {(status === "idle" || status === "done") && (
                  <div className="border-b border-slate-100 bg-amber-50 px-4 py-2 text-xs text-amber-600">
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
                )}
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
                    <span className="min-w-0 truncate text-slate-600" title={asrErrorMessage ?? undefined}>
                      {status === "recording"
                        ? `录音中 ${formatTime(elapsed)}`
                        : status === "paused"
                         ? asrErrorMessage
                           ? `ASR 已暂停：${asrErrorMessage}`
                           : `已暂停 ${formatTime(elapsed)}`
                         : savingMeeting
                        ? "保存会议中..."
                        : "连接中..."}
                    </span>
                    <span className="ml-auto text-slate-400">
                      FunASR:{" "}
                        {status === "recording" ? (
                          <span className="text-green-600">已连接</span>
                        ) : status === "paused" && asrErrorMessage ? (
                          <span className="text-red-600">连接异常</span>
                        ) : (
                          "连接中"
                      )}
                    </span>
                  </div>
                ) : null}
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1">
                    <TranscriptView segments={liveSegments} />
                  </div>
                  {translationEnabled && (
                    <>
                      <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/60 px-2 py-1 text-xs text-slate-400">
                        <span>🌐 译文</span>
                      </div>
                      <div className="min-h-0 flex-1">
                        <TranslationView translations={translations} />
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {!selected && (
            <div className="border-t border-slate-100 bg-slate-50 px-6 py-1 text-xs text-slate-400">
              FunASR: {status === "recording" || status === "paused" ? asrErrorMessage ? "连接异常" : "已连接" : "待连接"} | 设备: {selectedDeviceLabel}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
