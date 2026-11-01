"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  RecordStatus,
  MeetingAsrResult,
  MeetingAsrResultDetail,
  MeetingLlmResultSummary,
  MeetingLlmResultContent,
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
  identifyVoiceprint,
  getVoiceprintConfig,
  VoiceprintApiError,
} from "@/lib/voiceprint-api";
import {
  finalizeTranscriptSegments,
  updateTranscriptSegments,
  type TranscriptResult,
} from "@/lib/transcript-state";
import MarkdownPreview from "@/components/main/MarkdownPreview";
import RecordingControls from "@/components/main/RecordingControls";
import RecordSetupModal from "@/components/main/RecordSetupModal";
import TranscriptView from "@/components/main/TranscriptView";
import TranslationView, { TranslationBlock } from "@/components/main/TranslationView";
import HistoryList from "@/components/main/HistoryList";
import AsrResultDetailView from "@/components/main/AsrResultDetailView";
import { formatTime } from "@/components/main/RecordingControls";
import { useAuthSession } from "@/lib/use-auth-session";
import { useTts } from "@/components/tts/TtsProvider";
import TtsReadableSync from "@/components/tts/TtsReadableSync";

let segCounter = 0;
const PARTIAL_RENDER_INTERVAL_MS = 150;
const TRANSLATE_TRIGGER_INTERVAL_MS = 10_000;
const TRANSLATE_BUFFER_CHARS_MAX = 2000;
/** R2 F2：录音转码状态有界轮询（8 秒 × 12 次 ≈ 96 秒，用尽即停）。 */
const AUDIO_PENDING_POLL_INTERVAL_MS = 8000;
const AUDIO_PENDING_POLL_MAX_ATTEMPTS = 12;
const SYSTEM_TRANSLATE_TEMPLATE_ID = "tpl-translate";
const HISTORY_TRANSLATE_LANGS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英文" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
];

/** 录音时长 mm:ss（feat-261101-01）。 */
function formatAudioDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/** 录音体积 MB（1 位小数）。 */
function formatAudioSize(bytes: number): string {
  const mb = (Number(bytes) || 0) / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function getTranslationLangLabel(result: MeetingLlmResultSummary): string | null {
  if (result.resultType !== "translation" || !result.generationConfigSnapshot) return null;
  try {
    const snapshot = JSON.parse(result.generationConfigSnapshot) as { targetLang?: string };
    if (!snapshot?.targetLang) return null;
    return HISTORY_TRANSLATE_LANGS.find((lang) => lang.value === snapshot.targetLang)?.label ?? snapshot.targetLang;
  } catch {
    return null;
  }
}

function formatAsrCreatedAt(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getTranscriptPlainText(segments: TranscriptSegment[]) {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join("\n");
}

type ActionNotice = {
  type: "success" | "error" | "info";
  message: string;
  /** feat-261101-04（#44）：toast 里的一次性动作（AI 标题的「撤销」） */
  action?: { label: string; onClick: () => void };
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
  const [micMuted, setMicMuted] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [micRefreshing, setMicRefreshing] = useState(false);
  const [speakerEnabled, setSpeakerEnabled] = useState(false);
  const [asrLang, setAsrLang] = useState<string>("auto");
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [targetLang, setTargetLang] = useState<string>("en");
  const [translations, setTranslations] = useState<TranslationBlock[]>([]);
  const [llmQueueInfo, setLlmQueueInfo] = useState<{ inFlight: number; queued: number; dropped: number } | null>(null);
  const [lastTranslateElapsedMs, setLastTranslateElapsedMs] = useState<number | null>(null);
  const [historyTranslateLang, setHistoryTranslateLang] = useState("en");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [translationGenerating, setTranslationGenerating] = useState(false);
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
  const [llmResults, setLlmResults] = useState<MeetingLlmResultSummary[]>([]);
  const [llmContentById, setLlmContentById] = useState<Record<string, string>>({});
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [selectedPromptTemplateId, setSelectedPromptTemplateId] = useState<string>("");
  const [mailTo, setMailTo] = useState("");
  const [mailCc, setMailCc] = useState("");
  const [sendRecords, setSendRecords] = useState<MeetingSendRecord[]>([]);
  const [asrResults, setAsrResults] = useState<MeetingAsrResult[]>([]);
  const [selectedAsrResult, setSelectedAsrResult] = useState<MeetingAsrResultDetail | null>(null);
  const [sendingMail, setSendingMail] = useState(false);
  const [sendModalOpen, setSendModalOpen] = useState(false);
  const [sendRecordsModalOpen, setSendRecordsModalOpen] = useState(false);
  const [selectionModalOpen, setSelectionModalOpen] = useState(false);
  const [selectionLang, setSelectionLang] = useState("en");
  const [selectionText, setSelectionText] = useState("");
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [selectionResult, setSelectionResult] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const [asrReady, setAsrReady] = useState(false);
  const [asrErrorMessage, setAsrErrorMessage] = useState<string | null>(null);
  // issue #61：ASR 链路（WebSocket）不可用时的**持续**告警。
  // 不用 toast（3.5s 就消失，用户以为还在录），而是常驻页面顶部，
  // 直到连接恢复 / 重新开始录音 / 用户手动关闭。
  const [asrLinkError, setAsrLinkError] = useState<string | null>(null);
  const [savingMeeting, setSavingMeeting] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  // feat-261101-04（#44）：AI 起标题进行中的会议 id（按钮 loading 态）
  const [aiTitleLoadingId, setAiTitleLoadingId] = useState<string | null>(null);
  const { isSupported, isSpeaking, canRead, hasSelection, setReadableText, toggleSpeak } = useTts();
  const readableText = selected
    ? viewTab === "transcript"
      ? getTranscriptPlainText(selected.transcript)
      : viewTab === "asrRaw"
        ? selectedAsrResult?.normalizedText ?? ""
        : editingSummary
          ? summaryText
          : selected.summary
    : getTranscriptPlainText(liveSegments);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const asrClientsRef = useRef<Map<string, FunASRClient>>(new Map());
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedMeetingIdRef = useRef<string | null>(null);
  const fullDetailLoadedRef = useRef(false);
  const selectedVersionIdRef = useRef<string | null>(null);
  const llmContentByIdRef = useRef<Record<string, string>>({});
  const autoSelectTranslationRef = useRef(false);
  const summaryGeneratingRef = useRef(false);
  const summaryGeneratingMeetingIdRef = useRef<string | null>(null);
  const voiceprintFeaturesRef = useRef<Map<string, VoiceprintFeature[]>>(new Map());
  const speakerIdsRef = useRef<Map<string, number[]>>(new Map());
  const voiceprintEnabledRef = useRef(true);
  const voiceprintCooldownUntilRef = useRef(0);
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPartialRef = useRef<PendingPartial | null>(null);
  const transcriptGenerationRef = useRef(0);
  const transcriptSessionRef = useRef(0);
  const lastPartialRenderAtRef = useRef(0);
  const asrRecoveryRef = useRef(false);
  // 用户主动停止（而非链路故障）时为 true：避免 stop 时的 onclose 被误判成「连接断开」告警
  const asrStopIntentRef = useRef(false);
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
  const translateTriggerSentencesRef = useRef(3);
  const translationIdCounterRef = useRef(0);
  const translationsRef = useRef<TranslationBlock[]>([]);
  translationsRef.current = translations;

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
    if (!force && pending.length < translateTriggerSentencesRef.current && totalChars <= TRANSLATE_BUFFER_CHARS_MAX && !due) {
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
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; text?: unknown; elapsedMs?: unknown };
        if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
        const text = String(data.text ?? "").trim();
        if (!text) throw new Error("Empty translation response");
        if (generation !== translateGenerationRef.current) return;
        if (typeof data.elapsedMs === "number" && Number.isFinite(data.elapsedMs)) {
          setLastTranslateElapsedMs(data.elapsedMs);
        }
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

  // 加载声纹服务配置（enabled 决定是否在每句 final 后调用服务端识别）
  useEffect(() => {
    let cancelled = false;
    getVoiceprintConfig()
      .then((config) => {
        if (!cancelled) voiceprintEnabledRef.current = config.enabled;
      })
      .catch(() => {
        // 服务不可达/未部署：保持默认启用，识别失败时自动冷却降级
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 服务端声纹识别（CAM++）：命中则用人名覆盖段 speaker 字段，不阻塞录音主流程。
   * 服务不可用 → 冷却 30s 静默降级，前端启发式聚类照常工作。
   */
  const scheduleVoiceprintIdentify = useCallback((segmentId: string, audioData: Float32Array) => {
    if (!voiceprintEnabledRef.current) return;
    if (Date.now() < voiceprintCooldownUntilRef.current) return;

    identifyVoiceprint(audioData, 16000)
      .then((result) => {
        if (!result.matched || !result.speaker) return;
        setLiveSegments((prev) =>
          prev.map((seg) =>
            seg.id === segmentId ? { ...seg, speaker: result.speaker as string } : seg
          )
        );
      })
      .catch((error) => {
        if (error instanceof VoiceprintApiError) {
          // 声纹服务不可用：冷却 30s，期间不再发起请求，录音/聚类不受影响
          voiceprintCooldownUntilRef.current = Date.now() + 30000;
          console.warn("[Voiceprint] server voiceprint unavailable, fallback to clustering:", error.message);
        } else {
          console.warn("[Voiceprint] identify failed:", error);
        }
      });
  }, []);

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

  const persistLiveTranslations = useCallback(async (meetingId: string) => {
    const blocks = translationsRef.current;
    if (blocks.length === 0) return;
    await requestJson(`/api/meetings/${meetingId}/live-translation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetLang: targetLangRef.current, blocks }),
    });
  }, [requestJson]);

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

    const captureSessionIds = Array.from(asrClientsRef.current.values())
      .map((activeClient) => activeClient.getCaptureSessionId())
      .filter((id): id is string => Boolean(id));
    const captureSessionId = captureSessionIds[0] || `capture-${Date.now()}`;
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
          captureSessionIds,
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
            captureSessionIds,
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
        requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}?view=light`),
        requestJson<{ llmResults?: MeetingLlmResultSummary[] }>(`/api/meetings/${meetingId}/llm-results`).catch(() => ({ llmResults: [] })),
      ]);

      if (!isActiveMeeting(meetingId)) return;

      const latestMeeting = meetingData.meeting;
      if (latestMeeting) {
        setMeetings((prev) => prev.map((item) => (item.id === meetingId ? latestMeeting : item)));
        setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, ...latestMeeting, transcript: prev.transcript } : prev));
      }

      const nextResults = llmData.llmResults ?? [];
      setLlmResults(nextResults);
      setSelectedVersionId((prev) => (prev && nextResults.some((item) => item.id === prev) ? prev : null));
    } catch (error) {
      console.error("Failed to prime meeting async state:", error);
    }
  }, [isActiveMeeting, requestJson]);

  useEffect(() => {
    if (!notice) return;

    // feat-261101-04（#44）R2：**带 action 的提示不参与自动消失**。
    // 真实 LLM 延迟实测 4.2s～13.3s 浮动，而普通提示 3.5s 就自己没了 —— 撤销入口会变成装饰
    // （浏览器实测「撤销」条只存活 3509ms，用户很可能根本没看见）。
    // 只有用户点「撤销」/「关闭」才消失；撤销之后 notice 被换成**不带 action** 的普通提示，
    // 那时按原时长（error 7000ms / 其余 3500ms）自动消失 —— 一次性撤销，不给第二次入口。
    if (notice.action) return;

    const timer = window.setTimeout(() => {
      setNotice(null);
    }, notice.type === "error" ? 7000 : 3500);

    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!translationEnabled || (status !== "recording" && status !== "paused" && status !== "connecting")) {
      setLlmQueueInfo(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await requestJson<{ inFlight?: number; queued?: number; dropped?: number }>("/api/llm-queue-status");
        if (cancelled) return;
        setLlmQueueInfo({
          inFlight: Number(data.inFlight ?? 0),
          queued: Number(data.queued ?? 0),
          dropped: Number(data.dropped ?? 0),
        });
      } catch {
        if (!cancelled) setLlmQueueInfo(null);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [translationEnabled, status, requestJson]);

  const loadRuntimeConfig = useCallback(async () => {
    const data = await requestJson<{ asr?: { isConfigured?: boolean }; llm?: { translateTriggerSentences?: number } }>("/api/config");
    const nextAsrReady = Boolean(data.asr?.isConfigured);
    const nextTriggerSentences = Number(data.llm?.translateTriggerSentences);
    if (Number.isFinite(nextTriggerSentences) && nextTriggerSentences > 0) {
      translateTriggerSentencesRef.current = nextTriggerSentences;
    }

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

  const refreshMicDevices = useCallback(async () => {
    setMicRefreshing(true);
    try {
      const deviceList = await getAudioDevices({ requestPermission: true });
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
    } catch (error) {
      console.error("Failed to refresh mic devices:", error);
      showNotice("error", `刷新麦克风设备失败: ${(error as Error).message}`);
    } finally {
      setMicRefreshing(false);
    }
  }, [showNotice]);

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
    // 新一轮录音：清掉上一轮的链路告警，并标记「非用户主动停止」
    setAsrLinkError(null);
    asrStopIntentRef.current = false;
    resetTranscriptScheduler();
    const recordingSession = transcriptSessionRef.current;
    asrRecoveryRef.current = false;
    if (!preserveTranscript) {
      persistedMeetingIdRef.current = null;
      persistedSegmentCountRef.current = 0;
      setLiveSegments([]);
      setMicMuted(false);
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

              handleTranscriptResult(
                {
                  text,
                  isFinal,
                  speakerId: clusterSpeakerId,
                  source,
                  deviceId: source === "mic" ? deviceId : undefined,
                  time: formatTime(elapsedRef.current),
                  timeSeconds: elapsedRef.current,
                },
                // 服务端声纹识别：仅 final 且有句音频时提交异步识别（不阻塞、先聚类后更新）
                // 门槛 3200 样本(0.2s) 与服务端 MIN_AUDIO_SAMPLES 对齐，过短音频不调识别（避免误触发降级冷却）
                isFinal && audioData && audioData.length >= 3200
                  ? (next) => {
                      const targetKey = `${source}:${source === "mic" ? deviceId : ""}`;
                      for (let i = next.length - 1; i >= 0; i--) {
                        const seg = next[i];
                        if (
                          seg.isFinal &&
                          seg.text === text &&
                          `${seg.source ?? "mic"}:${seg.deviceId ?? ""}` === targetKey
                        ) {
                          scheduleVoiceprintIdentify(seg.id, audioData);
                          break;
                        }
                      }
                    }
                  : undefined
              );
            },
            onError: (error) => {
              console.error("FunASR error:", error);
              // issue #61：链路不可用时必须**持续可见**（不只是 toast），文案点明后果
              setAsrLinkError(error.message);
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
                // 连上了：自动收掉告警
                setAsrLinkError(null);
                setStatus("recording");
                if (timerRef.current === null) {
                  if (!preserveTranscript) setElapsed(0);
                  timerRef.current = setInterval(
                    () => setElapsed((e) => e + 1),
                    1000
                  );
                }
              } else if (s === "disconnected" && !asrStopIntentRef.current) {
                // 录音中链路被关掉（网络/服务重启）：以前这里只打 console，用户以为还在录
                setAsrLinkError("与语音识别服务的连接已断开");
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

  const toggleMuteMic = useCallback(() => {
    setMicMuted((prev) => {
      const next = !prev;
      for (const [deviceId, activeClient] of asrClientsRef.current.entries()) {
        if (deviceId !== "speaker") {
          if (next) activeClient.pause();
          else activeClient.resume();
        }
      }
      return next;
    });
  }, []);

  const pauseRecording = useCallback(() => {
    if (asrClientsRef.current.size === 0) return;
    asrRecoveryRef.current = false;
    setAsrErrorMessage(null);
    // 暂停是用户主动行为，不是链路故障；旧告警不再适用（但保留 asrLinkError 的实时值不影响这里）
    for (const activeClient of asrClientsRef.current.values()) {
      activeClient.pause();
    }
    setStatus("paused");
    setMicMuted(false);
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
    // 用户主动停止：先置意图标志（stop 时的 onclose 不应报「连接断开」），并收掉链路告警
    asrStopIntentRef.current = true;
    setAsrLinkError(null);
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
    setMicMuted(false);

    let recordingCaptureSessionId = "";
    let recordingCaptureSessionIds: string[] = [];
    if (asrClientsRef.current.size > 0) {
      // feat-261101-01：双通道要上报**全部** capture session id（音频每条一个）
      recordingCaptureSessionIds = Array.from(asrClientsRef.current.values())
        .map((activeClient) => activeClient.getCaptureSessionId())
        .filter((id): id is string => Boolean(id));
      for (const activeClient of asrClientsRef.current.values()) {
        await activeClient.stopRecording();
      }
      recordingCaptureSessionId = recordingCaptureSessionIds[0] ?? "";
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
              captureSessionIds: recordingCaptureSessionIds,
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
              captureSessionIds: recordingCaptureSessionIds,
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
        setSelectedVersionId(null);
        setSendRecords([]);
        setAsrResults([]);
        setSelectedAsrResult(null);
        primeMeetingAsyncState(meeting.id).catch(console.error);
        void persistLiveTranslations(meeting.id).catch((error) => {
          console.warn("Failed to persist live translation:", error);
        });
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
  }, [persistLiveTranslations, primeMeetingAsyncState, requestJson, resetTranscriptScheduler, showNotice]);

  const handleCreateNew = useCallback(() => {
    resetTranscriptScheduler();
    resetTranslateRef.current();
    asrRecoveryRef.current = false;
    persistedMeetingIdRef.current = null;
    persistedSegmentCountRef.current = 0;
    setAsrErrorMessage(null);
    selectedMeetingIdRef.current = null;
    fullDetailLoadedRef.current = false;
    setSelected(null);
    updateSummaryGenerating(false, null);
    setSendingMail(false);
    setLiveSegments([]);
    setStatus("idle");
    setElapsed(0);
    setLlmResults([]);
    setSelectedVersionId(null);
    autoSelectTranslationRef.current = false;
    setSendRecords([]);
    setAsrResults([]);
    setSelectedAsrResult(null);
  }, [resetTranscriptScheduler, updateSummaryGenerating]);

  const loadLlmResults = useCallback(async (meetingId: string) => {
    try {
      const data = await requestJson<{ llmResults?: MeetingLlmResultSummary[] }>(`/api/meetings/${meetingId}/llm-results`);
      if (!isActiveMeeting(meetingId)) return;
      const nextResults = data.llmResults ?? [];
      const prevSelected = selectedVersionIdRef.current;
      const preserved =
        prevSelected && nextResults.some((item) => item.id === prevSelected)
          ? prevSelected
          : null;
      setLlmResults(nextResults);
      setSelectedVersionId(preserved);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) return;
      console.error("Failed to load llm results:", error);
      if (!isActiveMeeting(meetingId)) return;
      setLlmResults([]);
      setSelectedVersionId(null);
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

  useEffect(() => {
    selectedVersionIdRef.current = selectedVersionId;
  }, [selectedVersionId]);

  const loadLlmResultContent = useCallback(
    async (meetingId: string, resultId: string): Promise<string> => {
      const data = await requestJson<{ llmResult?: MeetingLlmResultContent }>(`/api/meetings/${meetingId}/llm-results/${resultId}`);
      const content = data.llmResult?.resultMarkdown ?? "";
      llmContentByIdRef.current[resultId] = content;
      setLlmContentById((prev) => ({ ...prev, [resultId]: content }));
      return content;
    },
    [requestJson]
  );

  const loadAsrResults = useCallback(async (meetingId: string) => {
    try {
      const data = await requestJson<{ asrResults?: MeetingAsrResult[] }>(`/api/meetings/${meetingId}/asr-results`);
      if (!isActiveMeeting(meetingId)) return;
      const nextResults = data.asrResults ?? [];
      setAsrResults(nextResults);
      setSelectedAsrResult(null);
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

  const loadMeetingFull = useCallback(async (meetingId: string) => {
    const data = await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}`);
    if (!isActiveMeeting(meetingId)) return;
    const meeting = data.meeting;
    if (!meeting) return;
    fullDetailLoadedRef.current = true;
    // R2 修 F1：详情除了 transcript，还要把音频条目/hasAudio 一起并进来
    // （以前只并 transcript，导致详情里的录音信息被丢掉）
    setSelected((prev) =>
      prev && prev.id === meetingId
        ? {
            ...prev,
            transcript: meeting.transcript,
            hasAudio: meeting.hasAudio,
            audioRecordings: meeting.audioRecordings,
          }
        : prev
    );
  }, [isActiveMeeting, requestJson]);

  // ---------------------------------------------------------------------------
  // 会议 AI 标题（feat-261101-04 / #44）
  //
  // #43 R2 的教训：列表行走 `setSelected(m)` 的投影、详情走 `loadMeetingFull()` 合并，
  // 两处不是一个来源就会出现「详情有、列表点进去没有」。所以改名/撤销只走
  // `applyMeetingProjection(meeting)`：服务端返回的**同一份投影**同时落到列表行与详情。
  // ---------------------------------------------------------------------------
  const applyMeetingProjection = useCallback((meeting: MeetingRecord) => {
    setMeetings((prev) =>
      prev.map((item) => (item.id === meeting.id ? { ...item, ...meeting, transcript: item.transcript } : item))
    );
    setSelected((prev) =>
      prev && prev.id === meeting.id ? { ...prev, ...meeting, transcript: prev.transcript } : prev
    );
  }, []);

  const handleUndoAiTitle = useCallback(
    async (meetingId: string, previousTitle: string) => {
      // 先换掉带 action 的提示：既给反馈，也顺手把「撤销」按钮摘掉（防连点导致第二次撤销入口）
      setNotice({ type: "info", message: "正在撤销…" });
      try {
        const data = await requestJson<{ meeting?: MeetingRecord }>(`/api/meetings/${meetingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: previousTitle }),
        });
        if (data.meeting) applyMeetingProjection(data.meeting);
        // 撤销结果一律是**不带 action** 的普通提示 → 按原时长自动消失（一次性撤销）
        setNotice({ type: "success", message: `已撤销，标题恢复为「${previousTitle}」` });
      } catch (error) {
        console.error("Failed to undo ai title:", error);
        setNotice({ type: "error", message: "撤销失败" });
      }
    },
    [applyMeetingProjection, requestJson]
  );

  const handleGenerateAiTitle = useCallback(
    async (meetingId: string) => {
      if (aiTitleLoadingId) return;
      setAiTitleLoadingId(meetingId);
      try {
        const data = await requestJson<{
          title?: string;
          previousTitle?: string;
          meeting?: MeetingRecord;
        }>(`/api/meetings/${meetingId}/ai-title`, { method: "POST" });
        const meeting = data.meeting;
        if (meeting) applyMeetingProjection(meeting);
        const title = data.title ?? meeting?.title ?? "";
        const previousTitle = data.previousTitle ?? "";
        setNotice({
          type: "success",
          message: `AI 已重命名为「${title}」`,
          // toast 里给**一次**撤销：点完这次就换成不带动作的提示
          action:
            previousTitle && previousTitle !== title
              ? { label: "撤销", onClick: () => { void handleUndoAiTitle(meetingId, previousTitle); } }
              : undefined,
        });
      } catch (error) {
        console.error("Failed to generate ai title:", error);
        setNotice({
          type: "error",
          message: error instanceof Error ? `AI 起标题失败：${error.message}` : "AI 起标题失败",
        });
      } finally {
        setAiTitleLoadingId(null);
      }
    },
    [aiTitleLoadingId, applyMeetingProjection, handleUndoAiTitle, requestJson]
  );

  // R2 修 F2：「录音处理中…」自动变播放器 —— 有界轮询。
  // 只在选中会议的音频里还存在 status==='recording' 时起定时器：8 秒一次、最多 12 次（≈96 秒），
  // 全部离开 recording（变 ready/failed）或轮询次数用尽后自停；切会议 / 卸载时 cleanup 清定时器。
  const pendingAudioSignature = (selected?.audioRecordings ?? [])
    .filter((item) => item.status === "recording")
    .map((item) => item.id)
    .join(",");

  useEffect(() => {
    const meetingId = selected?.id;
    if (!meetingId || !pendingAudioSignature) return;

    let disposed = false;
    let attempts = 0;

    const timer = window.setInterval(() => {
      if (disposed) return;
      attempts += 1;
      if (attempts > AUDIO_PENDING_POLL_MAX_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      refreshMeeting(meetingId).catch((error) => {
        if (!disposed) console.error("Failed to refresh meeting audio status:", error);
      });
    }, AUDIO_PENDING_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pendingAudioSignature, refreshMeeting, selected?.id]);

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
    }, 8000);

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
          const uploadCaptureSessionId = client.getCaptureSessionId();
          const data = await requestJson<{ meeting?: MeetingRecord }>("/api/meetings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title,
              sourceType: "file_upload",
              sourceFileName: file.name,
              durationSeconds: null,
              captureSessionId: uploadCaptureSessionId || `capture-${Date.now()}`,
              captureSessionIds: uploadCaptureSessionId ? [uploadCaptureSessionId] : undefined,
              transcriptSegments: allSegments,
            }),
          });
          const meeting = data.meeting;
          if (meeting) {
            setMeetings((prev) => [meeting, ...prev]);
            selectedMeetingIdRef.current = meeting.id;
            setSelected(meeting);
            setLlmResults([]);
            setSelectedVersionId(null);
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
    if (selected.status === "llm_processing") {
      showNotice("info", "纪要正在生成中，请稍候");
      return;
    }
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

  const generateHistoryTranslation = useCallback(async () => {
    if (!selected || translationGenerating) return;
    const meetingId = selected.id;
    setTranslationGenerating(true);
    try {
      await requestJson(`/api/meetings/${meetingId}/llm-results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptTemplateId: SYSTEM_TRANSLATE_TEMPLATE_ID, targetLang: historyTranslateLang }),
      });
      if (!isActiveMeeting(meetingId)) return;
      autoSelectTranslationRef.current = true;
      setViewTab("summary");
      setSelected((prev) => (prev && prev.id === meetingId ? { ...prev, status: "llm_processing" } : prev));
      showNotice("info", "翻译已开始，完成后在「生成结果」中查看");
    } catch (err) {
      console.error("Generate translation failed:", err);
      if (!isActiveMeeting(meetingId)) return;
      await refreshMeeting(meetingId).catch(console.error);
      if (err instanceof ApiRequestError && err.status === 409) {
        showNotice("info", "翻译正在生成中，请稍候");
      } else {
        showNotice("error", `翻译触发失败: ${(err as Error).message}`);
      }
      setTranslationGenerating(false);
    }
  }, [historyTranslateLang, isActiveMeeting, refreshMeeting, requestJson, selected, showNotice, translationGenerating]);

  useEffect(() => {
    if (!translationGenerating) return;
    if (selected?.status && selected.status !== "llm_processing") {
      setTranslationGenerating(false);
    }
  }, [selected?.status, translationGenerating]);

  useEffect(() => {
    if (!autoSelectTranslationRef.current) return;
    const done = llmResults.filter(
      (item) => item.resultType === "translation" && (item.status === "succeeded" || item.status === "failed")
    );
    if (done.length === 0) return;
    autoSelectTranslationRef.current = false;
    setSelectedVersionId(done[0].id);
  }, [llmResults]);

  const sendSummary = useCallback(async () => {
    if (!selected) return;
    const meetingId = selected.id;

    const currentResult =
      llmResults.find((item) => item.id === selectedVersionId && item.resultType !== "translation") ??
      llmResults.find((item) => item.resultType !== "translation" && item.status === "succeeded");
    if (!currentResult) {
      showNotice("error", "当前会议还没有可发送的纪要结果");
      return;
    }

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
      setSendModalOpen(false);
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
  }, [isActiveMeeting, llmResults, loadSendRecords, mailCc, mailTo, refreshMeeting, requestJson, selected, selectedVersionId, showNotice]);

  const openSendModal = useCallback(() => {
    setMailTo(currentUser?.email ?? "");
    setMailCc("");
    setSendModalOpen(true);
  }, [currentUser]);

  const activePromptTemplates = promptTemplates.filter((template) => template.status === "active");
  const currentVersion =
    llmResults.find((item) => item.id === selectedVersionId) ??
    llmResults.find((item) => item.resultType !== "translation" && item.status === "succeeded") ??
    llmResults[0] ??
    null;
  const currentVersionContent = currentVersion ? (llmContentById[currentVersion.id] ?? "") : "";
  const currentVersionLangLabel = currentVersion ? getTranslationLangLabel(currentVersion) : null;
  const currentVersionSendRecords = currentVersion
    ? sendRecords.filter((record) => record.meetingLlmResultId === currentVersion.id)
    : [];

  useEffect(() => {
    const meetingId = selected?.id;
    if (!meetingId || !currentVersion) return;
    if (currentVersion.status !== "succeeded") return;
    if (llmContentByIdRef.current[currentVersion.id] !== undefined) return;
    let cancelled = false;
    loadLlmResultContent(meetingId, currentVersion.id).catch((error) => {
      if (cancelled) return;
      if (error instanceof ApiRequestError && error.status === 401) return;
      console.error("Failed to load llm result content:", error);
    });
    return () => {
      cancelled = true;
    };
  }, [currentVersion, isActiveMeeting, loadLlmResultContent, selected?.id]);
  const summaryBusy = summaryGenerating || selected?.status === "llm_processing";
  const selectedPromptTemplate =
    activePromptTemplates.find((template) => template.id === selectedPromptTemplateId) ?? activePromptTemplates[0] ?? null;

  const selectVersion = useCallback((resultId: string) => {
    selectedVersionIdRef.current = resultId;
    setSelectedVersionId(resultId);
    setEditingSummary(false);
  }, []);

  const deleteLlmResult = useCallback(
    async (resultId: string, kind: "summary" | "translation" = "summary") => {
      if (!selected) return;
      const meetingId = selected.id;
      const label = kind === "translation" ? "翻译" : "纪要";
      const confirmText =
        kind === "translation"
          ? "确定删除该翻译版本？"
          : "确定删除该纪要版本？关联的发送记录也会一并删除。";
      if (!window.confirm(confirmText)) return;
      try {
        await requestJson(`/api/meetings/${meetingId}/llm-results?resultId=${encodeURIComponent(resultId)}`, {
          method: "DELETE",
        });
        if (!isActiveMeeting(meetingId)) return;
        await loadLlmResults(meetingId);
        await refreshMeeting(meetingId);
        showNotice("success", `${label}版本已删除`);
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
    const versionId = selectedVersionId;
    if (!versionId) return;
    try {
      await requestJson(`/api/meetings/${selected.id}/llm-results`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: versionId,
          resultMarkdown: summaryText,
        }),
      });
      llmContentByIdRef.current[versionId] = summaryText;
      setLlmContentById((prev) => ({ ...prev, [versionId]: summaryText }));
      await loadLlmResults(selected.id);
      setEditingSummary(false);
      showNotice("success", "会议纪要已保存");
    } catch (error) {
      console.error("Failed to save summary:", error);
      showNotice("error", `保存失败: ${(error as Error).message}`);
    }
  }, [loadLlmResults, requestJson, selected, selectedVersionId, showNotice, summaryText]);

  const openSelectionTranslate = useCallback(() => {
    const selectedText = window.getSelection?.()?.toString()?.trim() ?? "";
    if (!selectedText) {
      showNotice("error", "请先在正文中选中要翻译的文本");
      return;
    }
    const estimatedTokens = Math.ceil(selectedText.length / 4);
    if (estimatedTokens > 100) {
      showNotice("info", `选中内容约 ${estimatedTokens} tokens，超出建议的 100 tokens，结果质量可能下降`);
    }
    setSelectionText(selectedText);
    setSelectionResult("");
    setSelectionError("");
    setSelectionModalOpen(true);
  }, [showNotice]);

  const runSelectionTranslate = useCallback(async () => {
    const text = selectionText.trim();
    if (!text) {
      showNotice("error", "没有可翻译的内容");
      return;
    }
    setSelectionBusy(true);
    setSelectionResult("");
    setSelectionError("");
    try {
      const data = await requestJson<{ text: string; elapsedMs: number }>("/api/translate-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, targetLang: selectionLang }),
      });
      setSelectionResult(data.text);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "翻译失败");
    } finally {
      setSelectionBusy(false);
    }
  }, [requestJson, selectionLang, selectionText, showNotice]);

  const speakSelectionText = useCallback(() => {
    if (!selectionText) return;
    setReadableText(selectionText);
    toggleSpeak();
  }, [selectionText, setReadableText, toggleSpeak]);

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
    <>
      <TtsReadableSync text={readableText} />
      <div className="flex min-h-0 flex-1 flex-col">
        {notice && (
          <div className={`flex items-center justify-between gap-3 border-b px-6 py-2 text-sm ${noticeClassName}`}>
            <span className="min-w-0 truncate">{notice.message}</span>
            <div className="flex shrink-0 items-center gap-1">
              {notice.action && (
                <button
                  type="button"
                  onClick={notice.action.onClick}
                  className="rounded border border-current px-2 py-0.5 text-xs font-medium underline-offset-2 transition hover:bg-white/60 hover:underline"
                >
                  {notice.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => setNotice(null)}
                className="rounded px-2 py-0.5 text-xs opacity-80 transition hover:bg-white/60 hover:opacity-100"
              >
                关闭
              </button>
            </div>
          </div>
        )}

        {/*
          issue #61：ASR 链路不可用时的**常驻**告警（D6）。
          - 不用 toast：3.5s 就消失，用户会以为还在录，结果整场会议什么都没录
          - 点明后果 + 可行动线索；连接恢复 / 重新录音时自动消失（也允许手动关闭）
        */}
        {asrLinkError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 border-b border-red-300 bg-red-50 px-6 py-2 text-sm text-red-700"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="font-semibold">
                实时转写连接失败：本次会议不会生成转写，也不会保存录音文件。
              </p>
              <p className="break-all text-xs text-red-600">原因：{asrLinkError}</p>
              <p className="text-xs text-red-600">
                请检查：① 浏览器地址与服务的实际访问地址是否一致（用局域网 IP / 域名访问时，
                服务端 Origin 白名单需要允许该地址，见 ASR_GATEWAY_ALLOWED_ORIGINS）；
                ② ASR 服务是否可连通。恢复连接或重新开始录音后本提示自动消失。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAsrLinkError(null)}
              className="shrink-0 rounded px-2 py-0.5 text-xs opacity-80 transition hover:bg-white/60 hover:opacity-100"
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
              aiTitleLoadingId={aiTitleLoadingId}
              onAiTitle={(id) => {
                void handleGenerateAiTitle(id);
              }}
               onSelect={(m) => {
                 resetTranscriptScheduler();
                 asrRecoveryRef.current = false;
                 persistedMeetingIdRef.current = null;
                 persistedSegmentCountRef.current = 0;
                 setAsrErrorMessage(null);
                 selectedMeetingIdRef.current = m.id;
                fullDetailLoadedRef.current = false;
                setSelected(m);
                updateSummaryGenerating(false, null);
                setSendingMail(false);
                setLiveSegments([]);
                setViewTab("summary");
                autoSelectTranslationRef.current = false;
                setSelectedVersionId(null);
                setAsrResults([]);
                setSelectedAsrResult(null);
                loadLlmResults(m.id).catch(console.error);
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
                    setSelectedVersionId(null);
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
                    {/* feat-261101-04（#44）：详情页的 AI 起标题入口 */}
                    <button
                      type="button"
                      data-testid="ai-title-detail"
                      onClick={() => {
                        void handleGenerateAiTitle(selected.id);
                      }}
                      disabled={aiTitleLoadingId === selected.id}
                      title="用 AI 根据转写生成标题并重命名（可撤销）"
                      className="rounded-md border border-slate-200 bg-white px-3 py-1 text-sm text-slate-600 transition hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {aiTitleLoadingId === selected.id ? "生成中…" : "✨ AI 起标题"}
                    </button>
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
                        生成结果
                      </button>
                      <button
                        onClick={() => {
                          setViewTab("transcript");
                          if (selected && selected.transcript.length === 0 && !fullDetailLoadedRef.current) {
                            loadMeetingFull(selected.id).catch(console.error);
                          }
                        }}
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
                {selected.audioRecordings && selected.audioRecordings.length > 0 && (
                  <div className="mb-3 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                    {selected.audioRecordings.map((recording, index) => (
                      <div key={recording.id} className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="shrink-0 text-xs font-medium text-slate-500">
                          录音{selected.audioRecordings && selected.audioRecordings.length > 1 ? ` ${index + 1}` : ""}
                        </span>
                        {recording.status === "ready" ? (
                          <>
                            <audio
                              controls
                              preload="none"
                              className="h-9 min-w-0 flex-1"
                              src={`/api/meetings/${selected.id}/audio?recording=${encodeURIComponent(recording.id)}`}
                            />
                            <span className="shrink-0 text-xs text-slate-400">
                              {formatAudioDuration(recording.durationSeconds)} · {formatAudioSize(recording.bytes)}
                              {recording.bitrateKbps ? ` · ${recording.bitrateKbps} kbps` : ""}
                            </span>
                            <a
                              href={`/api/meetings/${selected.id}/audio?recording=${encodeURIComponent(recording.id)}&download=1`}
                              download={recording.downloadFileName}
                              className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                            >
                              下载
                            </a>
                          </>
                        ) : recording.status === "failed" ? (
                          <details className="min-w-0 text-xs text-red-500">
                            <summary className="cursor-pointer">录音不可用（转码失败）</summary>
                            <p className="mt-1 break-all text-red-400">{recording.errorMessage ?? "未知原因"}</p>
                          </details>
                        ) : (
                          <span className="text-xs text-slate-400">
                            录音处理中…（{formatAudioDuration(recording.durationSeconds)} · {formatAudioSize(recording.bytes)}）
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-4">
                  {viewTab === "transcript" ? (
                    <div className="flex min-h-0 flex-1 flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-1 text-xs text-slate-500">
                            翻译为
                            <select
                              value={historyTranslateLang}
                              onChange={(e) => setHistoryTranslateLang(e.target.value)}
                              disabled={translationGenerating}
                              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
                            >
                              {HISTORY_TRANSLATE_LANGS.map((lang) => (
                                <option key={lang.value} value={lang.value}>
                                  {lang.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            onClick={() => generateHistoryTranslation()}
                            disabled={translationGenerating || selected?.status === "llm_processing"}
                            className="rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {translationGenerating || selected?.status === "llm_processing"
                              ? selected?.status === "llm_processing" && !translationGenerating
                                ? "处理中..."
                                : "翻译中..."
                              : "翻译"}
                          </button>
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(selected.transcript.map((s) => s.text).join(""));
                              showNotice("success", "转写原文已复制");
                            } catch (error) {
                              console.error("Failed to copy transcript:", error);
                              showNotice("error", "复制失败，请检查浏览器剪贴板权限");
                            }
                          }}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
                        >
                          复制原文
                        </button>
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1">
                          <TranscriptView segments={selected.transcript} />
                        </div>
                      </div>
                    </div>
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
                    <div className="flex min-h-full flex-col gap-3">
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                          {llmResults.length === 0 ? (
                            <span className="whitespace-nowrap text-sm text-slate-400">暂无版本</span>
                          ) : (
                            llmResults.map((result) => {
                              const failed = result.status === "failed";
                              const isTranslation = result.resultType === "translation";
                              const active = result.id === currentVersion?.id;
                              const langLabel = isTranslation ? getTranslationLangLabel(result) : null;
                              return (
                                <button
                                  key={result.id}
                                  onClick={() => selectVersion(result.id)}
                                  className={`shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-sm ${
                                    failed
                                      ? "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
                                      : active
                                        ? "border-brand bg-brand/5 text-brand"
                                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                  }`}
                                  title={failed ? result.errorMessage ?? "生成失败" : isTranslation ? (langLabel ? `译文（${langLabel}）` : "查看译文") : result.generationMode}
                                >
                                  V{result.versionNo}
                                  {isTranslation ? (
                                    <span className="ml-1 text-xs opacity-80">🌐 译文{langLabel ? `(${langLabel})` : ""}</span>
                                  ) : failed ? (
                                    <span className="ml-1 text-xs opacity-80">失败</span>
                                  ) : result.resultTitle ? (
                                    <span className="ml-1 text-xs opacity-70">{result.resultTitle}</span>
                                  ) : null}
                                </button>
                              );
                            })
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {activePromptTemplates.length > 0 ? (
                            <select
                              value={selectedPromptTemplate?.id ?? ""}
                              onChange={(e) => setSelectedPromptTemplateId(e.target.value)}
                              className="min-w-40 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-600"
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
                            disabled={summaryBusy}
                            className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm text-white hover:bg-brand-dark disabled:opacity-60"
                          >
                            <svg
                              className="h-4 w-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
                              <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
                            </svg>
                            {summaryBusy ? "生成中..." : "AI生成"}
                          </button>
                        </div>
                      </div>

                      <div className="flex min-h-[18rem] flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
                        <div className="grid grid-cols-12 items-center gap-3 border-b border-slate-100 px-4 py-2">
                          <div className="col-span-4">
                            {currentVersion?.errorMessage ? (
                              <div className="text-xs text-amber-600">⚠️ {currentVersion.errorMessage}</div>
                            ) : currentVersion?.resultType === "translation" ? (
                              <span className="text-xs text-slate-400">译文内容{currentVersionLangLabel ? `（${currentVersionLangLabel}）` : ""}</span>
                            ) : (
                              <span className="text-xs text-slate-400">纪要内容</span>
                            )}
                          </div>
                          <div className="col-span-8 flex flex-wrap justify-end gap-2">
                            {currentVersion && currentVersion.resultType !== "translation" && currentVersion.status === "succeeded" && (
                              <>
                                <button
                                  onClick={() => {
                                    if (selected) {
                                      loadSendRecords(selected.id).catch(console.error);
                                    }
                                    setSendRecordsModalOpen(true);
                                  }}
                                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
                                >
                                  发送记录
                                </button>
                                {isSupported && (
                                  <button
                                    onClick={toggleSpeak}
                                    disabled={!canRead && !isSpeaking}
                                    className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                    title="优先朗读选中文本；未选中时朗读当前全文"
                                  >
                                    {isSpeaking ? "停止朗读" : hasSelection ? "朗读选中部分" : "朗读全文"}
                                  </button>
                                )}
                                {hasSelection && (
                                  <button
                                    onClick={openSelectionTranslate}
                                    className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                    title="翻译选中文本，教学辅助（单词查音标释义、句子整句翻译并拆重点词）"
                                  >
                                    翻译选中部分
                                  </button>
                                )}
                                {editingSummary ? (
                                  <>
                                    <button
                                      onClick={saveSummaryEdit}
                                      className="rounded-md bg-brand px-2 py-1 text-xs text-white hover:bg-brand-dark"
                                    >
                                      保存
                                    </button>
                                    <button
                                      onClick={() => setEditingSummary(false)}
                                      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                    >
                                      取消
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => {
                                      if (currentVersion) {
                                        selectVersion(currentVersion.id);
                                      }
                                      setSummaryText(currentVersionContent);
                                      setEditingSummary(true);
                                    }}
                                    className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                  >
                                    编辑纪要
                                  </button>
                                )}
                                <button
                                  onClick={openSendModal}
                                  disabled={sendingMail}
                                  className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                                >
                                  发送该版本
                                </button>
                              </>
                            )}
                            {currentVersion && (
                              <button
                                onClick={() => deleteLlmResult(currentVersion.id, currentVersion.resultType === "translation" ? "translation" : "summary")}
                                className="rounded-md border border-slate-200 px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                              >
                                删除该版本
                              </button>
                            )}
                          </div>
                        </div>
                        {summaryBusy ? (
                          <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center text-slate-400">
                            <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                            <p>正在生成...</p>
                          </div>
                        ) : currentVersion?.resultType === "translation" ? (
                          currentVersion.status === "succeeded" ? (
                            <div className="scroll-thin flex min-h-[18rem] flex-1 flex-col overflow-y-auto p-4">
                              <div className="mb-2 flex shrink-0 items-center justify-end">
                                <button
                                  onClick={async () => {
                                    if (!currentVersionContent) return;
                                    try {
                                      await navigator.clipboard.writeText(currentVersionContent);
                                      showNotice("success", "译文已复制");
                                    } catch (error) {
                                      console.error("Failed to copy translation:", error);
                                      showNotice("error", "复制失败，请检查浏览器剪贴板权限");
                                    }
                                  }}
                                  className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
                                >
                                  复制译文
                                </button>
                              </div>
                              <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-emerald-700">
                                {currentVersionContent || "译文加载中..."}
                              </div>
                            </div>
                          ) : currentVersion.status === "failed" ? (
                            <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center px-4 text-center text-slate-400">
                              <p className="text-sm text-red-500">{currentVersion.errorMessage ?? "翻译失败"}</p>
                            </div>
                          ) : (
                            <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center text-slate-400">
                              <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                              <p>正在生成译文...</p>
                            </div>
                          )
                        ) : currentVersion?.status === "succeeded" ? (
                          editingSummary ? (
                            <div className="flex min-h-[18rem] flex-1 flex-col">
                              <div className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs text-slate-400">
                                <span>编辑 Markdown</span>
                                <span>右侧为实时预览</span>
                              </div>
                              <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
                                <textarea
                                  value={summaryText}
                                  onChange={(e) => setSummaryText(e.target.value)}
                                  spellCheck={false}
                                  className="scroll-thin min-h-[18rem] w-full resize-none border-r border-slate-100 p-4 font-mono text-[14px] leading-relaxed text-slate-700 focus:outline-none"
                                />
                                <div className="scroll-thin min-h-[18rem] overflow-y-auto p-4">
                                  <MarkdownPreview markdown={summaryText} />
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="scroll-thin flex-1 min-h-[18rem] overflow-y-auto p-4">
                              {currentVersionContent ? (
                                <MarkdownPreview markdown={currentVersionContent} />
                              ) : (
                                <div className="flex h-full items-center justify-center text-slate-400">内容加载中...</div>
                              )}
                            </div>
                          )
                        ) : currentVersion?.status === "failed" ? (
                          <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center px-4 text-center text-slate-400">
                            <p className="text-sm text-red-500">{currentVersion.errorMessage ?? "生成失败"}</p>
                          </div>
                        ) : (
                          <div className="flex flex-1 min-h-[18rem] flex-col items-center justify-center px-4 text-center text-slate-400">
                            <p>这个会议还没有版本。</p>
                            <p className="mt-1 text-sm">点击「AI生成」生成纪要，或在转写记录中选择语种「翻译」生成译文。</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full w-full flex-col rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 px-4 py-3">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-800">新增录音</h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href="/chat"
                      className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 shadow-sm transition hover:bg-emerald-100"
                    >
                      🗣 语音对话
                    </Link>
                    <RecordingControls
                      status={status}
                      onStart={() => setSetupModalOpen(true)}
                      onPause={pauseRecording}
                      onResume={resumeRecording}
                      onStop={stopRecording}
                      muted={micMuted}
                      micEnabled={Boolean(micDeviceId)}
                      onToggleMute={toggleMuteMic}
                    />
                    {(status === "idle" || status === "done") && (
                      <>
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
                          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                        >
                          上传音频
                        </button>
                      </>
                    )}
                  </div>
                 </div>
                {(status === "recording" || status === "paused" || status === "connecting") && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        className={
                          status === "recording" && !asrLinkError
                            ? "rec-dot"
                            : "h-3 w-3 rounded-full bg-amber-400"
                        }
                      />
                      <span className="font-medium text-slate-700" title={asrErrorMessage ?? undefined}>
                        {status === "recording"
                          ? // 链路不通时不能只显示「录音中 00:xx」：用户会以为在录（D6）
                            `录音中 ${formatTime(elapsed)}${asrLinkError ? "（实时转写未连接）" : ""}`
                          : status === "paused"
                            ? asrErrorMessage
                              ? `ASR 已暂停：${asrErrorMessage}`
                              : `已暂停 ${formatTime(elapsed)}`
                            : savingMeeting
                              ? "保存会议中..."
                              : "连接中..."}
                      </span>
                    </span>
                    <span className="text-slate-400">
                      FunASR:{" "}
                      {asrLinkError ? (
                        <span className="font-medium text-red-600">未连接</span>
                      ) : status === "recording" ? (
                        <span className="text-green-600">已连接</span>
                      ) : status === "paused" && asrErrorMessage ? (
                        <span className="text-red-600">连接异常</span>
                      ) : (
                        "连接中"
                      )}
                    </span>
                    <span className="ml-auto min-w-0 truncate text-slate-400">设备: {selectedDeviceLabel}</span>
                  </div>
                )}
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1">
                    <TranscriptView segments={liveSegments} />
                  </div>
                  {translationEnabled && (
                    <>
                      <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-slate-50/60 px-2 py-1 text-xs text-slate-400">
                        <span className="flex items-center gap-2">
                          🌐 译文
                          {llmQueueInfo && (
                            <span
                              className={`rounded px-1.5 py-0.5 ${
                                llmQueueInfo.queued > 0 || llmQueueInfo.inFlight > 0
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-emerald-100 text-emerald-700"
                              }`}
                            >
                              队列 {llmQueueInfo.queued} · 处理中 {llmQueueInfo.inFlight}
                              {lastTranslateElapsedMs !== null && (
                                <span className="ml-1">· 最近 {(lastTranslateElapsedMs / 1000).toFixed(1)}s</span>
                              )}
                            </span>
                          )}
                        </span>
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
        </main>

        {setupModalOpen && (
          <RecordSetupModal
            devices={devices}
            micDeviceId={micDeviceId}
            onMicChange={setMicDeviceId}
            onRequestMicRefresh={refreshMicDevices}
            micRefreshing={micRefreshing}
            speakerEnabled={speakerEnabled}
            onSpeakerChange={setSpeakerEnabled}
            asrLang={asrLang}
            onLangChange={handleAsrLangChange}
            translationEnabled={translationEnabled}
            onTranslationChange={handleTranslationChange}
            targetLang={targetLang}
            onTargetLangChange={handleTargetLangChange}
            onClose={() => setSetupModalOpen(false)}
            onConfirm={() => {
              setSetupModalOpen(false);
              void startRecording();
            }}
          />
        )}

        {sendModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-slate-800">发送该版本纪要</h3>
                <button
                  onClick={() => setSendModalOpen(false)}
                  disabled={sendingMail}
                  className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                  aria-label="关闭发送弹窗"
                >
                  ×
                </button>
              </div>
              <div className="mt-4 space-y-4">
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
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setSendModalOpen(false)}
                  disabled={sendingMail}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                >
                  取消
                </button>
                <button
                  onClick={() => sendSummary()}
                  disabled={sendingMail}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {sendingMail ? "发送中..." : "发送"}
                </button>
              </div>
            </div>
          </div>
        )}

        {sendRecordsModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-slate-800">发送记录</h3>
                <button
                  onClick={() => setSendRecordsModalOpen(false)}
                  className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label="关闭发送记录弹窗"
                >
                  ×
                </button>
              </div>
              <div className="mt-4">
                {currentVersionSendRecords.length === 0 ? (
                  <div className="py-6 text-center text-sm text-slate-400">
                    该版本还没有发送记录
                  </div>
                ) : (
                  <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                    {currentVersionSendRecords.map((record) => (
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
          </div>
        )}

        {selectionModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
            <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-lg">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-slate-800">翻译选中部分</h3>
                <button
                  onClick={() => setSelectionModalOpen(false)}
                  disabled={selectionBusy}
                  className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                  aria-label="关闭翻译弹窗"
                >
                  ×
                </button>
              </div>
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-500">
                    选中文本（约 {Math.ceil(selectionText.length / 4)} tokens，建议 ≤ 100）
                  </div>
                  {isSupported && (
                    <button
                      onClick={speakSelectionText}
                      disabled={!selectionText}
                      className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      title={isSpeaking ? "停止朗读" : "朗读选中原文"}
                    >
                      {isSpeaking ? (
                        <svg
                          className="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          stroke="none"
                        >
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg
                          className="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M11 5L6 9H2v6h4l5 4V5z" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                      )}
                      朗读原文
                    </button>
                  )}
                </div>
                <div className="scroll-thin max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  {selectionText || "—"}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">翻译为</span>
                  <select
                    value={selectionLang}
                    onChange={(e) => setSelectionLang(e.target.value)}
                    disabled={selectionBusy}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-60"
                  >
                    {HISTORY_TRANSLATE_LANGS.map((lang) => (
                      <option key={lang.value} value={lang.value}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={runSelectionTranslate}
                    disabled={selectionBusy || !selectionText}
                    className="rounded-md bg-brand px-2 py-1 text-xs text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {selectionBusy ? "翻译中..." : "翻译"}
                  </button>
                  {selectionResult && (
                    <button
                      onClick={async () => {
                        if (!selectionResult) return;
                        try {
                          await navigator.clipboard.writeText(selectionResult);
                          showNotice("success", "结果已复制");
                        } catch (error) {
                          console.error("Failed to copy selection result:", error);
                          showNotice("error", "复制失败，请检查浏览器剪贴板权限");
                        }
                      }}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
                    >
                      复制结果
                    </button>
                  )}
                </div>
              </div>
              {selectionBusy ? (
                <div className="mt-4 flex flex-col items-center justify-center py-8 text-slate-400">
                  <div className="mb-3 h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  <p>正在生成...</p>
                </div>
              ) : selectionError ? (
                <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                  {selectionError}
                </div>
              ) : selectionResult ? (
                <div className="mt-4">
                  <div className="scroll-thin max-h-[45vh] overflow-y-auto rounded-md border border-slate-200 bg-white p-3">
                    <MarkdownPreview markdown={selectionResult} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
        </div>
      </div>
    </>
  );
}
