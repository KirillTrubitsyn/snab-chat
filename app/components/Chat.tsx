"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useChat } from "ai/react";
import ReactMarkdown from "react-markdown";

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  hasSummary: boolean;
}

interface ParsedFile {
  filename: string;
  mimeType: string;
  markdown: string;
  tags: string[];
  chunks: { index: number; preview: string; length: number }[];
  totalChunks: number;
}

export default function Chat() {
  // --- Conversations ---
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hasSummary, setHasSummary] = useState(false);
  const convIdRef = useRef<string | null>(null);
  const pendingSubmitRef = useRef<string | null>(null);

  // --- Upload ---
  const [uploadState, setUploadState] = useState<
    "idle" | "parsing" | "preview" | "ingesting" | "done"
  >("idle");
  const [parsedFile, setParsedFile] = useState<ParsedFile | null>(null);
  const [editTags, setEditTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [uploadTab, setUploadTab] = useState(false);

  // --- Chat ---
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // --- Load conversations ---
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

  // --- Switch conversation ---
  const switchConversation = useCallback(
    async (convId: string) => {
      setActiveConvId(convId);
      convIdRef.current = convId;
      setSidebarOpen(false);

      try {
        const res = await fetch(
          `/api/conversations/messages?id=${convId}`
        );
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

  // --- Create conversation ---
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

  // --- Delete conversation ---
  const deleteConversation = useCallback(
    async (convId: string) => {
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

  // --- Submit handler with pending logic ---
  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const text = input.trim();
      if (!text || isLoading) return;

      if (!convIdRef.current) {
        // No active conversation — create one, then send manually
        pendingSubmitRef.current = text;
        setInput("");
        const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
        const newId = await createConversation(title);

        // Add user message optimistically
        setMessages((prev) => [
          ...prev,
          { id: `temp-user-${Date.now()}`, role: "user", content: text },
        ]);

        // Manual fetch with streaming
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

          // Add empty assistant message
          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", content: "" },
          ]);

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            // Parse AI SDK data stream format: 0:"text"\n
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
                m.id === assistantId
                  ? { ...m, content: assistantText }
                  : m
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

      // Normal submit via useChat — we call fetch manually to include conversationId
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
              m.id === assistantId
                ? { ...m, content: assistantText }
                : m
            )
          );
        }
      } catch (err) {
        console.error("Stream error:", err);
      }
    },
    [
      input,
      isLoading,
      messages,
      setInput,
      setMessages,
      createConversation,
      loadConversations,
    ]
  );

  // --- Auto-scroll ---
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- File upload ---
  const handleFileDrop = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];

      setUploadState("parsing");
      setUploadTab(true);

      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch("/api/parse", {
          method: "POST",
          body: formData,
        });
        const data: ParsedFile = await res.json();
        setParsedFile(data);
        setEditTags(data.tags);
        setUploadState("preview");
      } catch {
        setUploadState("idle");
      }
    },
    []
  );

  const handleIngest = useCallback(async () => {
    if (!parsedFile) return;
    setUploadState("ingesting");

    try {
      await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: parsedFile.filename,
          mimeType: parsedFile.mimeType,
          markdown: parsedFile.markdown,
          tags: editTags,
        }),
      });
      setUploadState("done");
    } catch {
      setUploadState("preview");
    }
  }, [parsedFile, editTags]);

  const resetUpload = () => {
    setUploadState("idle");
    setParsedFile(null);
    setEditTags([]);
    setNewTag("");
  };

  // --- Key handler ---
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg)" }}>
      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:relative z-50 h-full flex flex-col transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
        style={{
          width: "var(--sidebar-w)",
          minWidth: "var(--sidebar-w)",
          background: "var(--bg-secondary)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <div className="p-4 flex items-center justify-between" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="font-semibold text-sm" style={{ color: "var(--accent)" }}>
            СнабЧат
          </span>
          <button
            onClick={() => {
              setActiveConvId(null);
              convIdRef.current = null;
              setMessages([]);
              setHasSummary(false);
            }}
            className="text-xs px-3 py-1.5 rounded-md transition-colors"
            style={{
              background: "var(--bg-tertiary)",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
            }}
          >
            + Новый
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`sidebar-item group ${
                activeConvId === conv.id ? "active" : ""
              }`}
              onClick={() => switchConversation(conv.id)}
            >
              <span className="flex-1 truncate text-sm">{conv.title}</span>
              {conv.hasSummary && (
                <span className="summary-notice" style={{ padding: "2px 6px", fontSize: "10px" }}>
                  M
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteConversation(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                style={{ color: "var(--danger)" }}
              >
                &times;
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="text-center py-8 text-xs" style={{ color: "var(--text-muted)" }}>
              Нет диалогов
            </p>
          )}
        </div>

        {/* Upload toggle */}
        <div className="p-3" style={{ borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => setUploadTab(!uploadTab)}
            className="w-full text-left text-xs py-2 px-3 rounded-md transition-colors"
            style={{
              background: uploadTab ? "var(--bg-tertiary)" : "transparent",
              color: "var(--text-muted)",
            }}
          >
            Загрузка документов
          </button>
        </div>
      </aside>

      {/* Main area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top bar */}
        <header
          className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-secondary)" }}
        >
          <button
            className="md:hidden text-lg"
            onClick={() => setSidebarOpen(true)}
            style={{ color: "var(--text-muted)" }}
          >
            &#9776;
          </button>
          <h1 className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>
            {activeConvId
              ? conversations.find((c) => c.id === activeConvId)?.title ?? "Диалог"
              : "СнабЧат — Дирекция по закупкам"}
          </h1>
          {hasSummary && <span className="summary-notice">Память</span>}
        </header>

        {/* Upload panel */}
        {uploadTab && (
          <div
            className="animate-slideDown p-4"
            style={{
              background: "var(--bg-secondary)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {uploadState === "idle" && (
              <div
                className={`drop-zone ${dragActive ? "active" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  handleFileDrop(e.dataTransfer.files);
                }}
                onClick={() => {
                  const inp = document.createElement("input");
                  inp.type = "file";
                  inp.accept = ".pdf,.docx";
                  inp.onchange = () => handleFileDrop(inp.files);
                  inp.click();
                }}
              >
                <p className="text-sm">
                  Перетащите файл (PDF, DOCX) или нажмите для выбора
                </p>
              </div>
            )}

            {uploadState === "parsing" && (
              <div className="flex items-center gap-3 justify-center py-4">
                <div className="spinner" />
                <span className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Разбор документа...
                </span>
              </div>
            )}

            {uploadState === "preview" && parsedFile && (
              <div className="animate-fadeIn space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">{parsedFile.filename}</h3>
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {parsedFile.totalChunks} чанков
                  </span>
                </div>

                {/* Tags */}
                <div className="flex flex-wrap gap-1.5">
                  {editTags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                      <button onClick={() => setEditTags((t) => t.filter((x) => x !== tag))}>
                        &times;
                      </button>
                    </span>
                  ))}
                  <form
                    className="inline-flex"
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
                      placeholder="+ тег"
                      className="text-xs px-2 py-1 rounded-md outline-none"
                      style={{
                        background: "var(--bg-tertiary)",
                        color: "var(--text)",
                        border: "1px solid var(--border)",
                        width: 80,
                      }}
                    />
                  </form>
                </div>

                {/* Chunk previews */}
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {parsedFile.chunks.slice(0, 3).map((c) => (
                    <div key={c.index} className="chunk-card">
                      {c.preview}
                    </div>
                  ))}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleIngest}
                    className="text-xs px-4 py-2 rounded-md font-medium transition-colors"
                    style={{ background: "var(--accent)", color: "#fff" }}
                  >
                    Загрузить в базу
                  </button>
                  <button
                    onClick={resetUpload}
                    className="text-xs px-4 py-2 rounded-md transition-colors"
                    style={{
                      background: "var(--bg-tertiary)",
                      color: "var(--text-muted)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}

            {uploadState === "ingesting" && (
              <div className="flex items-center gap-3 justify-center py-4">
                <div className="spinner" />
                <span className="text-sm" style={{ color: "var(--text-muted)" }}>
                  Создание эмбеддингов и загрузка...
                </span>
              </div>
            )}

            {uploadState === "done" && (
              <div className="animate-fadeIn text-center py-4">
                <p className="text-sm" style={{ color: "var(--success)" }}>
                  Документ загружен в базу знаний
                </p>
                <button
                  onClick={resetUpload}
                  className="mt-2 text-xs px-4 py-2 rounded-md transition-colors"
                  style={{
                    background: "var(--bg-tertiary)",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Загрузить ещё
                </button>
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          {messages.length === 0 && !activeConvId && (
            <div className="flex flex-col items-center justify-center h-full animate-fadeIn">
              <h2
                className="text-2xl font-semibold mb-2"
                style={{ color: "var(--accent)" }}
              >
                СнабЧат
              </h2>
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                ИИ-ассистент Дирекции по закупкам. Задайте вопрос или загрузите документ.
              </p>
            </div>
          )}

          <div className="max-w-3xl mx-auto space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className="animate-slideDown"
                style={{
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  className="rounded-xl px-4 py-3 max-w-[85%] text-sm leading-relaxed"
                  style={{
                    background:
                      msg.role === "user"
                        ? "var(--accent)"
                        : "var(--bg-secondary)",
                    color: msg.role === "user" ? "#fff" : "var(--text)",
                    border:
                      msg.role === "assistant"
                        ? "1px solid var(--border)"
                        : "none",
                  }}
                >
                  {msg.role === "assistant" ? (
                    <div className="message-content">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  ) : (
                    msg.content
                  )}
                </div>
              </div>
            ))}

            {isLoading && messages[messages.length - 1]?.role === "user" && (
              <div className="flex gap-1.5 py-2 px-1">
                <div className="typing-dot" />
                <div className="typing-dot" />
                <div className="typing-dot" />
              </div>
            )}
          </div>

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          className="px-4 py-3"
          style={{ borderTop: "1px solid var(--border)", background: "var(--bg-secondary)" }}
        >
          <div
            className="max-w-3xl mx-auto flex gap-2 items-end"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Задайте вопрос..."
              rows={1}
              className="flex-1 resize-none text-sm rounded-lg px-4 py-3 outline-none"
              style={{
                background: "var(--bg-tertiary)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                maxHeight: 160,
                fontFamily: "var(--font-sans)",
              }}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 160) + "px";
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="rounded-lg px-4 py-3 text-sm font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--accent)",
                color: "#fff",
              }}
            >
              &rarr;
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
