"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "ai/react";
import ReactMarkdown from "react-markdown";
import InviteGate from "./InviteGate";

/* ── Types ── */

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

/* ── SpeechRecognition types ── */

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

/* ── Helpers ── */

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (isToday) return "сегодня";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getDate() === yesterday.getDate() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return "вчера";

  const months = [
    "янв", "фев", "мар", "апр", "май", "июн",
    "июл", "авг", "сен", "окт", "ноя", "дек",
  ];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

/* ── Inline SVG icons ── */

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

/* ── VoiceButton ── */

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

/* ── CameraButton (mobile only) ── */

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
            .catch(() => setError("Не удалось запустить видео"));
        };
      }
    } catch {
      setError("Нет доступа к камере");
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
        title="Сделать фото документа"
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
              <button onClick={startCamera} className="camera-retry" type="button">Повторить</button>
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

/* ── Sub-components ── */

function cleanMarkdown(text: string): string {
  let s = text;
  // Remove backslash escapes from mammoth: \( \) \. \- etc.
  s = s.replace(/\\([().,;:!?\-\[\]{}+=#])/g, "$1");
  // Decode URL-encoded strings (%D1%81%D1%80... → readable text)
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
  // Remove link syntax [text](url) → text
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
  const [excelSheets, setExcelSheets] = useState<ExcelSheet[] | null>(null);
  const [loading, setLoading] = useState(true);
  const isPdf = source.mime_type?.includes("pdf");
  const isExcel =
    source.mime_type?.includes("sheet") ||
    source.mime_type?.includes("excel") ||
    source.filename?.endsWith(".xlsx") ||
    source.filename?.endsWith(".xls");
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
            setContent("Не удалось загрузить содержимое");
          }
        })
        .catch(() => setContent("Не удалось загрузить содержимое"))
        .finally(() => setLoading(false));
      return;
    }
    fetch(`/api/sources/content?id=${source.id}`)
      .then((r) => r.json())
      .then((d) => setContent(cleanMarkdown(d.markdown || "")))
      .catch(() => setContent("Не удалось загрузить содержимое"))
      .finally(() => setLoading(false));
  }, [source.id, isPdf, isExcel, hasOriginal]);

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
              {hasOriginal ? `Скачать (${source.filename.split('.').pop()?.toUpperCase()})` : "Скачать (.md)"}
            </button>
            <button className="btn-secondary" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
        <div className="document-viewer-body">
          {loading ? (
            <div className="document-viewer-loading">Загрузка...</div>
          ) : isPdf && hasOriginal ? (
            <iframe
              src={`/api/sources/download?id=${source.id}&action=view`}
              className="document-viewer-iframe"
              title={source.filename}
            />
          ) : excelSheets ? (
            <ExcelViewer sheets={excelSheets} />
          ) : (
            <div className="document-viewer-content" style={{ whiteSpace: "pre-wrap" }}>
              {content || ""}
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
            Инфографика{message.metadata.topic ? `: ${message.metadata.topic}` : ""}
          </div>
          <img
            src={message.metadata.image_base64}
            alt={message.metadata.topic || "Инфографика"}
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
            Скачать PNG
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
    // Match by document code pattern (e.g., "С-ГК-В5-02" found in both text and filename)
    const codeMatch = n.match(/[А-ЯA-Z][\w-]*(?:В\d|У\d|Б\d)[\w-]*/i);
    if (codeMatch) {
      const code = codeMatch[0].toLowerCase();
      src = allSources.find((doc) => doc.filename.toLowerCase().includes(code));
    }
    return src;
  };

  // Make all source tags clickable — if no exact source found, open download search
  const handleSourceClick = (sourceName: string) => {
    const src = findSource(sourceName);
    if (src) {
      onViewSource(src);
    }
  };

  // Build patterns from source filenames to linkify in text
  const linkifyContent = (text: string): string => {
    if (allSources.length === 0) return text;

    // Extract document codes from filenames (e.g., "С-НМГРЭС-В5-03", "И-ГК-В5-02", "Пл-ГК-В5-03")
    const codePatterns: { code: string; sourceId: number }[] = [];
    for (const src of allSources) {
      // Match codes like: С-НМГРЭС-В5-03, И-ГК-В1/У6-02, Пл-ГК-В5-03, М-ГК-В1/У4-01
      const codes = src.filename.match(/[А-ЯA-Zа-яa-z]{1,4}-[А-ЯA-Zа-яa-z/]{1,15}-[А-ЯA-Zа-яa-z0-9/]{1,6}-\d{1,3}/gi);
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

      // Check if preceded by ]( — we'd be inside a link URL
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
                      title={`Открыть: ${src.filename}`}
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
                    title={`Открыть: ${src.filename}`}
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
          <div className="message-sources-label">Источники:</div>
          <div className="message-sources-list">
            {message.sources.map((s, i) => {
              const src = findSource(s);
              return (
                <button
                  key={i}
                  className={`message-source-tag source-clickable${!src ? " source-unlinked" : ""}`}
                  onClick={() => handleSourceClick(s)}
                  title={src ? "Открыть документ" : "Документ не найден в базе"}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {(onCreateInfographic || onExportDocx) && (
        <div className="message-infographic-row">
          {onCreateInfographic && (
            <button
              className="message-infographic-btn"
              onClick={() => onCreateInfographic(message.content)}
              title="Создать инфографику на основе этого ответа"
            >
              <InfographicIcon size={14} />
              Создать инфографику
            </button>
          )}
          {onExportDocx && (
            <button
              className="message-infographic-btn message-export-btn"
              onClick={() => onExportDocx(message.content)}
              title="Скачать ответ в формате DOCX"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <polyline points="9 15 12 18 15 15" />
              </svg>
              Скачать .docx
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="welcome-logo-glow">
        <SpektrIcon size={96} />
      </div>
      <div className="welcome-dept">Дирекция по ресурсному обеспечению</div>
      <div className="welcome-brand">
        <span style={{ color: '#003A7A' }}>Снаб</span><span style={{ color: '#0099CC' }}>Чат</span>
      </div>
      <div className="welcome-divider" />
      <div className="welcome-role">Ваш ИИ-ассистент по закупкам</div>
      <div className="welcome-desc">
        Помогу разобраться в процедурах, найти нужный документ, подготовить ответ или проверить соответствие требованиям
      </div>
      <div className="welcome-chips">
        <div className="welcome-chips-row">
          <button className="welcome-chip" type="button">Как провести закупку?</button>
          <button className="welcome-chip" type="button">Сроки подачи заявок</button>
        </div>
        <div className="welcome-chips-row">
          <button className="welcome-chip" type="button">Проверить ТЗ</button>
          <button className="welcome-chip" type="button">Требования к поставщикам</button>
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

/* ═══════════════════════════════════════════════
   Main Chat component
   ═══════════════════════════════════════════════ */

export default function Chat() {
  /* ── Auth State ── */
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inviteCode, setInviteCode] = useState<string>("");
  const inviteCodeRef = useRef<string>("");
  const [userName, setUserName] = useState<string>("");
  const [authLoading, setAuthLoading] = useState(true);

  /* ── Keep inviteCodeRef in sync ── */
  useEffect(() => {
    inviteCodeRef.current = inviteCode;
  }, [inviteCode]);

  /* ── Check existing auth on mount ── */
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

  /* ── State ── */
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

  const router = useRouter();

  /* ── Infographic navigation ── */
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

  /* ── Refs ── */
  const convIdRef = useRef<string | null>(null);
  const pendingSubmitRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);

  /* ── useChat ── */
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

  /* ── Load conversations ── */
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

  /* ── Load sources ── */
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

  /* ── Switch conversation ── */
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

  /* ── Create conversation ── */
  const createConversation = useCallback(
    async (title?: string) => {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        body: JSON.stringify({ title: title || "Новый диалог" }),
      });
      if (!res.ok) {
        throw new Error(`Не удалось создать диалог: ${res.status}`);
      }
      const conv = await res.json();
      if (!conv.id) {
        throw new Error("Сервер не вернул ID диалога");
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

  /* ── Delete conversation ── */
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

  /* ── Chat file attach handlers ── */
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
          prev.map((p) => (p.id === fileId ? { ...p, parsing: false, error: "Ошибка распознавания" } : p))
        );
      } else {
        setChatFiles((prev) =>
          prev.map((f) => (f.id === fileId ? { ...f, parsing: false, error: "Ошибка обработки" } : f))
        );
      }
    }
  }, []);

  const handleChatFileSelect = useCallback(
    async (files: FileList) => {
      const newFiles = Array.from(files);

      for (const file of newFiles) {
        if (file.size > MAX_CHAT_FILE_SIZE) {
          alert(`Файл "${file.name}" превышает 25 МБ`);
          continue;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "";

        // Route images to photos
        if (IMAGE_EXTENSIONS.includes(ext)) {
          if (chatPhotos.length >= MAX_CHAT_PHOTOS) {
            alert(`Максимум ${MAX_CHAT_PHOTOS} фото`);
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
          alert(`Формат .${ext} не поддерживается. Допустимые: PDF, DOCX, XLSX, изображения`);
          continue;
        }
        if (chatFiles.length >= MAX_CHAT_FILES) {
          alert(`Максимум ${MAX_CHAT_FILES} файлов`);
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

  /* ── Bulk delete conversations ── */
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

  /* ── Submit handler with pending logic ── */
  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
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
        ...readyPhotos.map((p, i) => ({ filename: p.file.name || `Фото ${i + 1}`, markdown: p.markdown })),
      ];
      const attachmentNames = [
        ...readyFiles.map((f) => f.filename),
        ...readyPhotos.map((p) => p.file.name || "Фото"),
      ];
      const messageText = text || (attachmentNames.length > 0 ? `Проверь ${attachmentNames.length === 1 ? "документ" : "документы"}: ${attachmentNames.join(", ")}` : "");

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
          const errMsg = err instanceof Error ? err.message : "Не удалось создать диалог";
          setChatError(errMsg.includes("401") ? "Ошибка авторизации. Попробуйте перелогиниться." : errMsg);
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
              setChatError("Ошибка авторизации. Попробуйте перелогиниться.");
            } else {
              setChatError("Не удалось получить ответ от ИИ. Попробуйте ещё раз.");
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
            setChatError("Ошибка авторизации. Попробуйте перелогиниться.");
          } else {
            setChatError("Не удалось получить ответ от ИИ. Попробуйте ещё раз.");
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

  /* ── Auto-scroll ── */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ── Key handler ── */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /* ── Derived ── */
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]?.role === "user";

  /* ── Render ── */

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
        {/* ── Header ── */}
        <header className="app-header">
          <div className="header-brand">
            <button className="menu-btn" onClick={() => setLeftOpen((o) => !o)}>
              <MenuIcon />
            </button>
            <SpektrIcon size={36} />
            <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
              <span style={{ color: '#003A7A' }}>Снаб</span><span style={{ color: '#0099CC' }}>Чат</span>
            </span>
            <div className="header-divider" />
            <span style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--text-secondary)" }}>
              {userName}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {hasSummary && <span className="memory-pill">Память активна</span>}
            <a
              className="header-labeled-btn"
              href="https://academy.snabchat.app/"
              target="_blank"
              rel="noopener noreferrer"
              title="Обучение"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              <span className="btn-label">Обучение</span>
            </a>
            <button
              className="header-labeled-btn accent"
              onClick={() => navigateToInfographic()}
              title="Генератор инфографики"
            >
              <InfographicIcon />
              <span className="btn-label">Инфографика</span>
            </button>
            <button
              className="header-labeled-btn"
              onClick={() => {
                setActiveConvId(null);
                convIdRef.current = null;
                setChatKey(`new-${Date.now()}`);
                setMessages([]);
                setHasSummary(false);
              }}
              title="Новый чат"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              <span className="btn-label">Новый чат</span>
            </button>
            <button className="menu-btn" onClick={() => setRightOpen((o) => !o)}>
              <HistoryIcon />
            </button>
            <button
              className="header-action-btn"
              onClick={handleLogout}
              title="Выйти"
              style={{ color: "var(--text-muted)" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </header>

        {/* ── Body ── */}
        <div className="app-body">
          {/* ── Left sidebar: Sources ── */}
          <aside className={`sidebar-panel left ${leftOpen ? "open" : ""} ${leftCollapsed ? "collapsed" : ""}`}>
            <button
              className="sidebar-collapse-btn"
              onClick={() => setLeftCollapsed((c) => !c)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points={leftCollapsed ? "9 18 15 12 9 6" : "15 18 9 12 15 6"} />
              </svg>
              {leftCollapsed ? "Источники" : "Свернуть"}
            </button>
            <div className="sidebar-content">
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>
                    ИСТОЧНИКИ{" "}
                    <span
                      style={{
                        fontSize: 10,
                        background: "var(--border)",
                        borderRadius: "var(--radius-pill)",
                        padding: "1px 7px",
                        marginLeft: 4,
                      }}
                    >
                      {sources.length}
                    </span>
                  </span>
                </div>
                <div style={{ padding: "0 8px 8px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>
                    Управление документами доступно в админ-панели
                  </div>
                </div>
                <div className="sidebar-list">
                  {sources.map((doc) => {
                    const isExpanded = expandedSourceId === doc.id;
                    return (
                      <div key={doc.id} style={{ marginBottom: 2 }}>
                        <div
                          className="doc-item"
                          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                          onClick={() => {
                            setExpandedSourceId(isExpanded ? null : doc.id);
                          }}
                        >
                          <div className={`doc-icon ${doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") || doc.filename?.endsWith(".xlsx") || doc.filename?.endsWith(".xls") ? "xlsx" : "docx"}`}>
                            {doc.mime_type?.includes("pdf") ? "P" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "X" : "W"}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              title={doc.folder_path ? `${doc.folder_path}/${doc.filename}` : doc.filename}
                              style={{
                                fontSize: 13,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {doc.filename}
                            </div>
                            {!isExpanded && doc.tags && doc.tags.length > 0 && (
                              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                                {doc.tags.length} {doc.tags.length === 1 ? "тег" : doc.tags.length < 5 ? "тега" : "тегов"}
                              </div>
                            )}
                          </div>
                          <svg
                            width="12" height="12" viewBox="0 0 24 24" fill="none"
                            stroke="var(--text-muted)" strokeWidth="2"
                            style={{ flexShrink: 0, transition: "transform 150ms", transform: isExpanded ? "rotate(180deg)" : "rotate(0)" }}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                          <button
                            className="doc-action-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setViewingSource(doc);
                            }}
                            title="Просмотреть"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          </button>
                          <button
                            className="doc-action-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(`/api/sources/download?id=${doc.id}&action=download`, "_blank");
                            }}
                            title="Скачать"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                          </button>
                        </div>
                        {isExpanded && (
                          <div
                            style={{
                              padding: "6px 12px 10px",
                              background: "var(--bg-white)",
                              borderRadius: "0 0 var(--radius-sm) var(--radius-sm)",
                              border: "1px solid var(--border)",
                              borderTop: "none",
                              marginTop: -2,
                            }}
                          >
                            {doc.tags && doc.tags.length > 0 && (
                              <>
                                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Теги</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                                  {doc.tags.map((tag) => (
                                    <span key={tag} className="tag" style={{ fontSize: 11 }}>
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              </>
                            )}
                            <div style={{ display: "flex", gap: 6 }}>
                              <button
                                className="btn-secondary"
                                style={{ flex: 1, fontSize: 12, padding: "5px 10px", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                                onClick={(e) => { e.stopPropagation(); setViewingSource(doc); }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                                Просмотреть
                              </button>
                              <button
                                className="btn-secondary"
                                style={{ flex: 1, fontSize: 12, padding: "5px 10px", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
                                onClick={(e) => { e.stopPropagation(); window.open(`/api/sources/download?id=${doc.id}&action=download`, "_blank"); }}
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="7 10 12 15 17 10" />
                                  <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                                Скачать
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {sources.length === 0 && (
                    <p
                      style={{
                        color: "var(--text-muted)",
                        fontSize: 12,
                        textAlign: "center",
                        padding: 20,
                      }}
                    >
                      Документы ещё не загружены
                    </p>
                  )}
                </div>
              </div>
            </div>
          </aside>

          {/* Sidebar overlay (mobile) */}
          {(leftOpen || rightOpen) && (
            <div className="sidebar-overlay" onClick={() => { setLeftOpen(false); setRightOpen(false); }} />
          )}

          {/* ── Main ── */}
          <main className="main-area">
            <div className="chat-column">
              <div className="messages-area" ref={scrollRef}>
                {hasSummary && (
                  <div className="summary-notice">ℹ Ранние сообщения сжаты в резюме</div>
                )}
                {messages.length === 0 && !hasSummary && <EmptyState />}
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
                      onExportDocx={m.role === "assistant" ? (content: string) => handleExportDocx(content, prevUserMsg?.content || "Запрос") : undefined}
                    />
                  );
                })}
                {isSending && <TypingBubble />}
                {chatError && (
                  <div className="message message-error" style={{ background: "var(--error-bg, #fef2f2)", border: "1px solid var(--error-border, #fecaca)", borderRadius: 12, padding: "12px 18px", margin: "8px 0", color: "var(--error-text, #991b1b)", fontSize: 14 }}>
                    {chatError}
                    <button onClick={() => setChatError(null)} style={{ marginLeft: 12, background: "none", border: "none", cursor: "pointer", color: "inherit", fontWeight: 600 }}>×</button>
                  </div>
                )}
              </div>

              <form className="input-area" onSubmit={handleSubmit}>
                {/* Photo previews */}
                {chatPhotos.length > 0 && (
                  <div className="photo-preview-bar">
                    <div className="photo-preview-header">
                      <span className="photo-preview-count">Фото: {chatPhotos.length}/{MAX_CHAT_PHOTOS}</span>
                      {chatPhotos.some((p) => p.parsing) && <span className="photo-preview-processing">Распознавание...</span>}
                    </div>
                    <div className="photo-preview-grid">
                      {chatPhotos.map((p) => (
                        <div key={p.id} className="photo-preview-item">
                          <img src={p.preview} alt="Фото" className="photo-preview-img" />
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
                          <button type="button" className="photo-preview-remove" onClick={() => removeChatPhoto(p.id)} title="Удалить">
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
                        <span className="chip-size">{(f.file.size / 1024 / 1024).toFixed(1)} МБ</span>
                        <button type="button" className="chip-remove" onClick={() => removeChatFile(f.id)} title="Удалить">
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
                    title="Прикрепить файл или фото"
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
                    placeholder={chatFiles.length > 0 || chatPhotos.length > 0 ? "Опишите что проверить или нажмите отправить..." : "Задайте вопрос..."}
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

          {/* ── Right sidebar: Dialogs ── */}
          <aside className={`sidebar-panel right ${rightOpen ? "open" : ""} ${rightCollapsed ? "collapsed" : ""}`}>
            <button
              className="sidebar-collapse-btn"
              onClick={() => setRightCollapsed((c) => !c)}
            >
              {rightCollapsed ? "Диалоги" : "Свернуть"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points={rightCollapsed ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
              </svg>
            </button>
            <div className="sidebar-content">
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>ДИАЛОГИ</span>
                  <button
                    onClick={() => {
                      setActiveConvId(null);
                      convIdRef.current = null;
                      setChatKey(`new-${Date.now()}`);
                      setMessages([]);
                      setHasSummary(false);
                    }}
                    title="Новый диалог"
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
                        Выбрать
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
                          {selectedConvIds.size === conversations.length ? "Снять всё" : "Выбрать все"}
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
                          Удалить ({selectedConvIds.size})
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                          onClick={() => { setSelectedConvIds(new Set()); setConvBulkMode(false); }}
                        >
                          ✕
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
                          title="Удалить диалог"
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

        {/* ── Footer ── */}
        <footer className="app-footer">
          <span className="footer-full">СнабЧат · Дирекция по ресурсному обеспечению · 2026 · </span>
          Разработка @Кирилл Трубицын
        </footer>
      </div>

      {viewingSource && (
        <DocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
        />
      )}
    </>
  );
}
