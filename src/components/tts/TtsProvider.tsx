"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type TtsContextValue = {
  isSupported: boolean;
  isSpeaking: boolean;
  canRead: boolean;
  hasSelection: boolean;
  setReadableText: (text: string) => void;
  toggleSpeak: () => void;
};

const TtsContext = createContext<TtsContextValue | null>(null);

function normalizeSpeechText(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function TtsProvider({ children }: { children: React.ReactNode }) {
  const [readableText, setReadableTextState] = useState("");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const isSupported = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

  const stopSpeaking = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setIsSpeaking(false);
  }, [isSupported]);

  useEffect(() => {
    if (!isSupported) return;

    const handleVoicesChanged = () => {
      window.speechSynthesis.getVoices();
    };

    const handleSelectionChange = () => {
      setHasSelection(Boolean(normalizeSpeechText(window.getSelection?.()?.toString() ?? "")));
    };

    window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged);
    document.addEventListener("selectionchange", handleSelectionChange);
    handleVoicesChanged();
    handleSelectionChange();

    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      document.removeEventListener("selectionchange", handleSelectionChange);
      window.speechSynthesis.cancel();
    };
  }, [isSupported]);

  const setReadableText = useCallback((text: string) => {
    setReadableTextState(normalizeSpeechText(text));
  }, []);

  const toggleSpeak = useCallback(() => {
    if (!isSupported) return;
    if (window.speechSynthesis.speaking || isSpeaking) {
      stopSpeaking();
      return;
    }

    const selectedText = normalizeSpeechText(window.getSelection?.()?.toString() ?? "");
    const nextText = selectedText || readableText;
    if (!nextText) return;

    const utterance = new SpeechSynthesisUtterance(nextText);
    const voices = window.speechSynthesis.getVoices();
    const zhVoice = voices.find((voice) => /^zh(-|_)/i.test(voice.lang)) ?? null;
    if (zhVoice) {
      utterance.voice = zhVoice;
    }
    utterance.lang = zhVoice?.lang || "zh-CN";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      utteranceRef.current = null;
      setIsSpeaking(false);
    };
    utterance.onerror = () => {
      utteranceRef.current = null;
      setIsSpeaking(false);
    };

    utteranceRef.current = utterance;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [isSpeaking, isSupported, readableText, stopSpeaking]);

  const value = useMemo<TtsContextValue>(
    () => ({
      isSupported,
      isSpeaking,
      canRead: Boolean(readableText),
      hasSelection,
      setReadableText,
      toggleSpeak,
    }),
    [hasSelection, isSupported, isSpeaking, readableText, setReadableText, toggleSpeak]
  );

  return <TtsContext.Provider value={value}>{children}</TtsContext.Provider>;
}

export function useTts() {
  const context = useContext(TtsContext);
  if (!context) {
    throw new Error("useTts must be used within TtsProvider");
  }
  return context;
}
