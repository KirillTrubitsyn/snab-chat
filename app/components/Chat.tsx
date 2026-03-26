"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "ai/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import InviteGate from "./InviteGate";
import { containsMarkdownTable } from "@/app/lib/markdown-tables";

/* ââ Types ââ */

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  hasSummary: boolean;
}

interface Source {
  id: number;
  filename: string;
  mime_type: string;
  tags: string[];
  storage_path: string | null;
  folder_path: string | null;
  created_at: string;
}

interface ChatFile {
  id: string;
  file: File;
  filename: string;
  markdown: string;
  parsing: boolean;
  error?: string;
}

interface ChatPhoto {
  id: string;
  file: File;
  preview: string;
  markdown: string;
  parsing: boolean;
  error?: string;
}

/* ââ SpeechRecognition types ââ */

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList { length: number; [index: number]: SpeechRecognitionResult; }
interface SpeechRecognitionResult { isFinal: boolean; [index: number]: { transcript: string }; }
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}

/* ââ Helpers ââ */

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) return "ÑÐµÐ³Ð¾Ð´Ð½Ñ";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return "Ð²ÑÐµÑÐ°";

  const months = [
    "ÑÐ½Ð²", "ÑÐµÐ²", "Ð¼Ð°Ñ", "Ð°Ð¿Ñ", "Ð¼Ð°Ð¹", "Ð¸ÑÐ½",
    "Ð¸ÑÐ»", "Ð°Ð²Ð³", "ÑÐµÐ½", "Ð¾ÐºÑ", "Ð½Ð¾Ñ", "Ð´ÐµÐº",
  ];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

/* ââ Inline SVG icons ââ */

function SpektrIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <rect width="512" height="512" rx="112" fill="#F0F4FA"/>
      <rect x="120" y="100" width="200" height="260" rx="28" fill="#0D47A1"/>
      <rect x="160" y="140" width="200" height="260" rx="28" fill="#1976D2"/>
      <rect x="200" y="180" width="200" height="260" rx="28" fill="#42A5F5"/>
      <rect x="328" y="368" width="52" height="40" rx="12" fill="#fff"/>
      <polygon points="338,408 328,424 348,408" fill="#fff"/>
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="3" y1="5" x2="17" y2="5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15" x2="17" y2="15" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function InfographicIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  );
}

/* ââ VoiceButton ââ */

function VoiceButton({ onTranscript, disabled }: { onTranscript: (text: string) => void; disabled?: boolean }) {
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
      title={isRecording ? "ÐÑÑÐ°Ð½Ð¾Ð²Ð¸ÑÑ Ð·Ð°Ð¿Ð¸ÑÑ" : "ÐÐ¾Ð»Ð¾ÑÐ¾Ð²Ð¾Ð¹ Ð²Ð²Ð¾Ð´"}
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

/* ââ CameraButton (mobile only) ââ */

function CameraButton({
  onCapture,
  disabled,
  maxPhotos = 10,
  currentPhotoCount = 0,
}: {
  onCapture: (file: File) => void;
  disabled?: boolean;
  maxPhotos?: number;
  currentPhotoCount?: number;
}) {
  const [showCamera, setShowCamera] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const isLimitReached = currentPhotoCount >= maxPhotos;

  const startCamera = useCallback(async () => {
    try {
      setError(null);
      setReady(false);
      if (stream) stream.getTracks().forEach((t) => t.stop());

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current
            ?.play()
            .then(() => setReady(true))
            .catch(() => setError("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð·Ð°Ð¿ÑÑÑÐ¸ÑÑ Ð²Ð¸Ð´ÐµÐ¾"));
        };
      }
    } catch {
      setError("ÐÐµÑ Ð´Ð¾ÑÑÑÐ¿Ð° Ðº ÐºÐ°Ð¼ÐµÑÐµ");
    }
  }, [facingMode, stream]);

  const stopCamera = useCallback(() => {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    setReady(false);
  }, [stream]);

  const openCamera = () => {
    if (isLimitReached) return;
    setShowCamera(true);
    setTimeout(() => startCamera(), 100);
  };

  const closeCamera = () => {
    stopCamera();
    setShowCamera(false);
    setError(null);
  };

  const capture = () => {
    if (!videoRef.current || !canvasRef.current || !ready) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          onCapture(new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" }));
          closeCamera();
        }
      },
      "image/jpeg",
      0.85
    );
  };

  const switchCam = () => {
    stopCamera();
    setFacingMode((f) => (f === "environment" ? "user" : "environment"));
    setTimeout(() => startCamera(), 100);
  };

  // Only render on mobile (CSS hides on desktop via .camera-btn)
  return (
    <>
      <button
        onClick={openCamera}
        disabled={disabled || isLimitReached}
        type="button"
        className="camera-btn"
        title="Ð¡Ð´ÐµÐ»Ð°ÑÑ ÑÐ¾ÑÐ¾ Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÐ°"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        {currentPhotoCount > 0 && <span className="camera-badge">{currentPhotoCount}</span>}
      </button>

      {showCamera && (
        <div className="camera-overlay">
          {/* Header */}
          <div className="camera-header">
            <button onClick={closeCamera} className="camera-close" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <span className="camera-counter">{currentPhotoCount + 1} / {maxPhotos}</span>
            <button onClick={switchCam} className="camera-switch" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                <polyline points="16 17 21 12 16 7" />
                <polyline points="8 7 3 12 8 17" />
              </svg>
            </button>
          </div>

          {/* Video / Error */}
          {error ? (
            <div className="camera-error">
              <p>{error}</p>
              <button onClick={startCamera} className="camera-retry" type="button">ÐÐ¾Ð²ÑÐ¾ÑÐ¸ÑÑ</button>
            </div>
          ) : (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="camera-video" />
              {!ready && (
                <div className="camera-loading">
                  <div className="camera-spinner" />
                </div>
              )}
            </>
          )}

          {/* Capture */}
          <div className="camera-bottom">
            <button onClick={capture} disabled={!ready} className={`camera-shutter ${!ready ? "disabled" : ""}`} type="button">
              <div className="camera-shutter-inner" />
            </button>
          </div>

          <canvas ref={canvasRef} style={{ display: "none" }} />
        </div>
      )}
    </>
  );
}

/* ââ Sub-components ââ */

function cleanMarkdown(text: string): string {
  let s = text;
  // Remove backslash escapes from mammoth: \( \) \. \- etc.
  s = s.replace(/\\([().,;:!?\-\[\]{}+=#])/g, "$1");
  // Decode URL-encoded strings (%D1%81%D1%80... â readable text)
  s = s.replace(/%[0-9A-Fa-f]{2}(?:%[0-9A-Fa-f]{2})*/g, (match) => {
    try { return decodeURIComponent(match); } catch { return match; }
  });
  // Remove HTML tags (anchors, spans, etc.)
  s = s.replace(/<[^>]+>/g, "");
  // Remove markdown heading markers
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic markers
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  s = s.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  // Remove strikethrough
  s = s.replace(/~~([^~]+)~~/g, "$1");
  // Remove inline code backticks
  s = s.replace(/`([^`]+)`/g, "$1");
  // Remove link syntax [text](url) â text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove image syntax ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Remove horizontal rules
  s = s.replace(/^[-*_]{3,}\s*$/gm, "");
  // Remove blockquote markers
  s = s.replace(/^>\s?/gm, "");
  // Clean up multiple blank lines
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

interface ExcelSheet {
  name: string;
  rows: string[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  colWidths: number[];
}

function ExcelViewer({ sheets }: { sheets: ExcelSheet[] }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = sheets[activeSheet];
  if (!sheet) return null;

  // Build a merge map: for each cell, store if it's a merge start or should be hidden
  const mergeMap = new Map<string, { rowSpan: number; colSpan: number } | "hidden">();
  for (const m of sheet.merges) {
    const rowSpan = m.e.r - m.s.r + 1;
    const colSpan = m.e.c - m.s.c + 1;
    mergeMap.set(`${m.s.r},${m.s.c}`, { rowSpan, colSpan });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) {
          mergeMap.set(`${r},${c}`, "hidden");
        }
      }
    }
  }

  return (
    <div className="excel-viewer">
      {sheets.length > 1 && (
        <div className="excel-sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={i}
              className={`excel-sheet-tab ${i === activeSheet ? "active" : ""}`}
              onClick={() => setActiveSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="excel-table-wrapper">
        <table className="excel-table">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const key = `${ri},${ci}`;
                  const merge = mergeMap.get(key);
                  if (merge === "hidden") return null;
                  const span = merge || undefined;
                  const isEmpty = cell.trim() === "";
                  return (
                    <td
                      key={ci}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      className={isEmpty ? "excel-cell-empty" : undefined}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocumentViewer({
  source,
  onClose,
}: {
  source: Source;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [excelSheets, setExcelSheets] = useState<ExcelSheet[] | null>(null);
  const [loading, setLoading] = useState(true);
  const isPdf = source.mime_type?.includes("pdf");
  const isExcel =
    source.mime_type?.includes("sheet") ||
    source.mime_type?.includes("excel") ||
    source.filename?.endsWith(".xlsx") ||
    source.filename?.endsWith(".xls");
  const isDocx =
    source.mime_type?.includes("wordprocessingml") ||
    source.filename?.endsWith(".docx") ||
    source.filename?.endsWith(".doc");
  const hasOriginal = !!source.storage_path;

  useEffect(() => {
    if (isPdf && hasOriginal) {
      setLoading(false);
      return;
    }
    if (isExcel) {
      fetch(`/api/sources/excel-data?id=${source.id}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.sheets && d.sheets.length > 0) {
            setExcelSheets(d.sheets);
          } else {
            setContent("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð·Ð°Ð³ÑÑÐ·Ð¸ÑÑ ÑÐ¾Ð´ÐµÑÐ¶Ð¸Ð¼Ð¾Ðµ");
          }
        })
        .catch(() => setContent("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð·Ð°Ð³ÑÑÐ·Ð¸ÑÑ ÑÐ¾Ð´ÐµÑÐ¶Ð¸Ð¼Ð¾Ðµ"))
        .finally(() => setLoading(false));
      return;
    }
    if (isDocx && hasOriginal) {
      fetch(`/api/sources/docx-html?id=${source.id}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.html) {
            setDocxHtml(d.html);
          } else {
            setContent("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0435");
          }
        })
        .catch(() => setContent("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0435"))
        .finally(() => setLoading(false));
      return;
    }
    fetch(`/api/sources/content?id=${source.id}`)
      .then((r) => r.json())
      .then((d) => setContent(d.markdown || ""))
      .catch(() => setContent("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð·Ð°Ð³ÑÑÐ·Ð¸ÑÑ ÑÐ¾Ð´ÐµÑÐ¶Ð¸Ð¼Ð¾Ðµ"))
      .finally(() => setLoading(false));
  }, [source.id, isPdf, isExcel, isDocx, hasOriginal]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="document-viewer-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="document-viewer-header">
          <div className="document-viewer-title">{source.filename}</div>
          <div className="document-viewer-actions">
            <button
              className="btn-primary"
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}
              onClick={() =>
                window.open(
                  `/api/sources/download?id=${source.id}&action=download`,
                  "_blank"
                )
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {hasOriginal ? `Ð¡ÐºÐ°ÑÐ°ÑÑ (${source.filename.split('.').pop()?.toUpperCase()})` : "Ð¡ÐºÐ°ÑÐ°ÑÑ (.md)"}
            </button>
            <button className="btn-secondary" onClick={onClose}>
              ÐÐ°ÐºÑÑÑÑ
            </button>
          </div>
        </div>
        <div className="document-viewer-body">
          {loading ? (
            <div className="document-viewer-loading">ÐÐ°Ð³ÑÑÐ·ÐºÐ°...</div>
          ) : isPdf && hasOriginal ? (
            <iframe
              src={`/api/sources/download?id=${source.id}&action=view`}
              className="document-viewer-iframe"
              title={source.filename}
            />
          ) : excelSheets ? (
            <ExcelViewer sheets={excelSheets} />
          ) : docxHtml ? (
            <div
              className="document-viewer-content docx-preview"
              dangerouslySetInnerHTML={{ __html: docxHtml }}
            />
          ) : (
            <div className="document-viewer-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content || ""}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  allSources,
  onViewSource,
  onCreateInfographic,
  onExportDocx,
  onExportExcel,
}: {
  message: {
    id: string;
    role: string;
    content: string;
    sources?: string[];
    attachments?: string[];
    metadata?: { type?: string; image_base64?: string; topic?: string; style?: string } | null;
  };
  allSources: Source[];
  onViewSource: (source: Source) => void;
  onCreateInfographic?: (content: string) => void;
  onExportDocx?: (content: string) => void;
  onExportExcel?: (content: string) => void;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="message message-user">
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((name, i) => (
              <span key={i} className="message-attachment-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="message-content">{message.content}</div>
      </div>
    );
  }

  // Render infographic card for messages with metadata.type === "infographic"
  if (message.metadata?.type === "infographic" && message.metadata.image_base64) {
    const handleDownloadInfographic = () => {
      const link = document.createElement("a");
      link.href = message.metadata!.image_base64!;
      link.download = `infographic-${Date.now()}.png`;
      link.click();
    };

    return (
      <div className="message message-ai">
        <div className="message-infographic-card">
          <div className="message-infographic-label">
            <InfographicIcon size={14} />
            ÐÐ½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÐ°{message.metadata.topic ? `: ${message.metadata.topic}` : ""}
          </div>
          <img
            src={message.metadata.image_base64}
            alt={message.metadata.topic || "ÐÐ½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÐ°"}
            className="message-infographic-image"
          />
          {message.content && (
            <div className="message-infographic-desc">{message.content}</div>
          )}
          <button className="message-infographic-download" onClick={handleDownloadInfographic}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Ð¡ÐºÐ°ÑÐ°ÑÑ PNG
          </button>
        </div>
      </div>
    );
  }

  // Find source by filename with flexible matching
  const findSource = (name: string): Source | undefined => {
    if (!name) return undefined;
    const n = name.trim();
    // Exact match
    let src = allSources.find((doc) => doc.filename === n);
    if (src) return src;
    // Case-insensitive match
    const lower = n.toLowerCase();
    src = allSources.find((doc) => doc.filename.toLowerCase() === lower);
    if (src) return src;
    // Normalize whitespace and compare
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const normName = normalize(n);
    src = allSources.find((doc) => normalize(doc.filename) === normName);
    if (src) return src;
    // Partial match: contains
    src = allSources.find((doc) => normalize(doc.filename).includes(normName) || normName.includes(normalize(doc.filename)));
    if (src) return src;
    // Match without extension
    const nameNoExt = normName.replace(/\.\w+$/, "");
    src = allSources.find((doc) => normalize(doc.filename).replace(/\.\w+$/, "") === nameNoExt);
    if (src) return src;
    // Match by document code pattern (e.g., "Ð¡-ÐÐ-Ð5-02" found in both text and filename)
    const codeMatch = n.match(/[Ð-Ð¯A-Z][\w-]*(?:Ð\d|Ð£\d|Ð\d)[\w-]*/i);
    if (codeMatch) {
      const code = codeMatch[0].toLowerCase();
      src = allSources.find((doc) => doc.filename.toLowerCase().includes(code));
    }
    return src;
  };

  // Make all source tags clickable â if no exact source found, open download search
  const handleSourceClick = (sourceName: string) => {
    const src = findSource(sourceName);
    if (src) {
      onViewSource(src);
    }
  };

  // Build patterns from source filenames to linkify in text
  const linkifyContent = (text: string): string => {
    if (allSources.length === 0) return text;

    // Extract document codes from filenames (e.g., "Ð¡-ÐÐÐÐ Ð­Ð¡-Ð5-03", "Ð-ÐÐ-Ð5-02", "ÐÐ»-ÐÐ-Ð5-03")
    const codePatterns: { code: string; sourceId: number }[] = [];
    for (const src of allSources) {
      // Match codes like: Ð¡-ÐÐÐÐ Ð­Ð¡-Ð5-03, Ð-ÐÐ-Ð1/Ð£6-02, ÐÐ»-ÐÐ-Ð5-03, Ð-ÐÐ-Ð1/Ð£4-01
      const codes = src.filename.match(/[Ð-Ð¯A-ZÐ°-Ña-z]{1,4}-[Ð-Ð¯A-ZÐ°-Ña-z/]{1,15}-[Ð-Ð¯A-ZÐ°-Ña-z0-9/]{1,6}-\d{1,3}/gi);
      if (codes) {
        for (const code of codes) {
          codePatterns.push({ code, sourceId: src.id });
        }
      }
    }

    if (codePatterns.length === 0) return text;

    // Sort by length descending so longer codes match first
    codePatterns.sort((a, b) => b.code.length - a.code.length);

    // Build a combined regex that matches any code
    const combinedPattern = codePatterns
      .map(({ code }) => code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const regex = new RegExp(combinedPattern, "gi");

    // Replace codes with markdown links, avoiding already-linked text
    // Process the whole text, using offset to check context
    const result = text.replace(regex, (match, offset) => {
      // Check if already inside a markdown link by looking at surrounding text
      const before = text.substring(Math.max(0, offset - 200), offset);
      // If there's an unclosed [ before us, we're inside link text
      const lastOpen = before.lastIndexOf("[");
      const lastClose = before.lastIndexOf("]");
      if (lastOpen > lastClose) return match;

      // Check if preceded by ]( â we'd be inside a link URL
      const justBefore = text.substring(Math.max(0, offset - 10), offset);
      if (justBefore.includes("](")) return match;

      // Find matching source
      const matchLower = match.toLowerCase();
      const pattern = codePatterns.find(
        (p) => p.code.toLowerCase() === matchLower
      );
      if (!pattern) return match;

      return `[${match}](source:${pattern.sourceId})`;
    });

    return result;
  };

  const processedContent = linkifyContent(message.content);

  return (
    <div className="message message-ai">
      <div className="message-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, href }) => {
              // Handle our injected source: links
              if (href?.startsWith("source:")) {
                const id = parseInt(href.replace("source:", ""), 10);
                const src = allSources.find((s) => s.id === id);
                if (src) {
                  return (
                    <button
                      className="source-link-btn"
                      onClick={() => onViewSource(src)}
                      title={`ÐÑÐºÑÑÑÑ: ${src.filename}`}
                    >
                      {children}
                    </button>
                  );
                }
              }
              // Handle any other links from AI
              const linkText = String(children);
              const src = findSource(linkText);
              if (src) {
                return (
                  <button
                    className="source-link-btn"
                    onClick={() => onViewSource(src)}
                    title={`ÐÑÐºÑÑÑÑ: ${src.filename}`}
                  >
                    {children}
                  </button>
                );
              }
              return <span>{children}</span>;
            },
          }}
        >
          {processedContent}
        </ReactMarkdown>
      </div>
      {message.sources && message.sources.length > 0 && (
        <div className="message-sources">
          <div className="message-sources-label">ÐÑÑÐ¾ÑÐ½Ð¸ÐºÐ¸:</div>
          <div className="message-sources-list">
            {message.sources.map((s, i) => {
              const src = findSource(s);
              return (
                <button
                  key={i}
                  className={`message-source-tag source-clickable${!src ? " source-unlinked" : ""}`}
                  onClick={() => handleSourceClick(s)}
                  title={src ? "ÐÑÐºÑÑÑÑ Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ" : "ÐÐ¾ÐºÑÐ¼ÐµÐ½Ñ Ð½Ðµ Ð½Ð°Ð¹Ð´ÐµÐ½ Ð² Ð±Ð°Ð·Ðµ"}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {(onCreateInfographic || onExportDocx || onExportExcel) && (
        <div className="message-infographic-row">
          {onCreateInfographic && (
            <button
              className="message-infographic-btn"
              onClick={() => onCreateInfographic(message.content)}
              title="Ð¡Ð¾Ð·Ð´Ð°ÑÑ Ð¸Ð½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÑ Ð½Ð° Ð¾ÑÐ½Ð¾Ð²Ðµ ÑÑÐ¾Ð³Ð¾ Ð¾ÑÐ²ÐµÑÐ°"
            >
              <InfographicIcon size={14} />
              Ð¡Ð¾Ð·Ð´Ð°ÑÑ Ð¸Ð½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÑ
            </button>
          )}
          {onExportDocx && (
            <button
              className="message-infographic-btn message-export-btn"
              onClick={() => onExportDocx(message.content)}
              title="Ð¡ÐºÐ°ÑÐ°ÑÑ Ð¾ÑÐ²ÐµÑ Ð² ÑÐ¾ÑÐ¼Ð°ÑÐµ DOCX"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <polyline points="9 15 12 18 15 15" />
              </svg>
              Ð¡ÐºÐ°ÑÐ°ÑÑ .docx
            </button>
          )}
          {onExportExcel && (
            <button
              className="message-infographic-btn message-export-btn"
              onClick={() => onExportExcel(message.content)}
              title="Ð¡ÐºÐ°ÑÐ°ÑÑ ÑÐ°Ð±Ð»Ð¸ÑÑ Ð² ÑÐ¾ÑÐ¼Ð°ÑÐµ Excel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="3" y1="15" x2="21" y2="15" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              Ð¡ÐºÐ°ÑÐ°ÑÑ .xlsx
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onChipClick }: { onChipClick?: (text: string) => void }) {
  return (
    <div className="empty-state">
      <div className="welcome-logo-glow">
        <SpektrIcon size={96} />
      </div>
      <div className="welcome-dept">ÐÐ¸ÑÐµÐºÑÐ¸Ñ Ð¿Ð¾ Ð·Ð°ÐºÑÐ¿ÐºÐ°Ð¼</div>
      <div className="welcome-brand">
        <span style={{ color: '#003A7A' }}>Ð¡Ð½Ð°Ð±</span><span style={{ color: '#0099CC' }}>Ð§Ð°Ñ</span>
      </div>
      <div className="welcome-divider" />
      <div className="welcome-role">ÐÐ°Ñ ÐÐ-Ð°ÑÑÐ¸ÑÑÐµÐ½Ñ Ð¿Ð¾ Ð·Ð°ÐºÑÐ¿ÐºÐ°Ð¼</div>
      <div className="welcome-desc">
        ÐÐ¾Ð¼Ð¾Ð³Ñ ÑÐ°Ð·Ð¾Ð±ÑÐ°ÑÑÑÑ Ð² Ð¿ÑÐ¾ÑÐµÐ´ÑÑÐ°Ñ, Ð½Ð°Ð¹ÑÐ¸ Ð½ÑÐ¶Ð½ÑÐ¹ Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ, Ð¿Ð¾Ð´Ð³Ð¾ÑÐ¾Ð²Ð¸ÑÑ Ð¾ÑÐ²ÐµÑ Ð¸Ð»Ð¸ Ð¿ÑÐ¾Ð²ÐµÑÐ¸ÑÑ ÑÐ¾Ð¾ÑÐ²ÐµÑÑÑÐ²Ð¸Ðµ ÑÑÐµÐ±Ð¾Ð²Ð°Ð½Ð¸ÑÐ¼
      </div>
      <div className="welcome-chips">
        <div className="welcome-chips-row">
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("ÐÐ°ÐºÐ¸Ðµ Ð¿Ð¾Ð»Ð½Ð¾Ð¼Ð¾ÑÐ¸Ñ Ñ Ð¦ÐÐ?")}>ÐÐ¾Ð»Ð½Ð¾Ð¼Ð¾ÑÐ¸Ñ Ð¦ÐÐ</button>
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("ÐÐ°ÐºÐ¾Ð² Ð¿Ð¾ÑÑÐ´Ð¾Ðº Ð¿ÑÐ¾Ð²ÐµÐ´ÐµÐ½Ð¸Ñ Ð°Ð²Ð°ÑÐ¸Ð¹Ð½Ð¾Ð¹ Ð·Ð°ÐºÑÐ¿ÐºÐ¸?")}>ÐÐ¾ÑÑÐ´Ð¾Ðº Ð°Ð²Ð°ÑÐ¸Ð¹Ð½Ð¾Ð¹ Ð·Ð°ÐºÑÐ¿ÐºÐ¸</button>
        </div>
        <div className="welcome-chips-row">
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("ÐÐ°ÐºÐ¸Ðµ ÑÑÐ°Ð¿Ñ ÑÐ¾Ð³Ð»Ð°ÑÐ¾Ð²Ð°Ð½Ð¸Ñ Ð´Ð¾Ð³Ð¾Ð²Ð¾ÑÐ° Ð½Ð° Ð·Ð°ÐºÑÐ¿ÐºÑ?")}>Ð­ÑÐ°Ð¿Ñ ÑÐ¾Ð³Ð»Ð°ÑÐ¾Ð²Ð°Ð½Ð¸Ñ Ð´Ð¾Ð³Ð¾Ð²Ð¾ÑÐ°</button>
          <button className="welcome-chip" type="button" onClick={() => onChipClick?.("ÐÐ¾Ð³Ð´Ð° Ð¿ÑÐ¾Ð²Ð¾Ð´Ð¸ÑÑÑ Ð¿ÐµÑÐµÑÐ¾ÑÐ¶ÐºÐ°?")}>ÐÐ¾Ð³Ð´Ð° Ð¿ÑÐ¾Ð²Ð¾Ð´Ð¸ÑÑÑ Ð¿ÐµÑÐµÑÐ¾ÑÐ¶ÐºÐ°</button>
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="message message-ai" style={{ padding: "12px 18px" }}>
      <div className="typing-indicator">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

/* âââââââââââââââââââââââââââââââââââââââââââââââ
   Main Chat component
   âââââââââââââââââââââââââââââââââââââââââââââââ */

export default function Chat() {
  /* ââ Auth State ââ */
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inviteCode, setInviteCode] = useState<string>("");
  const inviteCodeRef = useRef<string>("");
  const [userName, setUserName] = useState<string>("");
  const [authLoading, setAuthLoading] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const isAdmin = typeof window !== "undefined" && localStorage.getItem("snabchat_is_admin") === "true";

  /* ââ Keep inviteCodeRef in sync ââ */
  useEffect(() => {
    inviteCodeRef.current = inviteCode;
  }, [inviteCode]);

  /* ââ Check existing auth on mount ââ */
  useEffect(() => {
    const code = localStorage.getItem("snabchat_invite_code");
    const name = localStorage.getItem("snabchat_user_name");
    if (code && name) {
      setInviteCode(code);
      inviteCodeRef.current = code;
      setUserName(name);
      setIsAuthenticated(true);
    }
    setAuthLoading(false);
  }, []);

  const handleAuthSuccess = useCallback((data: { type: string; code: string; userName: string }) => {
    setInviteCode(data.code);
    inviteCodeRef.current = data.code;
    setUserName(data.userName);
    setIsAuthenticated(true);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("snabchat_invite_code");
    localStorage.removeItem("snabchat_invite_code_id");
    localStorage.removeItem("snabchat_user_name");
    localStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_admin_code");
    setIsAuthenticated(false);
    setInviteCode("");
    setUserName("");
  }, []);

  // Close user menu on click outside
  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [userMenuOpen]);

  // Close mobile menu on click outside
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mobileMenuOpen]);

  // Helper: get initials from full name
  const userInitials = userName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");

  /* ââ State ââ */
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  // Unique key for useChat to avoid stale message cache when starting new chats
  const [chatKey, setChatKey] = useState(() => `new-${Date.now()}`);
  const [hasSummary, setHasSummary] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [viewingSource, setViewingSource] = useState<Source | null>(null);
  const [chatFiles, setChatFiles] = useState<ChatFile[]>([]);
  const [chatPhotos, setChatPhotos] = useState<ChatPhoto[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<number>>(new Set());
  const [bulkSelectMode, setBulkSelectMode] = useState(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [convBulkMode, setConvBulkMode] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"chat" | "knowledge-base">("chat");
  const [kbCategoryFilter, setKbCategoryFilter] = useState<string>("all");

  // Support modal state
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportSending, setSupportSending] = useState(false);
  const [supportHistory, setSupportHistory] = useState<{ id: string; message: string; admin_reply: string | null; admin_number: number | null; status: string; created_at: string; replied_at: string | null }[]>([]);
  const [unreadSupportCount, setUnreadSupportCount] = useState(0);

  const router = useRouter();

  /* ââ Infographic navigation ââ */
  const navigateToInfographic = useCallback((content?: string) => {
    const ctx: Record<string, string> = {};
    if (content) ctx.documentText = content;
    if (convIdRef.current) ctx.conversationId = convIdRef.current;
    if (Object.keys(ctx).length > 0) {
      sessionStorage.setItem("infographic_context", JSON.stringify(ctx));
    }
    router.push("/infographic");
  }, [router]);

  const [docxDownloading, setDocxDownloading] = useState(false);
  const handleExportDocx = useCallback(async (answerContent: string, questionContent: string) => {
    if (docxDownloading) return;
    setDocxDownloading(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: questionContent, answer: answerContent }),
      });
      if (!res.ok) throw new Error("Export failed");
      // Extract filename from Content-Disposition header
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `snabchat-${new Date().toISOString().slice(0, 10)}.docx`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("DOCX export error:", e);
    } finally {
      setDocxDownloading(false);
    }
  }, [docxDownloading]);

  const [xlsxDownloading, setXlsxDownloading] = useState(false);
  const handleExportExcel = useCallback(async (answerContent: string, questionContent: string) => {
    if (xlsxDownloading) return;
    setXlsxDownloading(true);
    try {
      const res = await fetch("/api/export-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: questionContent, answer: answerContent }),
      });
      if (!res.ok) throw new Error("Excel export failed");
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : `snabchat-${new Date().toISOString().slice(0, 10)}.xlsx`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Excel export error:", e);
    } finally {
      setXlsxDownloading(false);
    }
  }, [xlsxDownloading]);

  /* ââ Refs ââ */
  const convIdRef = useRef<string | null>(null);
  const pendingSubmitRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);

  /* ââ useChat ââ */
  const {
    messages,
    input,
    handleInputChange,
    setMessages,
    isLoading,
    setInput,
  } = useChat({
    id: activeConvId ?? chatKey,
    api: "/api/chat",
    body: { conversationId: convIdRef.current },
    headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
  });

  /* ââ Load conversations ââ */
  const loadConversations = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch("/api/conversations", {
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      const data = await res.json();
      if (Array.isArray(data)) setConversations(data);
    } catch {
      // ignore
    }
  }, [inviteCode]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  /* ââ Load sources ââ */
  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/api/sources");
      const data = await res.json();
      if (data.sources) setSources(data.sources);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  /* ââ Support ââ */
  const loadSupportHistory = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch("/api/support", {
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      const data = await res.json();
      if (data.messages) {
        setSupportHistory(data.messages);
        // Count unread: answered messages that user hasn't seen
        const lastSeen = localStorage.getItem("supportLastSeen") ?? "0";
        const unread = data.messages.filter(
          (m: { admin_reply: string | null; replied_at: string | null }) =>
            m.admin_reply && m.replied_at && new Date(m.replied_at).getTime() > parseInt(lastSeen)
        ).length;
        setUnreadSupportCount(unread);
      }
    } catch (e) { console.error("[Support] load error:", e); }
  }, [inviteCode]);

  useEffect(() => {
    loadSupportHistory();
  }, [loadSupportHistory]);

  // Polling: every 15s when modal is open, every 60s in background (for badge)
  useEffect(() => {
    if (!inviteCode) return;
    const interval = setInterval(() => {
      loadSupportHistory();
    }, showSupportModal ? 15000 : 60000);
    return () => clearInterval(interval);
  }, [inviteCode, showSupportModal, loadSupportHistory]);

  const sendSupportMessage = async () => {
    if (!supportMessage.trim() || supportSending) return;
    setSupportSending(true);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        body: JSON.stringify({ message: supportMessage.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("[Support] POST error:", err);
      }
      setSupportMessage("");
      await loadSupportHistory();
    } catch (e) { console.error("[Support] send error:", e); }
    setSupportSending(false);
  };

  const openSupportModal = () => {
    setShowSupportModal(true);
    loadSupportHistory();
    // Mark as seen
    localStorage.setItem("supportLastSeen", String(Date.now()));
    setUnreadSupportCount(0);
  };

  /* ââ Switch conversation ââ */
  const switchConversation = useCallback(
    async (convId: string) => {
      setActiveConvId(convId);
      convIdRef.current = convId;
      setRightOpen(false);

      try {
        const res = await fetch(`/api/conversations/messages?id=${convId}`, {
          headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        });
        const data = await res.json();
        setHasSummary(data.conversation?.hasSummary ?? false);
        if (data.messages) {
          setMessages(
            data.messages.map(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (m: { id: string; role: string; content: string; metadata?: any }) => ({
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
                ...(m.metadata?.sources ? { sources: m.metadata.sources } : {}),
                ...(m.metadata ? { metadata: m.metadata } : {}),
              })
            )
          );
        }
      } catch {
        setMessages([]);
      }
    },
    [setMessages]
  );

  /* ââ Create conversation ââ */
  const createConversation = useCallback(
    async (title?: string) => {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        body: JSON.stringify({ title: title || "ÐÐ¾Ð²ÑÐ¹ Ð´Ð¸Ð°Ð»Ð¾Ð³" }),
      });
      if (!res.ok) {
        throw new Error(`ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ ÑÐ¾Ð·Ð´Ð°ÑÑ Ð´Ð¸Ð°Ð»Ð¾Ð³: ${res.status}`);
      }
      const conv = await res.json();
      if (!conv.id) {
        throw new Error("Ð¡ÐµÑÐ²ÐµÑ Ð½Ðµ Ð²ÐµÑÐ½ÑÐ» ID Ð´Ð¸Ð°Ð»Ð¾Ð³Ð°");
      }
      setConversations((prev) => [conv, ...prev]);
      setActiveConvId(conv.id);
      convIdRef.current = conv.id;
      setMessages([]);
      setHasSummary(false);
      return conv.id as string;
    },
    [setMessages]
  );

  /* ââ Delete conversation ââ */
  const deleteConversation = useCallback(
    async (convId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      await fetch(`/api/conversations?id=${convId}`, {
        method: "DELETE",
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeConvId === convId) {
        setActiveConvId(null);
        convIdRef.current = null;
        setMessages([]);
        setHasSummary(false);
      }
    },
    [activeConvId, setMessages]
  );

  /* ââ Chat file attach handlers ââ */
  const MAX_CHAT_FILES = 5;
  const MAX_CHAT_PHOTOS = 10;
  const MAX_CHAT_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
  const ACCEPTED_CHAT_TYPES = ".pdf,.docx,.xlsx,.xls,.jpg,.jpeg,.png,.gif,.bmp,.webp";
  const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "bmp", "webp"];

  const parseFileViaApi = useCallback(async (file: File, fileId: string, isPhoto: boolean) => {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/parse", { method: "POST", body: formData, headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) } });
      if (!res.ok) throw new Error("Parse failed");
      const data = await res.json();
      if (isPhoto) {
        setChatPhotos((prev) =>
          prev.map((p) => (p.id === fileId ? { ...p, markdown: data.markdown, parsing: false } : p))
        );
      } else {
        setChatFiles((prev) =>
          prev.map((f) => (f.id === fileId ? { ...f, markdown: data.markdown, parsing: false } : f))
        );
      }
    } catch {
      if (isPhoto) {
        setChatPhotos((prev) =>
          prev.map((p) => (p.id === fileId ? { ...p, parsing: false, error: "ÐÑÐ¸Ð±ÐºÐ° ÑÐ°ÑÐ¿Ð¾Ð·Ð½Ð°Ð²Ð°Ð½Ð¸Ñ" } : p))
        );
      } else {
        setChatFiles((prev) =>
          prev.map((f) => (f.id === fileId ? { ...f, parsing: false, error: "ÐÑÐ¸Ð±ÐºÐ° Ð¾Ð±ÑÐ°Ð±Ð¾ÑÐºÐ¸" } : f))
        );
      }
    }
  }, []);

  const handleChatFileSelect = useCallback(
    async (files: FileList) => {
      const newFiles = Array.from(files);

      for (const file of newFiles) {
        if (file.size > MAX_CHAT_FILE_SIZE) {
          alert(`Ð¤Ð°Ð¹Ð» "${file.name}" Ð¿ÑÐµÐ²ÑÑÐ°ÐµÑ 25 ÐÐ`);
          continue;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "";

        // Route images to photos
        if (IMAGE_EXTENSIONS.includes(ext)) {
          if (chatPhotos.length >= MAX_CHAT_PHOTOS) {
            alert(`ÐÐ°ÐºÑÐ¸Ð¼ÑÐ¼ ${MAX_CHAT_PHOTOS} ÑÐ¾ÑÐ¾`);
            continue;
          }
          const photoId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const preview = URL.createObjectURL(file);
          setChatPhotos((prev) => {
            if (prev.length >= MAX_CHAT_PHOTOS) return prev;
            return [...prev, { id: photoId, file, preview, markdown: "", parsing: true }];
          });
          parseFileViaApi(file, photoId, true);
          continue;
        }

        // Documents
        if (!["pdf", "docx", "xlsx", "xls"].includes(ext)) {
          alert(`Ð¤Ð¾ÑÐ¼Ð°Ñ .${ext} Ð½Ðµ Ð¿Ð¾Ð´Ð´ÐµÑÐ¶Ð¸Ð²Ð°ÐµÑÑÑ. ÐÐ¾Ð¿ÑÑÑÐ¸Ð¼ÑÐµ: PDF, DOCX, XLSX, Ð¸Ð·Ð¾Ð±ÑÐ°Ð¶ÐµÐ½Ð¸Ñ`);
          continue;
        }
        if (chatFiles.length >= MAX_CHAT_FILES) {
          alert(`ÐÐ°ÐºÑÐ¸Ð¼ÑÐ¼ ${MAX_CHAT_FILES} ÑÐ°Ð¹Ð»Ð¾Ð²`);
          break;
        }

        const fileId = `cf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        setChatFiles((prev) => {
          if (prev.length >= MAX_CHAT_FILES) return prev;
          return [...prev, { id: fileId, file, filename: file.name, markdown: "", parsing: true }];
        });
        parseFileViaApi(file, fileId, false);
      }
    },
    [chatFiles.length, chatPhotos.length, parseFileViaApi]
  );

  const handlePhotoCapture = useCallback(
    (file: File) => {
      if (chatPhotos.length >= MAX_CHAT_PHOTOS) return;
      const photoId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const preview = URL.createObjectURL(file);
      setChatPhotos((prev) => {
        if (prev.length >= MAX_CHAT_PHOTOS) return prev;
        return [...prev, { id: photoId, file, preview, markdown: "", parsing: true }];
      });
      parseFileViaApi(file, photoId, true);
    },
    [chatPhotos.length, parseFileViaApi]
  );

  const removeChatFile = useCallback((fileId: string) => {
    setChatFiles((prev) => prev.filter((f) => f.id !== fileId));
  }, []);

  const removeChatPhoto = useCallback((photoId: string) => {
    setChatPhotos((prev) => {
      const photo = prev.find((p) => p.id === photoId);
      if (photo?.preview) URL.revokeObjectURL(photo.preview);
      return prev.filter((p) => p.id !== photoId);
    });
  }, []);

  /* ââ Bulk delete sources ââ */
  const deleteSelectedSources = useCallback(async () => {
    if (selectedSourceIds.size === 0) return;
    const ids = Array.from(selectedSourceIds);
    try {
      const res = await fetch("/api/sources", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-admin-code": encodeURIComponent(inviteCodeRef.current) },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) return;
      setSources((prev) => prev.filter((s) => !selectedSourceIds.has(s.id)));
      setSelectedSourceIds(new Set());
      setBulkSelectMode(false);
    } catch (e) {
      console.error("Failed to delete sources:", e);
    }
  }, [selectedSourceIds]);

  /* ââ Bulk delete conversations ââ */
  const deleteSelectedConversations = useCallback(async () => {
    if (selectedConvIds.size === 0) return;
    const ids = Array.from(selectedConvIds);
    await fetch("/api/conversations", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      body: JSON.stringify({ ids }),
    });
    setConversations((prev) => prev.filter((c) => !selectedConvIds.has(c.id)));
    if (activeConvId && selectedConvIds.has(activeConvId)) {
      setActiveConvId(null);
      convIdRef.current = null;
      setChatKey(`new-${Date.now()}`);
      setMessages([]);
      setHasSummary(false);
    }
    setSelectedConvIds(new Set());
    setConvBulkMode(false);
  }, [selectedConvIds, activeConvId, setMessages]);

  const deleteAllConversations = useCallback(async () => {
    await fetch("/api/conversations?all=true", { method: "DELETE", headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) } });
    setConversations([]);
    setActiveConvId(null);
    convIdRef.current = null;
    setChatKey(`new-${Date.now()}`);
    setMessages([]);
    setHasSummary(false);
    setSelectedConvIds(new Set());
    setConvBulkMode(false);
  }, [setMessages]);

  /* ââ Submit handler with pending logic ââ */
  const handleSubmit = useCallback(
    async (e?: FormEvent, overrideText?: string) => {
      e?.preventDefault();
      const text = (overrideText ?? input).trim();
      const hasFiles = chatFiles.filter((f) => !f.parsing && !f.error && f.markdown).length > 0;
      const hasPhotos = chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown).length > 0;
      if ((!text && !hasFiles && !hasPhotos) || isLoading || isSending) return;

      setIsSending(true);
      setChatError(null);

      // Prepare attached documents from chatFiles + chatPhotos
      const readyFiles = chatFiles.filter((f) => !f.parsing && !f.error && f.markdown);
      const readyPhotos = chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown);
      const attachedDocuments = [
        ...readyFiles.map((f) => ({ filename: f.filename, markdown: f.markdown })),
        ...readyPhotos.map((p, i) => ({ filename: p.file.name || `Ð¤Ð¾ÑÐ¾ ${i + 1}`, markdown: p.markdown })),
      ];
      const attachmentNames = [
        ...readyFiles.map((f) => f.filename),
        ...readyPhotos.map((p) => p.file.name || "Ð¤Ð¾ÑÐ¾"),
      ];
      const messageText = text || (attachmentNames.length > 0 ? `ÐÑÐ¾Ð²ÐµÑÑ ${attachmentNames.length === 1 ? "Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ" : "Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÑ"}: ${attachmentNames.join(", ")}` : "");

      // Clear files, photos and input immediately
      setChatFiles([]);
      // Revoke photo preview URLs before clearing
      chatPhotos.forEach((p) => { if (p.preview) URL.revokeObjectURL(p.preview); });
      setChatPhotos([]);

      if (!convIdRef.current) {
        pendingSubmitRef.current = messageText;
        setInput("");
        const title = messageText.slice(0, 50) + (messageText.length > 50 ? "..." : "");
        let newId: string;
        try {
          newId = await createConversation(title);
        } catch (err) {
          console.error("Failed to create conversation:", err);
          const errMsg = err instanceof Error ? err.message : "ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ ÑÐ¾Ð·Ð´Ð°ÑÑ Ð´Ð¸Ð°Ð»Ð¾Ð³";
          setChatError(errMsg.includes("401") ? "ÐÑÐ¸Ð±ÐºÐ° Ð°Ð²ÑÐ¾ÑÐ¸Ð·Ð°ÑÐ¸Ð¸. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð¿ÐµÑÐµÐ»Ð¾Ð³Ð¸Ð½Ð¸ÑÑÑÑ." : errMsg);
          setInput(messageText);
          pendingSubmitRef.current = null;
          setIsSending(false);
          return;
        }

        setMessages((prev) => [
          ...prev,
          { id: `temp-user-${Date.now()}`, role: "user", content: messageText, ...(attachmentNames.length > 0 && { attachments: attachmentNames }) },
        ]);

        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
            body: JSON.stringify({
              messages: [{ role: "user", content: messageText }],
              conversationId: newId,
              ...(attachedDocuments.length > 0 && { attachedDocuments }),
            }),
          });

          if (!res.ok || !res.body) {
            if (res.status === 401) {
              setChatError("ÐÑÐ¸Ð±ÐºÐ° Ð°Ð²ÑÐ¾ÑÐ¸Ð·Ð°ÑÐ¸Ð¸. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð¿ÐµÑÐµÐ»Ð¾Ð³Ð¸Ð½Ð¸ÑÑÑÑ.");
            } else {
              setChatError("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð¿Ð¾Ð»ÑÑÐ¸ÑÑ Ð¾ÑÐ²ÐµÑ Ð¾Ñ ÐÐ. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ ÐµÑÑ ÑÐ°Ð·.");
            }
            throw new Error(`Stream failed: ${res.status}`);
          }

          // Parse sources from header
          let sources: string[] = [];
          try {
            const srcHeader = res.headers.get("X-Sources");
            if (srcHeader) sources = JSON.parse(decodeURIComponent(srcHeader));
          } catch { /* ignore */ }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let assistantText = "";
          const assistantId = `temp-assistant-${Date.now()}`;

          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", content: "", sources },
          ]);

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");
            for (const line of lines) {
              if (line.startsWith("0:")) {
                try {
                  const parsed = JSON.parse(line.slice(2));
                  if (typeof parsed === "string") {
                    assistantText += parsed;
                  }
                } catch {
                  // ignore parse errors
                }
              }
            }

            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: assistantText } : m
              )
            );
          }
        } catch (err) {
          console.error("Manual stream error:", err);
        }

        pendingSubmitRef.current = null;
        setIsSending(false);
        loadConversations();
        return;
      }

      const currentMessages = [
        ...messages,
        { id: `temp-user-${Date.now()}`, role: "user" as const, content: messageText, ...(attachmentNames.length > 0 && { attachments: attachmentNames }) },
      ];
      setMessages(currentMessages);
      setInput("");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
          body: JSON.stringify({
            messages: currentMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            conversationId: convIdRef.current,
            ...(attachedDocuments.length > 0 && { attachedDocuments }),
          }),
        });

        if (!res.ok || !res.body) {
          if (res.status === 401) {
            setChatError("ÐÑÐ¸Ð±ÐºÐ° Ð°Ð²ÑÐ¾ÑÐ¸Ð·Ð°ÑÐ¸Ð¸. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ Ð¿ÐµÑÐµÐ»Ð¾Ð³Ð¸Ð½Ð¸ÑÑÑÑ.");
          } else {
            setChatError("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð¿Ð¾Ð»ÑÑÐ¸ÑÑ Ð¾ÑÐ²ÐµÑ Ð¾Ñ ÐÐ. ÐÐ¾Ð¿ÑÐ¾Ð±ÑÐ¹ÑÐµ ÐµÑÑ ÑÐ°Ð·.");
          }
          throw new Error(`Stream failed: ${res.status}`);
        }

        // Parse sources from header
        let sources: string[] = [];
        try {
          const srcHeader = res.headers.get("X-Sources");
          if (srcHeader) sources = JSON.parse(decodeURIComponent(srcHeader));
        } catch { /* ignore */ }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = "";
        const assistantId = `temp-assistant-${Date.now()}`;

        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: "", sources },
        ]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("0:")) {
              try {
                const parsed = JSON.parse(line.slice(2));
                if (typeof parsed === "string") {
                  assistantText += parsed;
                }
              } catch {
                // ignore
              }
            }
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: assistantText } : m
            )
          );
        }
      } catch (err) {
        console.error("Stream error:", err);
      } finally {
        setIsSending(false);
      }
    },
    [input, isLoading, isSending, messages, chatFiles, chatPhotos, setInput, setMessages, createConversation, loadConversations]
  );

  /* ââ Auto-scroll ââ */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ââ Key handler ââ */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /* ââ Derived ââ */
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]?.role === "user";

  /* ââ Render ââ */

  // Show loading spinner
  if (authLoading) {
    return <div className="invite-gate"><div className="admin-spinner" /></div>;
  }

  // Show invite gate if not authenticated
  if (!isAuthenticated) {
    return <InviteGate onSuccess={handleAuthSuccess} />;
  }

  return (
    <>
      <div className="app-layout">
        {/* ââ Header ââ */}
        <header className="app-header">
          <div className="header-brand">
            {/* Mobile: hamburger menu with nav buttons */}
            <div className="mobile-hamburger-wrapper" ref={mobileMenuRef}>
              <button
                className="menu-btn"
                onClick={() => setMobileMenuOpen((o) => !o)}
                title="ÐÐµÐ½Ñ"
              >
                <MenuIcon />
                {unreadSupportCount > 0 && (
                  <span className="mobile-hamburger-badge">{unreadSupportCount}</span>
                )}
              </button>
              {mobileMenuOpen && (
                <div className="mobile-hamburger-dropdown">
                  <a
                    className="mobile-hamburger-item"
                    href="https://academy.snabchat.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                    </svg>
                    ÐÐ±ÑÑÐµÐ½Ð¸Ðµ
                  </a>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); openSupportModal(); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                    </svg>
                    ÐÐ¾Ð´Ð´ÐµÑÐ¶ÐºÐ°
                    {unreadSupportCount > 0 && (
                      <span className="mobile-hamburger-item-badge">{unreadSupportCount}</span>
                    )}
                  </button>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); navigateToInfographic(); }}
                  >
                    <InfographicIcon />
                    ÐÐ½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÐ°
                  </button>
                  <button
                    className={`mobile-hamburger-item${activeView === "knowledge-base" ? " active" : ""}`}
                    onClick={() => { setMobileMenuOpen(false); setActiveView(activeView === "knowledge-base" ? "chat" : "knowledge-base"); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    </svg>
                    ÐÐ°Ð·Ð° Ð·Ð½Ð°Ð½Ð¸Ð¹
                  </button>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); setRightOpen((o) => !o); }}
                  >
                    <HistoryIcon />
                    ÐÑÑÐ¾ÑÐ¸Ñ Ð´Ð¸Ð°Ð»Ð¾Ð³Ð¾Ð²
                  </button>
                </div>
              )}
            </div>
            <button
              className="header-logo-btn"
              onClick={() => {
                setActiveView("chat");
                setActiveConvId(null);
                convIdRef.current = null;
                setChatKey(`new-${Date.now()}`);
                setMessages([]);
                setHasSummary(false);
              }}
              title="ÐÐ° Ð³Ð»Ð°Ð²Ð½ÑÑ"
            >
              <SpektrIcon size={36} />
              <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
                <span style={{ color: '#003A7A' }}>Ð¡Ð½Ð°Ð±</span><span style={{ color: '#0099CC' }}>Ð§Ð°Ñ</span>
              </span>
            </button>
            <div className="header-divider desktop-only" />
            <span className="header-username desktop-only">
              {userName}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {hasSummary && <span className="memory-pill">ÐÐ°Ð¼ÑÑÑ Ð°ÐºÑÐ¸Ð²Ð½Ð°</span>}
            {/* Desktop: nav buttons inline */}
            <a
              className="header-labeled-btn accent desktop-only"
              href="https://academy.snabchat.app/"
              target="_blank"
              rel="noopener noreferrer"
              title="ÐÐ±ÑÑÐµÐ½Ð¸Ðµ"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              <span className="btn-label">ÐÐ±ÑÑÐµÐ½Ð¸Ðµ</span>
            </a>
            <button
              className="header-labeled-btn accent desktop-only"
              onClick={openSupportModal}
              title="ÐÐ¾Ð´Ð´ÐµÑÐ¶ÐºÐ°"
              style={{ position: "relative" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
              </svg>
              <span className="btn-label">ÐÐ¾Ð´Ð´ÐµÑÐ¶ÐºÐ°</span>
              {unreadSupportCount > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -4,
                  background: "#e53935", color: "#fff", borderRadius: "50%",
                  width: 18, height: 18, fontSize: 11, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{unreadSupportCount}</span>
              )}
            </button>
            <button
              className="header-labeled-btn accent desktop-only"
              onClick={() => navigateToInfographic()}
              title="ÐÐµÐ½ÐµÑÐ°ÑÐ¾Ñ Ð¸Ð½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÐ¸"
            >
              <InfographicIcon />
              <span className="btn-label">ÐÐ½ÑÐ¾Ð³ÑÐ°ÑÐ¸ÐºÐ°</span>
            </button>
            <button
              className={`header-labeled-btn accent desktop-only${activeView === "knowledge-base" ? " active" : ""}`}
              onClick={() => setActiveView(activeView === "knowledge-base" ? "chat" : "knowledge-base")}
              title="ÐÐ°Ð·Ð° Ð·Ð½Ð°Ð½Ð¸Ð¹"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="btn-label">ÐÐ°Ð·Ð° Ð·Ð½Ð°Ð½Ð¸Ð¹</span>
            </button>
            <button
              className="header-labeled-btn primary desktop-only"
              onClick={() => {
                setActiveView("chat");
                setActiveConvId(null);
                convIdRef.current = null;
                setChatKey(`new-${Date.now()}`);
                setMessages([]);
                setHasSummary(false);
              }}
              title="ÐÐ¾Ð²ÑÐ¹ ÑÐ°Ñ"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              <span className="btn-label">ÐÐ¾Ð²ÑÐ¹ ÑÐ°Ñ</span>
            </button>
            <button
              className="menu-btn"
              onClick={() => {
                setActiveView("chat");
                setActiveConvId(null);
                convIdRef.current = null;
                setChatKey(`new-${Date.now()}`);
                setMessages([]);
                setHasSummary(false);
              }}
              title="ÐÐ¾Ð²ÑÐ¹ ÑÐ°Ñ"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
            {/* Desktop: inline logout button */}
            <button
              className="header-action-btn desktop-only"
              onClick={handleLogout}
              title="ÐÑÐ¹ÑÐ¸"
              style={{ color: "var(--text-muted)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
            {/* Mobile: user avatar with dropdown menu */}
            <div className="user-menu-wrapper mobile-only" ref={userMenuRef}>
              <button
                className="user-menu-btn"
                onClick={() => setUserMenuOpen((o) => !o)}
                title={userName}
              >
                {userInitials}
              </button>
              {userMenuOpen && (
                <div className="user-menu-dropdown">
                  <div className="user-menu-name">{userName}</div>
                  <div className="user-menu-divider" />
                  {isAdmin && (
                    <a className="user-menu-item" href="/admin">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      ÐÐ´Ð¼Ð¸Ð½-Ð¿Ð°Ð½ÐµÐ»Ñ
                    </a>
                  )}
                  <button className="user-menu-item" onClick={handleLogout}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    ÐÑÐ¹ÑÐ¸
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* ââ Body ââ */}
        <div className="app-body">
          {/* Sidebar overlay (mobile) */}
          {rightOpen && (
            <div className="sidebar-overlay" onClick={() => setRightOpen(false)} />
          )}

          {/* ââ Main ââ */}
          {activeView === "knowledge-base" ? (
            <main className="main-area">
              <div className="kb-view">
                <div className="kb-header">
                  <h2 className="kb-title">ÐÐ°Ð·Ð° Ð·Ð½Ð°Ð½Ð¸Ð¹</h2>
                  <span className="kb-badge">{sources.length}</span>
                  {isAdmin && sources.length > 0 && (
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      {!bulkSelectMode ? (
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 12, padding: "5px 12px" }}
                          onClick={() => setBulkSelectMode(true)}
                        >
                          ÐÑÐ±ÑÐ°ÑÑ
                        </button>
                      ) : (
                        <>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => {
                              const filtered = sources.filter((s) => kbCategoryFilter === "all" || (s.folder_path || "other") === kbCategoryFilter);
                              if (selectedSourceIds.size === filtered.length && filtered.every((s) => selectedSourceIds.has(s.id))) {
                                setSelectedSourceIds(new Set());
                              } else {
                                setSelectedSourceIds(new Set(filtered.map((s) => s.id)));
                              }
                            }}
                          >
                            {(() => {
                              const filtered = sources.filter((s) => kbCategoryFilter === "all" || (s.folder_path || "other") === kbCategoryFilter);
                              return selectedSourceIds.size === filtered.length && filtered.every((s) => selectedSourceIds.has(s.id)) ? "Ð¡Ð½ÑÑÑ Ð²ÑÑ" : "ÐÑÐ±ÑÐ°ÑÑ Ð²ÑÐµ";
                            })()}
                          </button>
                          <button
                            className="btn-secondary"
                            style={{
                              fontSize: 12,
                              padding: "5px 12px",
                              color: selectedSourceIds.size > 0 ? "var(--error)" : undefined,
                            }}
                            disabled={selectedSourceIds.size === 0}
                            onClick={deleteSelectedSources}
                          >
                            Ð£Ð´Ð°Ð»Ð¸ÑÑ ({selectedSourceIds.size})
                          </button>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => { setSelectedSourceIds(new Set()); setBulkSelectMode(false); }}
                          >
                            â
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="kb-pills">
                  <button
                    className={`kb-pill ${kbCategoryFilter === "all" ? "active" : ""}`}
                    onClick={() => setKbCategoryFilter("all")}
                  >
                    ÐÑÐµ ({sources.length})
                  </button>
                  {[
                    { key: "npa", label: "ÐÐÐ" },
                    { key: "standards", label: "Ð¡ÑÐ°Ð½Ð´Ð°ÑÑÑ Ð¸ ÐÐ¾Ð»Ð¾Ð¶ÐµÐ½Ð¸Ñ" },
                    { key: "forms", label: "Ð¤Ð¾ÑÐ¼Ñ Ð¸ Ð¨Ð°Ð±Ð»Ð¾Ð½Ñ" },
                    { key: "schemas", label: "Ð¡ÑÐµÐ¼Ñ Ð¿ÑÐ¾ÑÐµÑÑÐ¾Ð²" },
                    { key: "instructions", label: "ÐÐ½ÑÑÑÑÐºÑÐ¸Ð¸ Ð¸ ÐÐµÑÐ¾Ð´Ð¸ÐºÐ¸" },
                    { key: "pricing", label: "Ð¦ÐµÐ½Ð¾Ð¾Ð±ÑÐ°Ð·Ð¾Ð²Ð°Ð½Ð¸Ðµ" },
                    { key: "references", label: "Ð¡Ð¿ÑÐ°Ð²Ð¾ÑÐ½Ð¸ÐºÐ¸ Ð¸ Ð ÐµÐµÑÑÑÑ" },
                    { key: "contracts", label: "ÐÐ¾Ð³Ð¾Ð²Ð¾ÑÑ" },
                  ].map((cat) => {
                    const count = sources.filter((s) => (s.folder_path || "standards") === cat.key).length;
                    return (
                      <button
                        key={cat.key}
                        className={`kb-pill ${kbCategoryFilter === cat.key ? "active" : ""}`}
                        onClick={() => setKbCategoryFilter(cat.key)}
                      >
                        {cat.label} ({count})
                      </button>
                    );
                  })}
                </div>

                {sources.length === 0 ? (
                  <div className="kb-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 12 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <p>ÐÐµÑ Ð·Ð°Ð³ÑÑÐ¶ÐµÐ½Ð½ÑÑ Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÐ¾Ð²</p>
                  </div>
                ) : (
                  <div className="kb-list">
                    {sources
                      .filter((s) => kbCategoryFilter === "all" || (s.folder_path || "standards") === kbCategoryFilter)
                      .map((doc) => {
                        const ext = doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : "docx";
                        const catLabel = [
                          { key: "npa", label: "ÐÐÐ" },
                          { key: "standards", label: "Ð¡ÑÐ°Ð½Ð´Ð°ÑÑÑ Ð¸ ÐÐ¾Ð»Ð¾Ð¶ÐµÐ½Ð¸Ñ" },
                          { key: "forms", label: "Ð¤Ð¾ÑÐ¼Ñ Ð¸ Ð¨Ð°Ð±Ð»Ð¾Ð½Ñ" },
                          { key: "schemas", label: "Ð¡ÑÐµÐ¼Ñ Ð¿ÑÐ¾ÑÐµÑÑÐ¾Ð²" },
                          { key: "instructions", label: "ÐÐ½ÑÑÑÑÐºÑÐ¸Ð¸ Ð¸ ÐÐµÑÐ¾Ð´Ð¸ÐºÐ¸" },
                          { key: "pricing", label: "Ð¦ÐµÐ½Ð¾Ð¾Ð±ÑÐ°Ð·Ð¾Ð²Ð°Ð½Ð¸Ðµ" },
                          { key: "references", label: "Ð¡Ð¿ÑÐ°Ð²Ð¾ÑÐ½Ð¸ÐºÐ¸ Ð¸ Ð ÐµÐµÑÑÑÑ" },
                          { key: "contracts", label: "ÐÐ¾Ð³Ð¾Ð²Ð¾ÑÑ" },
                        ].find((c) => c.key === (doc.folder_path || "standards"))?.label || "Ð¡ÑÐ°Ð½Ð´Ð°ÑÑÑ Ð¸ ÐÐ¾Ð»Ð¾Ð¶ÐµÐ½Ð¸Ñ";
                        return (
                          <div
                            key={doc.id}
                            className="kb-row"
                            style={bulkSelectMode ? { cursor: "pointer" } : undefined}
                            onClick={() => {
                              if (bulkSelectMode) {
                                setSelectedSourceIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(doc.id)) next.delete(doc.id);
                                  else next.add(doc.id);
                                  return next;
                                });
                              }
                            }}
                          >
                            {bulkSelectMode && (
                              <input
                                type="checkbox"
                                checked={selectedSourceIds.has(doc.id)}
                                onChange={() => {
                                  setSelectedSourceIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(doc.id)) next.delete(doc.id);
                                    else next.add(doc.id);
                                    return next;
                                  });
                                }}
                                onClick={(e) => e.stopPropagation()}
                                style={{ flexShrink: 0 }}
                              />
                            )}
                            <div className={`kb-row-icon ${ext}`}>
                              {ext === "pdf" ? "PDF" : ext === "xlsx" ? "XLS" : "DOC"}
                            </div>
                            <div className="kb-row-info">
                              <div className="kb-row-name">{doc.filename}</div>
                              <div className="kb-row-meta">
                                <span className="kb-row-cat">{catLabel}</span>
                                <span>&middot;</span>
                                <span>{new Date(doc.created_at).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" })}</span>
                                {doc.tags && doc.tags.length > 0 && (
                                  <>
                                    <span>&middot;</span>
                                    <span>{doc.tags.length} ÑÐµÐ³Ð¾Ð²</span>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="kb-row-actions">
                              <button
                                className="kb-action-btn"
                                onClick={() => setViewingSource(doc)}
                                title="ÐÑÐ¾ÑÐ¼Ð¾ÑÑ"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                              </button>
                              <a
                                className="kb-action-btn"
                                href={`/api/sources/download?id=${doc.id}&action=download`}
                                title="Ð¡ÐºÐ°ÑÐ°ÑÑ"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="7 10 12 15 17 10" />
                                  <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                              </a>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            </main>
          ) : (
          <main className="main-area">
            <div className="chat-column">
              <div className="messages-area" ref={scrollRef}>
                {hasSummary && (
                  <div className="summary-notice">â¹ Ð Ð°Ð½Ð½Ð¸Ðµ ÑÐ¾Ð¾Ð±ÑÐµÐ½Ð¸Ñ ÑÐ¶Ð°ÑÑ Ð² ÑÐµÐ·ÑÐ¼Ðµ</div>
                )}
                {messages.length === 0 && !hasSummary && <EmptyState onChipClick={(text) => handleSubmit(undefined, text)} />}
                {messages.map((m, idx) => {
                  const prevUserMsg = m.role === "assistant"
                    ? [...messages].slice(0, idx).reverse().find((pm) => pm.role === "user")
                    : undefined;
                  return (
                    <MessageBubble
                      key={m.id}
                      message={m}
                      allSources={sources}
                      onViewSource={setViewingSource}
                      onCreateInfographic={m.role === "assistant" ? navigateToInfographic : undefined}
                      onExportDocx={m.role === "assistant" ? (content: string) => handleExportDocx(content, prevUserMsg?.content || "ÐÐ°Ð¿ÑÐ¾Ñ") : undefined}
                      onExportExcel={m.role === "assistant" && containsMarkdownTable(m.content) ? (content: string) => handleExportExcel(content, prevUserMsg?.content || "ÐÐ°Ð¿ÑÐ¾Ñ") : undefined}
                    />
                  );
                })}
                {isSending && <TypingBubble />}
                {chatError && (
                  <div className="message message-error" style={{ background: "var(--error-bg, #fef2f2)", border: "1px solid var(--error-border, #fecaca)", borderRadius: 12, padding: "12px 18px", margin: "8px 0", color: "var(--error-text, #991b1b)", fontSize: 14 }}>
                    {chatError}
                    <button onClick={() => setChatError(null)} style={{ marginLeft: 12, background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: 600 }}>Ã</button>
                  </div>
                )}
              </div>

              <form className="input-area" onSubmit={handleSubmit}>
                {/* Photo previews */}
                {chatPhotos.length > 0 && (
                  <div className="photo-preview-bar">
                    <div className="photo-preview-header">
                      <span className="photo-preview-count">Ð¤Ð¾ÑÐ¾: {chatPhotos.length}/{MAX_CHAT_PHOTOS}</span>
                      {chatPhotos.some((p) => p.parsing) && <span className="photo-preview-processing">Ð Ð°ÑÐ¿Ð¾Ð·Ð½Ð°Ð²Ð°Ð½Ð¸Ðµ...</span>}
                    </div>
                    <div className="photo-preview-grid">
                      {chatPhotos.map((p) => (
                        <div key={p.id} className="photo-preview-item">
                          <img src={p.preview} alt="Ð¤Ð¾ÑÐ¾" className="photo-preview-img" />
                          {p.parsing && (
                            <div className="photo-preview-overlay">
                              <div className="chip-spinner" />
                            </div>
                          )}
                          {!p.parsing && !p.error && p.markdown && (
                            <div className="photo-preview-badge photo-preview-success">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </div>
                          )}
                          {p.error && (
                            <div className="photo-preview-badge photo-preview-error">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </div>
                          )}
                          <button type="button" className="photo-preview-remove" onClick={() => removeChatPhoto(p.id)} title="Ð£Ð´Ð°Ð»Ð¸ÑÑ">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Chat file chips */}
                {chatFiles.length > 0 && (
                  <div className="chat-files-bar">
                    {chatFiles.map((f) => (
                      <div key={f.id} className={`chat-file-chip ${f.parsing ? "parsing" : ""} ${f.error ? "error" : ""}`}>
                        {f.parsing ? (
                          <div className="chip-spinner" />
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                        )}
                        <span className="chip-name" title={f.filename}>{f.filename}</span>
                        <span className="chip-size">{(f.file.size / 1024 / 1024).toFixed(1)} ÐÐ</span>
                        <button type="button" className="chip-remove" onClick={() => removeChatFile(f.id)} title="Ð£Ð´Ð°Ð»Ð¸ÑÑ">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="input-wrapper">
                  {/* Attach file button */}
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept={ACCEPTED_CHAT_TYPES}
                    multiple
                    onChange={(e) => {
                      if (e.target.files) handleChatFileSelect(e.target.files);
                      e.target.value = "";
                    }}
                    style={{ display: "none" }}
                  />
                  <button
                    type="button"
                    className="attach-btn"
                    onClick={() => chatFileInputRef.current?.click()}
                    disabled={isSending}
                    title="ÐÑÐ¸ÐºÑÐµÐ¿Ð¸ÑÑ ÑÐ°Ð¹Ð» Ð¸Ð»Ð¸ ÑÐ¾ÑÐ¾"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  {/* Camera button (mobile only) */}
                  <CameraButton
                    onCapture={handlePhotoCapture}
                    disabled={isSending}
                    maxPhotos={MAX_CHAT_PHOTOS}
                    currentPhotoCount={chatPhotos.length}
                  />
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    placeholder={chatFiles.length > 0 || chatPhotos.length > 0 ? "ÐÐ¿Ð¸ÑÐ¸ÑÐµ ÑÑÐ¾ Ð¿ÑÐ¾Ð²ÐµÑÐ¸ÑÑ Ð¸Ð»Ð¸ Ð½Ð°Ð¶Ð¼Ð¸ÑÐµ Ð¾ÑÐ¿ÑÐ°Ð²Ð¸ÑÑ..." : "ÐÐ°Ð´Ð°Ð¹ÑÐµ Ð²Ð¾Ð¿ÑÐ¾Ñ..."}
                    rows={1}
                    className="chat-input"
                    style={{ maxHeight: 160 }}
                    onInput={(e) => {
                      const t = e.currentTarget;
                      t.style.height = "auto";
                      t.style.height = Math.min(t.scrollHeight, 160) + "px";
                    }}
                  />
                  {/* Voice input button */}
                  <VoiceButton
                    onTranscript={(text) => setInput((prev) => (prev ? prev + " " + text : text))}
                    disabled={isSending}
                  />
                  <button
                    type="submit"
                    disabled={isLoading || isSending || (!input.trim() && chatFiles.filter((f) => !f.parsing && !f.error && f.markdown).length === 0 && chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown).length === 0)}
                    className="send-btn"
                  >
                    <ArrowUpIcon />
                  </button>
                </div>
              </form>
            </div>
          </main>
          )}

          {/* ââ Right sidebar: Dialogs ââ */}
          <aside className={`sidebar-panel right ${rightOpen ? "open" : ""} ${rightCollapsed ? "collapsed" : ""}`}>
            <button
              className="sidebar-collapse-btn"
              onClick={() => setRightCollapsed((c) => !c)}
            >
              {rightCollapsed ? "ÐÐ¸Ð°Ð»Ð¾Ð³Ð¸" : "Ð¡Ð²ÐµÑÐ½ÑÑÑ"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points={rightCollapsed ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
              </svg>
            </button>
            <div className="sidebar-content">
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>ÐÐÐÐÐÐÐ</span>
                  <button
                    onClick={() => {
                      setActiveConvId(null);
                      convIdRef.current = null;
                      setChatKey(`new-${Date.now()}`);
                      setMessages([]);
                      setHasSummary(false);
                    }}
                    title="ÐÐ¾Ð²ÑÐ¹ Ð´Ð¸Ð°Ð»Ð¾Ð³"
                    style={{ fontSize: 16, color: "var(--text-secondary)", lineHeight: 1 }}
                  >
                    +
                  </button>
                </div>
                {conversations.length > 0 && (
                  <div style={{ display: "flex", gap: 4, padding: "0 12px 8px" }}>
                    {!convBulkMode ? (
                      <button
                        className="btn-secondary"
                        style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                        onClick={() => setConvBulkMode(true)}
                      >
                        ÐÑÐ±ÑÐ°ÑÑ
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                          onClick={() => {
                            if (selectedConvIds.size === conversations.length) {
                              setSelectedConvIds(new Set());
                            } else {
                              setSelectedConvIds(new Set(conversations.map((c) => c.id)));
                            }
                          }}
                        >
                          {selectedConvIds.size === conversations.length ? "Ð¡Ð½ÑÑÑ Ð²ÑÑ" : "ÐÑÐ±ÑÐ°ÑÑ Ð²ÑÐµ"}
                        </button>
                        <button
                          className="btn-secondary"
                          style={{
                            flex: 1,
                            fontSize: 11,
                            padding: "4px 8px",
                            color: selectedConvIds.size > 0 ? "var(--error)" : undefined,
                          }}
                          disabled={selectedConvIds.size === 0}
                          onClick={selectedConvIds.size === conversations.length ? deleteAllConversations : deleteSelectedConversations}
                        >
                          Ð£Ð´Ð°Ð»Ð¸ÑÑ ({selectedConvIds.size})
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                          onClick={() => { setSelectedConvIds(new Set()); setConvBulkMode(false); }}
                        >
                          â
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div className="sidebar-list">
                  {conversations.map((c) => (
                    <div
                      className={`sidebar-item ${c.id === activeConvId ? "active" : ""}`}
                      onClick={() => {
                        if (convBulkMode) {
                          setSelectedConvIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          });
                          return;
                        }
                        switchConversation(c.id);
                      }}
                      key={c.id}
                    >
                      {convBulkMode && (
                        <input
                          type="checkbox"
                          checked={selectedConvIds.has(c.id)}
                          onChange={() => {
                            setSelectedConvIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.id)) next.delete(c.id);
                              else next.add(c.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {c.title}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {formatDate(c.updated_at)}
                        </div>
                      </div>
                      {!convBulkMode && (
                        <button
                          className="doc-delete-btn"
                          onClick={(e) => deleteConversation(c.id, e)}
                          title="Ð£Ð´Ð°Ð»Ð¸ÑÑ Ð´Ð¸Ð°Ð»Ð¾Ð³"
                          style={{
                            fontSize: 14,
                            color: "var(--text-muted)",
                            flexShrink: 0,
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>

        {/* ââ Footer ââ */}
        <footer className="app-footer">
          <span className="footer-full">Ð¡Ð½Ð°Ð±Ð§Ð°Ñ Â· ÐÐ¸ÑÐµÐºÑÐ¸Ñ Ð¿Ð¾ Ð·Ð°ÐºÑÐ¿ÐºÐ°Ð¼ Â· 2026 Â· </span>
          Ð Ð°Ð·ÑÐ°Ð±Ð¾ÑÐºÐ° @ÐÐ¸ÑÐ¸Ð»Ð» Ð¢ÑÑÐ±Ð¸ÑÑÐ½
        </footer>
      </div>

      {viewingSource && (
        <DocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
        />
      )}

      {/* ââ Support Modal ââ */}
      {showSupportModal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.5)", display: "flex",
            alignItems: "center", justifyContent: "center", padding: 16,
          }}
          onClick={() => setShowSupportModal(false)}
        >
          <div
            style={{
              background: "var(--bg-primary, #fff)", borderRadius: 16,
              width: "100%", maxWidth: 520, maxHeight: "80vh",
              display: "flex", flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: "16px 20px", borderBottom: "1px solid var(--border-color, #eee)",
              display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>ÐÐ¾Ð´Ð´ÐµÑÐ¶ÐºÐ°</h3>
              <button onClick={() => setShowSupportModal(false)} style={{
                background: "none", border: "none", fontSize: 22, cursor: "pointer",
                color: "var(--text-muted)", padding: 4,
              }}>&times;</button>
            </div>

            {/* Messages history */}
            <div style={{
              flex: 1, overflowY: "auto", padding: 16,
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              {supportHistory.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 24, fontSize: 14 }}>
                  ÐÐ´ÐµÑÑ Ð±ÑÐ´ÑÑ Ð²Ð°ÑÐ¸ Ð¾Ð±ÑÐ°ÑÐµÐ½Ð¸Ñ Ð² Ð¿Ð¾Ð´Ð´ÐµÑÐ¶ÐºÑ
                </div>
              )}
              {supportHistory.map((m) => (
                <div key={m.id}>
                  {/* User message */}
                  <div style={{
                    background: "var(--bg-secondary, #f5f5f5)", borderRadius: 12,
                    padding: 12, marginBottom: m.admin_reply ? 8 : 0, fontSize: 14,
                  }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                      {new Date(m.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}
                    </div>
                    {m.message}
                  </div>
                  {/* Admin reply */}
                  {m.admin_reply && (
                    <div style={{
                      background: "#e8f4fd", borderRadius: 12, padding: 12,
                      borderLeft: "3px solid #1976d2", fontSize: 14, marginLeft: 24,
                    }}>
                      <div style={{ fontSize: 11, color: "#1976d2", marginBottom: 4 }}>
                        ÐÐ´Ð¼Ð¸Ð½Ð¸ÑÑÑÐ°ÑÐ¾Ñ {m.admin_number ?? ""} Â· {m.replied_at ? new Date(m.replied_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : ""}
                      </div>
                      {m.admin_reply}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Input */}
            <div style={{ padding: 16, borderTop: "1px solid var(--border-color, #eee)" }}>
              <textarea
                value={supportMessage}
                onChange={(e) => setSupportMessage(e.target.value)}
                placeholder="ÐÐ¿Ð¸ÑÐ¸ÑÐµ Ð²Ð°ÑÑ Ð¿ÑÐ¾Ð±Ð»ÐµÐ¼Ñ Ð¸Ð»Ð¸ Ð²Ð¾Ð¿ÑÐ¾Ñ..."
                rows={3}
                style={{
                  width: "100%", borderRadius: 10, border: "1px solid var(--border-color, #ddd)",
                  padding: 12, fontSize: 14, resize: "none", fontFamily: "inherit",
                  background: "var(--bg-primary, #fff)", color: "var(--text-primary, #333)",
                }}
              />
              <button
                onClick={sendSupportMessage}
                disabled={supportSending || !supportMessage.trim()}
                style={{
                  marginTop: 8, width: "100%", padding: "10px 16px",
                  borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
                  background: supportSending || !supportMessage.trim() ? "#ccc" : "#1976d2",
                  color: "#fff", cursor: supportSending ? "wait" : "pointer",
                }}
              >
                {supportSending ? "ÐÑÐ¿ÑÐ°Ð²ÐºÐ°..." : "ÐÑÐ¿ÑÐ°Ð²Ð¸ÑÑ"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
