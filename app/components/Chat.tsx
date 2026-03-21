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

function SearchIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/* ── Sub-components ── */

function MessageBubble({ message }: { message: { id: string; role: string; content: string } }) {
  const isUser = message.role === "user";
  return (
    <div className={`message ${isUser ? "message-user" : "message-ai"}`}>
      <div className="message-content">
        {isUser ? message.content : <ReactMarkdown>{message.content}</ReactMarkdown>}
      </div>
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

/* ── Upload Modal ── */

function UploadModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [stage, setStage] = useState<
    "idle" | "uploading" | "review" | "ingesting" | "done" | "error"
  >("idle");
  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const handleFileSelect = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];

    setStage("uploading");
    setErrorMsg("");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/parse", { method: "POST", body: formData });
      if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
      const data: ParsedFile = await res.json();
      setParsedFile(data);
      setEditTags(data.tags);
      setStage("review");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Не удалось обработать файл");
      setStage("error");
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!parsedFile) return;
    setStage("ingesting");
    setErrorMsg("");

    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: parsedFile.filename,
          mimeType: parsedFile.mimeType,
          markdown: parsedFile.markdown,
          tags: editTags,
        }),
      });
      if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
      setStage("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Не удалось загрузить в базу");
      setStage("error");
    }
  }, [parsedFile, editTags]);

  const openFilePicker = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".pdf,.docx";
    inp.onchange = () => handleFileSelect(inp.files);
    inp.click();
  };

  const retry = () => {
    setErrorMsg("");
    setStage("idle");
    setParsedFile(null);
    setEditTags([]);
    setNewTag("");
  };

  const isPdf = parsedFile?.mimeType?.includes("pdf");

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
            Загрузка документа
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
              Перетащите файл или нажмите для выбора
            </p>
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>DOCX, PDF</p>
          </div>
        )}

        {/* ── uploading ── */}
        {stage === "uploading" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "40px 0" }}>
            <div className="spinner" />
            <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Обработка документа…</span>
          </div>
        )}

        {/* ── review ── */}
        {stage === "review" && parsedFile && (
          <div className="review-panel">
            {/* File info badge */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "var(--bg-main)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}>
              <div
                className={`doc-icon ${isPdf ? "pdf" : "docx"}`}
                style={{ width: 32, height: 32, borderRadius: 6, fontSize: 13, fontWeight: 600 }}
              >
                {isPdf ? "PDF" : "DOC"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 14,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}>
                  {parsedFile.filename}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {parsedFile.totalChunks} чанков · {parsedFile.chunks.reduce((s, c) => s + c.length, 0).toLocaleString()} символов
                </div>
              </div>
            </div>

            {/* Chunks preview */}
            <div className="chunks-preview" style={{ maxHeight: 200, overflowY: "auto" }}>
              {parsedFile.chunks.map((c) => (
                <div key={c.index} className="chunk-card">{c.preview}</div>
              ))}
            </div>

            {/* Tags */}
            <div className="tags-section">
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>Теги</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                {editTags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                    <button onClick={() => setEditTags((t) => t.filter((x) => x !== tag))}>×</button>
                  </span>
                ))}
                <form
                  style={{ display: "inline-flex", gap: 4 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = newTag.trim();
                    if (t && !editTags.includes(t)) {
                      setEditTags((prev) => [...prev, t]);
                      setNewTag("");
                    }
                  }}
                >
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    placeholder="новый тег"
                    style={{
                      width: 90,
                      fontSize: 12,
                      padding: "4px 8px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border)",
                      background: "var(--bg-code)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <button
                    type="submit"
                    className="btn-secondary"
                    style={{ padding: "4px 10px", fontSize: 14, lineHeight: 1 }}
                  >
                    +
                  </button>
                </form>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <button className="btn-secondary" onClick={onClose}>Отмена</button>
              <button className="btn-primary" onClick={handleConfirm}>Загрузить в базу</button>
            </div>
          </div>
        )}

        {/* ── ingesting ── */}
        {stage === "ingesting" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "40px 0" }}>
            <div className="spinner" />
            <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Генерация эмбеддингов…</span>
          </div>
        )}

        {/* ── done ── */}
        {stage === "done" && parsedFile && (
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
              Документ загружен
            </p>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              {parsedFile.filename} · {parsedFile.totalChunks} чанков · {editTags.length} тегов
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
              {errorMsg || "Произошла ошибка"}
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);

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
      setSidebarOpen(false);

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
      if (!text || isLoading) return;

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

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let assistantText = "";
          const assistantId = `temp-assistant-${Date.now()}`;

          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", content: "" },
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

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = "";
        const assistantId = `temp-assistant-${Date.now()}`;

        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: "" },
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
      }
    },
    [input, isLoading, messages, setInput, setMessages, createConversation, loadConversations]
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
            <button className="menu-btn" onClick={() => setSidebarOpen((o) => !o)}>
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
          <div>
            {hasSummary && <span className="memory-pill">Память активна</span>}
          </div>
        </header>

        {/* ── Body ── */}
        <div className="app-body">
          {/* ── Sidebar ── */}
          <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
            {/* Documents section */}
            <div className="sidebar-section" style={{ flex: "0 0 auto", maxHeight: "40%" }}>
              <div className="sidebar-section-title">
                <span>
                  ДОКУМЕНТЫ{" "}
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
                  <UploadIcon /> Загрузить DOCX / PDF
                </button>
              </div>
              <div className="sidebar-list">
                {sources.map((doc) => (
                  <div className="doc-item" key={doc.id}>
                    <div className={`doc-icon ${doc.mime_type?.includes("pdf") ? "pdf" : "docx"}`}>
                      {doc.mime_type?.includes("pdf") ? "P" : "W"}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {doc.filename}
                      </div>
                      {doc.tags && doc.tags.length > 0 && (
                        <div className="doc-tags">
                          {doc.tags.slice(0, 3).map((t) => (
                            <span key={t}>{t}</span>
                          ))}
                          {doc.tags.length > 3 && <span>+{doc.tags.length - 3}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
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

            <hr
              style={{
                border: "none",
                borderTop: "1px solid var(--border)",
                margin: "0 12px",
              }}
            />

            {/* Dialogs section */}
            <div className="sidebar-section" style={{ flex: 1 }}>
              <div className="sidebar-section-title">
                <span>ДИАЛОГИ</span>
                <button
                  onClick={() => createConversation()}
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
                      onClick={(e) => deleteConversation(c.id, e)}
                      style={{
                        fontSize: 14,
                        color: "var(--text-muted)",
                        opacity: 0,
                        transition: "opacity var(--transition)",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0"; }}
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </aside>

          {/* Sidebar overlay (mobile) */}
          {sidebarOpen && (
            <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
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
                {isLoading && lastIsUser && <TypingBubble />}
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
                    disabled={isLoading || !input.trim()}
                    className="send-btn"
                  >
                    <ArrowUpIcon />
                  </button>
                </div>
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--text-muted)",
                    textAlign: "center",
                    marginTop: 6,
                  }}
                >
                  Enter — отправить · Shift+Enter — перенос
                </p>
              </form>
            </div>
          </main>
        </div>

        {/* ── Footer ── */}
        <footer className="app-footer">СнабЧат · Дирекция по закупкам · 2026</footer>
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
