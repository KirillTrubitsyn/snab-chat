"use client";

import { useState, useEffect, useRef } from "react";
import type { SpeechRecognition, SpeechRecognitionEvent } from "./types";

export default function VoiceButton({ onTranscript, disabled }: { onTranscript: (text: string) => void; disabled?: boolean }) {
  const [isRecording, setIsRecording] = useState(false);
  const [supported, setSupported] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldContinueRef = useRef(false);
  const transcriptRef = useRef("");

  useEffect(() => {
    const API = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (API) {
      setSupported(true);
      const rec = new API();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "ru-RU";

      rec.onresult = (e: SpeechRecognitionEvent) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) {
            const text = e.results[i][0].transcript;
            transcriptRef.current = transcriptRef.current
              ? transcriptRef.current + " " + text
              : text;
          }
        }
      };

      rec.onerror = (e: Event) => {
        const error = e as Event & { error?: string };
        if (error.error === "no-speech" || error.error === "aborted") return;
        shouldContinueRef.current = false;
        setIsRecording(false);
      };

      rec.onend = () => {
        if (shouldContinueRef.current) {
          try { rec.start(); }
          catch {
            if (transcriptRef.current) {
              onTranscript(transcriptRef.current);
              transcriptRef.current = "";
            }
            shouldContinueRef.current = false;
            setIsRecording(false);
          }
        } else {
          if (transcriptRef.current) {
            onTranscript(transcriptRef.current);
            transcriptRef.current = "";
          }
          setIsRecording(false);
        }
      };

      recognitionRef.current = rec;
    }
    return () => {
      shouldContinueRef.current = false;
      recognitionRef.current?.abort();
    };
  }, [onTranscript]);

  const toggle = () => {
    if (!recognitionRef.current || disabled) return;
    if (isRecording) {
      shouldContinueRef.current = false;
      recognitionRef.current.stop();
    } else {
      transcriptRef.current = "";
      shouldContinueRef.current = true;
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch {
        recognitionRef.current.stop();
        setTimeout(() => {
          if (recognitionRef.current && shouldContinueRef.current) {
            recognitionRef.current.start();
            setIsRecording(true);
          }
        }, 100);
      }
    }
  };

  if (!supported) return null;

  return (
    <button
      onClick={toggle}
      disabled={disabled}
      type="button"
      className={`voice-btn ${isRecording ? "recording" : ""}`}
      title={isRecording ? "Остановить запись" : "Голосовой ввод"}
    >
      {isRecording ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  );
}
