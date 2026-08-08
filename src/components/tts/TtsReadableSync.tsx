"use client";

import { useEffect } from "react";
import { useTts } from "@/components/tts/TtsProvider";

export default function TtsReadableSync({ text }: { text: string }) {
  const { setReadableText } = useTts();

  useEffect(() => {
    setReadableText(text);
    return () => setReadableText("");
  }, [setReadableText, text]);

  return null;
}
