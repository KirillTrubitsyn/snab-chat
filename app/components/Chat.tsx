"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
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

function DocumentViewer({
  source,
  onClose,
}: {
  source: Source;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const isPdf = source.mime_type?.includes("pdf");
  const hasOriginal = !!source.storage_path;

  useEffect(() => {
    if (isPdf && hasOriginal) {
      setLoading(false);
      return;
    }
    fetch(`/api/sources/content?id=${source.id}`)
      .then((r) => r.json())
      .then((d) => setContent(cleanMarkdown(d.markdown || "")))
      .catch(() => setContent("Не удалось загрузить содержимое"))
      .finally(() => setLoading(false));
  }, [source.id, isPdf, hasOriginal]);

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
}: {
  message: { id: string; role: string; content: string; sources?: string[] };
  allSources: Source[];
  onViewSource: (source: Source) => void;
}) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="message message-user">
        <div className="message-content">{message.content}</div>
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
      const codes = src.filename.match(/[А-ЯA-Zа-яa-z]{1,4}[-][А-ЯA-Zа-яa-z/]{1,10}[-][А-ЯA-Zа-яa-z0-9/]{1,6}[-]\d{1,3}/gi);
      if (codes) {
        for (const code of codes) {
          codePatterns.push({ code, sourceId: src.id });
        }
      }
    }

    if (codePatterns.length === 0) return text;

    // Sort by length descending so longer codes match first
    codePatterns.sort((a, b) => b.code.length - a.code.length);

    let result = text;
    for (const { code, sourceId } of codePatterns) {
      // Escape special regex chars in code
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Only match if not already inside a markdown link
      const regex = new RegExp(`(?<!\\[[^\\]]*)(${escaped})(?![^\\[]*\\])`, "gi");
      result = result.replace(regex, `[$1](source:${sourceId})`);
    }

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

/* ═══════════════════════════════════════════════
   Main Chat component
   ═══════════════════════════════════════════════ */

export default function Chat() {
  /* ── Auth State ── */
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inviteCode, setInviteCode] = useState<string>("");
  const [userName, setUserName] = useState<string>("");
  const [authLoading, setAuthLoading] = useState(true);

  /* ── Check existing auth on mount ── */
  useEffect(() => {
    const code = localStorage.getItem("snabchat_invite_code");
    const name = localStorage.getItem("snabchat_user_name");
    if (code && name) {
      setInviteCode(code);
      setUserName(name);
      setIsAuthenticated(true);
    }
    setAuthLoading(false);
  }, []);

  const handleAuthSuccess = useCallback((data: { type: string; code: string; userName: string }) => {
    setInviteCode(data.code);
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
  const [hasSummary, setHasSummary] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [viewingSource, setViewingSource] = useState<Source | null>(null);

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
    if (!inviteCode) return;
    try {
      const res = await fetch("/api/conversations", {
        headers: { "x-invite-code": inviteCode },
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
          headers: { "x-invite-code": inviteCode },
        });
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
        headers: { "Content-Type": "application/json", "x-invite-code": inviteCode },
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
      await fetch(`/api/conversations?id=${convId}`, {
        method: "DELETE",
        headers: { "x-invite-code": inviteCode },
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
            headers: { "Content-Type": "application/json", "x-invite-code": inviteCode },
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
          headers: { "Content-Type": "application/json", "x-invite-code": inviteCode },
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
            <CubeIcon />
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 17 }}>
              СнабЧат
            </span>
            <div className="header-divider" />
            <span style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--text-secondary)" }}>
              {userName}
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
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} allSources={sources} onViewSource={setViewingSource} />
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

      {viewingSource && (
        <DocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
        />
      )}
    </>
  );
}
