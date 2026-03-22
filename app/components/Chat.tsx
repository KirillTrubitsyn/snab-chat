"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useChat } from "ai/react";
import ReactMarkdown from "react-markdown";

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
  created_at: string;
}

interface ParsedFile {
  filename: string;
  mimeType: string;
  markdown: string;
  tags: string[];
  chunks: { index: number; preview: string; length: number }[];
  totalChunks: number;
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

function CubeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
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

function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
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

/* ── Sub-components ── */

function MessageBubble({ message }: { message: { id: string; role: string; content: string; sources?: string[] } }) {
  const isUser = message.role === "user";
  return (
    <div className={`message ${isUser ? "message-user" : "message-ai"}`}>
      <div className="message-content">
        {isUser ? message.content : <ReactMarkdown>{message.content}</ReactMarkdown>}
      </div>
      {!isUser && message.sources && message.sources.length > 0 && (
        <div className="message-sources">
          <div className="message-sources-label">Источники:</div>
          <div className="message-sources-list">
            {message.sources.map((s, i) => (
              <span key={i} className="message-source-tag">{s}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <SearchIcon />
      <div className="empty-title">Задайте вопрос по документам</div>
      <div className="empty-sub">
        Загрузите DOCX или PDF в базу знаний, а затем задайте вопрос — ИИ найдёт ответ в ваших документах.
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

/* ── Upload Modal (bulk) ── */

interface FileEntry {
  file: File;
  status: "pending" | "parsing" | "parsed" | "ingesting" | "done" | "error";
  parsed?: ParsedFile;
  tags: string[];
  error?: string;
}

function fileTypeClass(entry: FileEntry) {
  const name = entry.file.name.toLowerCase();
  const mime = entry.file.type;
  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (mime.includes("sheet") || mime.includes("excel") || name.endsWith(".xlsx") || name.endsWith(".xls")) return "xlsx";
  return "docx";
}

function fileTypeLabel(entry: FileEntry) {
  const cls = fileTypeClass(entry);
  return cls === "pdf" ? "PDF" : cls === "xlsx" ? "XLS" : "DOC";
}

function UploadModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [stage, setStage] = useState<
    "idle" | "parsing" | "review" | "ingesting" | "done" | "error"
  >("idle");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [newTag, setNewTag] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [globalError, setGlobalError] = useState("");

  const updateEntry = useCallback((idx: number, patch: Partial<FileEntry>) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }, []);

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const newEntries: FileEntry[] = Array.from(files).map((file) => ({
      file,
      status: "pending" as const,
      tags: [],
    }));

    setEntries(newEntries);
    setStage("parsing");
    setGlobalError("");

    // Parse files sequentially to avoid overloading server
    const results = [...newEntries];
    for (let i = 0; i < results.length; i++) {
      results[i] = { ...results[i], status: "parsing" };
      setEntries([...results]);

      const formData = new FormData();
      formData.append("file", results[i].file);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        const res = await fetch("/api/parse", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
        const data: ParsedFile = await res.json();
        results[i] = { ...results[i], status: "parsed", parsed: data, tags: data.tags };
      } catch (err) {
        results[i] = {
          ...results[i],
          status: "error",
          error: err instanceof Error
            ? (err.name === "AbortError" ? "Таймаут: сервер не ответил за 2 мин" : err.message)
            : "Ошибка обработки",
        };
      }
      setEntries([...results]);
    }

    const hasAnyParsed = results.some((e) => e.status === "parsed");
    if (hasAnyParsed) {
      setStage("review");
    } else {
      setGlobalError("Не удалось обработать ни один файл");
      setStage("error");
    }
  }, []);

  const handleConfirmAll = useCallback(async () => {
    setStage("ingesting");
    setGlobalError("");

    const updated = [...entries];
    let successCount = 0;

    for (let i = 0; i < updated.length; i++) {
      if (updated[i].status !== "parsed" || !updated[i].parsed) continue;

      updated[i] = { ...updated[i], status: "ingesting" };
      setEntries([...updated]);

      try {
        const p = updated[i].parsed!;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 300000);
        const res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: p.filename,
            mimeType: p.mimeType,
            markdown: p.markdown,
            tags: updated[i].tags,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
        updated[i] = { ...updated[i], status: "done" };
        successCount++;
      } catch (err) {
        updated[i] = {
          ...updated[i],
          status: "error",
          error: err instanceof Error
            ? (err.name === "AbortError" ? "Таймаут: загрузка заняла больше 5 мин" : err.message)
            : "Ошибка загрузки",
        };
      }
      setEntries([...updated]);
    }

    setStage(successCount > 0 ? "done" : "error");
    if (successCount === 0) setGlobalError("Не удалось загрузить ни один файл");
  }, [entries]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const retry = () => {
    setGlobalError("");
    setStage("idle");
    setEntries([]);
    setNewTag("");
    setExpandedIdx(null);
  };

  const addMoreRef = useRef<HTMLInputElement>(null);

  const handleAddMoreChange = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const startIdx = entries.length;
    const newOnes: FileEntry[] = Array.from(files).map((file) => ({
      file,
      status: "pending" as const,
      tags: [],
    }));
    const all = [...entries, ...newOnes];
    setEntries(all);

    for (let i = startIdx; i < all.length; i++) {
      all[i] = { ...all[i], status: "parsing" };
      setEntries([...all]);

      const formData = new FormData();
      formData.append("file", all[i].file);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        const res = await fetch("/api/parse", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
        const data: ParsedFile = await res.json();
        all[i] = { ...all[i], status: "parsed", parsed: data, tags: data.tags };
      } catch (err) {
        all[i] = {
          ...all[i],
          status: "error",
          error: err instanceof Error
            ? (err.name === "AbortError" ? "Таймаут: сервер не ответил за 2 мин" : err.message)
            : "Ошибка обработки",
        };
      }
      setEntries([...all]);
    }
  }, [entries]);

  const addMoreFiles = () => {
    addMoreRef.current?.click();
  };

  const removeEntry = (idx: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
    else if (expandedIdx !== null && expandedIdx > idx) setExpandedIdx(expandedIdx - 1);
  };

  const parsedCount = entries.filter((e) => e.status === "parsed").length;
  const doneCount = entries.filter((e) => e.status === "done").length;
  const errorCount = entries.filter((e) => e.status === "error").length;
  const parsingCount = entries.filter((e) => e.status === "parsing").length;
  const ingestingCount = entries.filter((e) => e.status === "ingesting").length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header" style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 20,
        }}>
          <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 18, margin: 0 }}>
            Загрузка документов
          </h3>
          <button
            className="close-btn"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              color: "var(--text-muted)",
              transition: "background var(--transition)",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-code)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            ✕
          </button>
        </div>

        {/* Hidden file inputs */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.xls"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { handleFileSelect(e.target.files); e.target.value = ""; }}
        />
        <input
          ref={addMoreRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.xls"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { handleAddMoreChange(e.target.files); e.target.value = ""; }}
        />

        {/* ── idle ── */}
        {stage === "idle" && (
          <div
            className={`drop-zone ${dragActive ? "active" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => { e.preventDefault(); setDragActive(false); handleFileSelect(e.dataTransfer.files); }}
            onClick={openFilePicker}
          >
            <UploadIcon />
            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 4 }}>
              Перетащите файлы или нажмите для выбора
            </p>
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>DOCX, PDF, Excel · можно выбрать несколько</p>
          </div>
        )}

        {/* ── parsing ── */}
        {stage === "parsing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div className="spinner" style={{ width: 18, height: 18 }} />
              <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                Обработка файлов… ({entries.filter((e) => e.status === "parsed" || e.status === "error").length}/{entries.length})
              </span>
            </div>
            {entries.map((entry, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: "var(--bg-main)",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
              }}>
                <div
                  className={`doc-icon ${fileTypeClass(entry)}`}
                  style={{ width: 28, height: 28, borderRadius: 5, fontSize: 11, fontWeight: 600, flexShrink: 0 }}
                >
                  {fileTypeLabel(entry)}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {entry.file.name}
                </div>
                {entry.status === "parsing" && <div className="spinner" style={{ width: 16, height: 16 }} />}
                {entry.status === "parsed" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                )}
                {entry.status === "error" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                )}
                {entry.status === "pending" && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ожидание</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── review ── */}
        {stage === "review" && (
          <div className="review-panel">
            {/* File list */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
              {entries.map((entry, i) => (
                <div key={i}>
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    background: entry.status === "error" ? "rgba(220,38,38,0.05)" : "var(--bg-main)",
                    borderRadius: "var(--radius-sm)",
                    border: `1px solid ${entry.status === "error" ? "var(--error)" : "var(--border)"}`,
                    cursor: entry.status === "parsed" ? "pointer" : "default",
                  }}
                    onClick={() => entry.status === "parsed" && setExpandedIdx(expandedIdx === i ? null : i)}
                  >
                    <div
                      className={`doc-icon ${fileTypeClass(entry)}`}
                      style={{ width: 28, height: 28, borderRadius: 5, fontSize: 11, fontWeight: 600, flexShrink: 0 }}
                    >
                      {fileTypeLabel(entry)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {entry.file.name}
                      </div>
                      {entry.parsed && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {entry.parsed.totalChunks} чанков · {entry.tags.length} тегов
                        </div>
                      )}
                      {entry.status === "error" && (
                        <div style={{ fontSize: 11, color: "var(--error)" }}>{entry.error}</div>
                      )}
                    </div>
                    {entry.status === "parsed" && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"
                        style={{ transform: expandedIdx === i ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s", flexShrink: 0 }}>
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeEntry(i); }}
                      style={{ fontSize: 14, color: "var(--text-muted)", padding: "2px 4px", flexShrink: 0 }}
                      title="Убрать"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Expanded details */}
                  {expandedIdx === i && entry.parsed && (
                    <div style={{ padding: "8px 12px", borderLeft: "2px solid var(--border)", marginLeft: 20, marginTop: 4 }}>
                      {/* Chunks preview */}
                      <div className="chunks-preview" style={{ maxHeight: 120, overflowY: "auto", marginBottom: 8 }}>
                        {entry.parsed.chunks.map((c) => (
                          <div key={c.index} className="chunk-card">{c.preview}</div>
                        ))}
                      </div>
                      {/* Tags */}
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Теги</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                        {entry.tags.map((tag) => (
                          <span key={tag} className="tag" style={{ fontSize: 11 }}>
                            {tag}
                            <button onClick={() => updateEntry(i, { tags: entry.tags.filter((x) => x !== tag) })}>×</button>
                          </span>
                        ))}
                        <form
                          style={{ display: "inline-flex", gap: 4 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            const t = newTag.trim();
                            if (t && !entry.tags.includes(t)) {
                              updateEntry(i, { tags: [...entry.tags, t] });
                              setNewTag("");
                            }
                          }}
                        >
                          <input
                            value={newTag}
                            onChange={(e) => setNewTag(e.target.value)}
                            placeholder="новый тег"
                            style={{
                              width: 80,
                              fontSize: 11,
                              padding: "3px 6px",
                              borderRadius: "var(--radius-sm)",
                              border: "1px solid var(--border)",
                              background: "var(--bg-code)",
                              color: "var(--text-primary)",
                            }}
                          />
                          <button type="submit" className="btn-secondary" style={{ padding: "3px 8px", fontSize: 13, lineHeight: 1 }}>+</button>
                        </form>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Add more + actions */}
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <button className="btn-secondary" onClick={addMoreFiles} style={{ fontSize: 13 }}>
                + Добавить ещё
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-secondary" onClick={onClose}>Отмена</button>
                <button className="btn-primary" onClick={handleConfirmAll} disabled={parsedCount === 0}>
                  Загрузить {parsedCount > 1 ? `${parsedCount} файлов` : "в базу"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── ingesting ── */}
        {stage === "ingesting" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div className="spinner" style={{ width: 18, height: 18 }} />
              <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                Загрузка в базу… ({doneCount}/{parsedCount})
              </span>
            </div>
            {entries.filter((e) => e.parsed).map((entry, i) => (
              <div key={i} style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                background: "var(--bg-main)",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
              }}>
                <div
                  className={`doc-icon ${fileTypeClass(entry)}`}
                  style={{ width: 28, height: 28, borderRadius: 5, fontSize: 11, fontWeight: 600, flexShrink: 0 }}
                >
                  {fileTypeLabel(entry)}
                </div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {entry.file.name}
                </div>
                {entry.status === "ingesting" && <div className="spinner" style={{ width: 16, height: 16 }} />}
                {entry.status === "done" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                )}
                {entry.status === "error" && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                )}
                {entry.status === "parsed" && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ожидание</span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── done ── */}
        {stage === "done" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "rgba(5, 150, 105, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
              {doneCount === entries.length ? "Все документы загружены" : `Загружено ${doneCount} из ${entries.length}`}
            </p>
            {errorCount > 0 && (
              <p style={{ fontSize: 13, color: "var(--error)", marginBottom: 4 }}>
                {errorCount} {errorCount === 1 ? "файл" : "файлов"} с ошибкой
              </p>
            )}
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              {doneCount} {doneCount === 1 ? "документ" : "документов"} · {entries.filter((e) => e.status === "done").reduce((s, e) => s + (e.parsed?.totalChunks ?? 0), 0)} чанков
            </p>
            <button className="btn-primary" onClick={onSuccess}>Готово</button>
          </div>
        )}

        {/* ── error ── */}
        {stage === "error" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "rgba(220, 38, 38, 0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <p style={{ fontSize: 14, color: "var(--error)", marginBottom: 4 }}>
              {globalError || "Произошла ошибка"}
            </p>
            <button className="btn-secondary" onClick={retry} style={{ marginTop: 12 }}>
              Попробовать снова
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   Main Chat component
   ═══════════════════════════════════════════════ */

export default function Chat() {
  /* ── State ── */
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [hasSummary, setHasSummary] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [sourceTagInput, setSourceTagInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  /* ── Refs ── */
  const convIdRef = useRef<string | null>(null);
  const pendingSubmitRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* ── useChat ── */
  const {
    messages,
    input,
    handleInputChange,
    setMessages,
    isLoading,
    setInput,
  } = useChat({
    id: activeConvId ?? undefined,
    api: "/api/chat",
    body: { conversationId: convIdRef.current },
  });

  /* ── Load conversations ── */
  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      if (Array.isArray(data)) setConversations(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  /* ── Delete source ── */
  const deleteSource = useCallback(
    async (sourceId: number, e?: React.MouseEvent) => {
      e?.stopPropagation();
      try {
        await fetch(`/api/sources?id=${sourceId}`, { method: "DELETE" });
        setSources((prev) => prev.filter((s) => s.id !== sourceId));
      } catch {
        // ignore
      }
    },
    []
  );

  /* ── Update source tags ── */
  const updateSourceTags = useCallback(
    async (sourceId: number, tags: string[]) => {
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, tags } : s))
      );
      try {
        await fetch(`/api/sources?id=${sourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags }),
        });
      } catch {
        // ignore
      }
    },
    []
  );

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
        const res = await fetch(`/api/conversations/messages?id=${convId}`);
        const data = await res.json();
        setHasSummary(data.conversation?.hasSummary ?? false);
        if (data.messages) {
          setMessages(
            data.messages.map(
              (m: { id: string; role: string; content: string }) => ({
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || "Новый диалог" }),
      });
      const conv = await res.json();
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
      await fetch(`/api/conversations?id=${convId}`, { method: "DELETE" });
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

  /* ── Submit handler with pending logic ── */
  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
      if (!text || isLoading || isSending) return;

      setIsSending(true);

      if (!convIdRef.current) {
        pendingSubmitRef.current = text;
        setInput("");
        const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
        const newId = await createConversation(title);

        setMessages((prev) => [
          ...prev,
          { id: `temp-user-${Date.now()}`, role: "user", content: text },
        ]);

        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: text }],
              conversationId: newId,
            }),
          });

          if (!res.ok || !res.body) throw new Error("Stream failed");

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
        { id: `temp-user-${Date.now()}`, role: "user" as const, content: text },
      ];
      setMessages(currentMessages);
      setInput("");

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: currentMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            conversationId: convIdRef.current,
          }),
        });

        if (!res.ok || !res.body) throw new Error("Stream failed");

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
    [input, isLoading, isSending, messages, setInput, setMessages, createConversation, loadConversations]
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
  return (
    <>
      <div className="app-layout">
        {/* ── Header ── */}
        <header className="app-header">
          <div className="header-brand">
            <button className="menu-btn" onClick={() => setLeftOpen((o) => !o)}>
              <MenuIcon />
            </button>
            <CubeIcon />
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 17 }}>
              СнабЧат
            </span>
            <div className="header-divider" />
            <span style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--text-secondary)" }}>
              Дирекция по закупкам
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {hasSummary && <span className="memory-pill">Память активна</span>}
            <button
              className="header-action-btn"
              onClick={() => {
                setActiveConvId(null);
                convIdRef.current = null;
                setMessages([]);
                setHasSummary(false);
              }}
              title="Новый чат"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
            <button className="menu-btn" onClick={() => setRightOpen((o) => !o)}>
              <HistoryIcon />
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
                  <button className="upload-btn" onClick={() => setShowUploadModal(true)}>
                    <UploadIcon /> Загрузить DOCX / PDF / Excel
                  </button>
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
                            setSourceTagInput("");
                          }}
                        >
                          <div className={`doc-icon ${doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") || doc.filename?.endsWith(".xlsx") || doc.filename?.endsWith(".xls") ? "xlsx" : "docx"}`}>
                            {doc.mime_type?.includes("pdf") ? "P" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "X" : "W"}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              title={doc.filename}
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
                            className="doc-delete-btn"
                            onClick={(e) => deleteSource(doc.id, e)}
                            title="Удалить документ"
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
                            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Теги</div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                              {(doc.tags || []).map((tag) => (
                                <span key={tag} className="tag" style={{ fontSize: 11 }}>
                                  {tag}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      updateSourceTags(doc.id, doc.tags.filter((t) => t !== tag));
                                    }}
                                    style={{ marginLeft: 3, fontSize: 12, color: "var(--text-muted)", lineHeight: 1 }}
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                              <form
                                style={{ display: "inline-flex", gap: 4 }}
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const t = sourceTagInput.trim();
                                  if (t && !(doc.tags || []).includes(t)) {
                                    updateSourceTags(doc.id, [...(doc.tags || []), t]);
                                    setSourceTagInput("");
                                  }
                                }}
                              >
                                <input
                                  value={sourceTagInput}
                                  onChange={(e) => setSourceTagInput(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="новый тег"
                                  style={{
                                    width: 80,
                                    fontSize: 11,
                                    padding: "3px 6px",
                                    borderRadius: "var(--radius-sm)",
                                    border: "1px solid var(--border)",
                                    background: "var(--bg-code)",
                                    color: "var(--text-primary)",
                                  }}
                                />
                                <button
                                  type="submit"
                                  className="btn-secondary"
                                  style={{ padding: "3px 8px", fontSize: 13, lineHeight: 1 }}
                                >
                                  +
                                </button>
                              </form>
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
                      Загрузите первый документ
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
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                {isSending && <TypingBubble />}
              </div>

              <form className="input-area" onSubmit={handleSubmit}>
                <div className="input-wrapper">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    placeholder="Задайте вопрос..."
                    rows={1}
                    className="chat-input"
                    style={{ maxHeight: 160 }}
                    onInput={(e) => {
                      const t = e.currentTarget;
                      t.style.height = "auto";
                      t.style.height = Math.min(t.scrollHeight, 160) + "px";
                    }}
                  />
                  <button
                    type="submit"
                    disabled={isLoading || isSending || !input.trim()}
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
                      setMessages([]);
                      setHasSummary(false);
                    }}
                    title="Новый диалог"
                    style={{ fontSize: 16, color: "var(--text-secondary)", lineHeight: 1 }}
                  >
                    +
                  </button>
                </div>
                <div className="sidebar-list">
                  {conversations.map((c) => (
                    <div
                      className={`sidebar-item ${c.id === activeConvId ? "active" : ""}`}
                      onClick={() => switchConversation(c.id)}
                      key={c.id}
                    >
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
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>

        {/* ── Footer ── */}
        <footer className="app-footer">
          <span className="footer-full">СнабЧат · Дирекция по закупкам · 2026 · </span>
          Разработка @Кирилл Трубицын
        </footer>
      </div>

      {/* ── Upload Modal ── */}
      {showUploadModal && (
        <UploadModal
          onClose={() => setShowUploadModal(false)}
          onSuccess={() => {
            loadSources();
            setShowUploadModal(false);
          }}
        />
      )}
    </>
  );
}
