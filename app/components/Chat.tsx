"use client";

import { useState, useEffect, useRef, useCallback, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "ai/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import InviteGate from "./InviteGate";
import { containsMarkdownTable } from "@/app/lib/markdown-tables";
import KBSearchBar from "@/app/components/KBSearchBar";
import { formatDateRelative } from "@/app/lib/date-utils";
import { sanitizeHtml } from "@/app/lib/sanitize";
import {
  VoiceButton,
  CameraButton,
  ExcelViewer,
  MessageBubble,
  EmptyState,
  ChatDocumentViewer,
  SpektrIcon,
  MenuIcon,
  ArrowUpIcon,
  HistoryIcon,
  SearchIcon,
  InfographicIcon,
} from "./chat";
import type { Conversation, Source, ChatFile, ChatPhoto, ExcelSheet } from "./chat/types";

/* ── Helpers ── */

const formatDate = formatDateRelative;

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
   Main Chat component — sub-components extracted to ./chat/
   ═══════════════════════════════════════════════ */

export default function Chat() {
  /* ── Auth State ── */
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
  const [activeView, setActiveView] = useState<"chat" | "knowledge-base">("chat");
  const [kbCategoryFilter, setKbCategoryFilter] = useState<string>("all");

  // Support modal state
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportSending, setSupportSending] = useState(false);
  const [supportHistory, setSupportHistory] = useState<{ id: string; message: string; admin_reply: string | null; admin_number: number | null; status: string; created_at: string; replied_at: string | null }[]>([]);
  const [unreadSupportCount, setUnreadSupportCount] = useState(0);

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

  /* ── Support ── */
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

  /* ── Bulk delete sources ── */
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
            {/* Mobile: hamburger menu with nav buttons */}
            <div className="mobile-hamburger-wrapper" ref={mobileMenuRef}>
              <button
                className="menu-btn"
                onClick={() => setMobileMenuOpen((o) => !o)}
                title="Меню"
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
                    Обучение
                  </a>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); openSupportModal(); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                    </svg>
                    Поддержка
                    {unreadSupportCount > 0 && (
                      <span className="mobile-hamburger-item-badge">{unreadSupportCount}</span>
                    )}
                  </button>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); navigateToInfographic(); }}
                  >
                    <InfographicIcon />
                    Инфографика
                  </button>
                  <button
                    className={`mobile-hamburger-item${activeView === "knowledge-base" ? " active" : ""}`}
                    onClick={() => { setMobileMenuOpen(false); setActiveView(activeView === "knowledge-base" ? "chat" : "knowledge-base"); }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    </svg>
                    База знаний
                  </button>
                  <button
                    className="mobile-hamburger-item"
                    onClick={() => { setMobileMenuOpen(false); setRightOpen((o) => !o); }}
                  >
                    <HistoryIcon />
                    История диалогов
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
              title="На главную"
            >
              <SpektrIcon size={36} />
              <span style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 700, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1 }}>
                <span style={{ color: '#003A7A' }}>Снаб</span><span style={{ color: '#0099CC' }}>Чат</span>
              </span>
            </button>
            <div className="header-divider desktop-only" />
            <span className="header-username desktop-only">
              {userName}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {hasSummary && <span className="memory-pill">Память активна</span>}
            {/* Desktop: nav buttons inline */}
            <a
              className="header-labeled-btn accent desktop-only"
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
              className="header-labeled-btn accent desktop-only"
              onClick={openSupportModal}
              title="Поддержка"
              style={{ position: "relative" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
              </svg>
              <span className="btn-label">Поддержка</span>
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
              title="Генератор инфографики"
            >
              <InfographicIcon />
              <span className="btn-label">Инфографика</span>
            </button>
            <button
              className={`header-labeled-btn accent desktop-only${activeView === "knowledge-base" ? " active" : ""}`}
              onClick={() => setActiveView(activeView === "knowledge-base" ? "chat" : "knowledge-base")}
              title="База знаний"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="btn-label">База знаний</span>
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
              title="Новый чат"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              <span className="btn-label">Новый чат</span>
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
              title="Новый чат"
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
              title="Выйти"
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
                      Админ-панель
                    </a>
                  )}
                  <button className="user-menu-item" onClick={handleLogout}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Выйти
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* ── Body ── */}
        <div className="app-body">
          {/* Sidebar overlay (mobile) */}
          {rightOpen && (
            <div className="sidebar-overlay" onClick={() => setRightOpen(false)} />
          )}

          {/* ── Main ── */}
          {activeView === "knowledge-base" ? (
            <main className="main-area">
              <div className="kb-view">
                <div className="kb-header">
                  <h2 className="kb-title">База знаний</h2>
                  <span className="kb-badge">{sources.length}</span>
                  {isAdmin && sources.length > 0 && (
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      {!bulkSelectMode ? (
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 12, padding: "5px 12px" }}
                          onClick={() => setBulkSelectMode(true)}
                        >
                          Выбрать
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
                              return selectedSourceIds.size === filtered.length && filtered.every((s) => selectedSourceIds.has(s.id)) ? "Снять всё" : "Выбрать все";
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
                            Удалить ({selectedSourceIds.size})
                          </button>
                          <button
                            className="btn-secondary"
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => { setSelectedSourceIds(new Set()); setBulkSelectMode(false); }}
                          >
                            ✕
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
                    Все ({sources.length})
                  </button>
                  {[
                    { key: "npa", label: "НПА" },
                    { key: "standards", label: "Стандарты и Положения" },
                    { key: "forms", label: "Формы и Шаблоны" },
                    { key: "schemas", label: "Схемы процессов" },
                    { key: "instructions", label: "Инструкции и Методики" },
                    { key: "pricing", label: "Ценообразование" },
                    { key: "references", label: "Справочники и Реестры" },
                    { key: "contractor-cards", label: "Карточки контрагентов" },
                    { key: "contracts", label: "Договоры" },
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
                    <p>Нет загруженных документов</p>
                  </div>
                ) : (<>
                <KBSearchBar
                  inviteCode={inviteCode}
                  folder={kbCategoryFilter === "all" ? undefined : kbCategoryFilter}
                  mode="chat"
                  onOpenDocument={(sourceId, filename) => {
                    const src = sources.find(s => String(s.id) === String(sourceId));
                    if (src) setViewingSource(src);
                  }}
                  onDownload={(sourceId, filename) => {
                    window.open("/api/sources/download?id=" + sourceId + "&action=download", "_blank");
                  }}
                />
                  <div className="kb-list">
                    {sources
                      .filter((s) => kbCategoryFilter === "all" || (s.folder_path || "standards") === kbCategoryFilter)
                      .map((doc) => {
                        const ext = doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : "docx";
                        const catLabel = [
                          { key: "npa", label: "НПА" },
                          { key: "standards", label: "Стандарты и Положения" },
                          { key: "forms", label: "Формы и Шаблоны" },
                          { key: "schemas", label: "Схемы процессов" },
                          { key: "instructions", label: "Инструкции и Методики" },
                          { key: "pricing", label: "Ценообразование" },
                          { key: "references", label: "Справочники и Реестры" },
                          { key: "contractor-cards", label: "Карточки контрагентов" },
                          { key: "contracts", label: "Договоры" },
                        ].find((c) => c.key === (doc.folder_path || "standards"))?.label || "Стандарты и Положения";
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
                                    <span>{doc.tags.length} тегов</span>
                                  </>
                                )}
                              </div>
                            </div>
                            <div className="kb-row-actions">
                              <button
                                className="kb-action-btn"
                                onClick={() => setViewingSource(doc)}
                                title="Просмотр"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                  <circle cx="12" cy="12" r="3" />
                                </svg>
                              </button>
                              <a
                                className="kb-action-btn"
                                href={`/api/sources/download?id=${doc.id}&action=download`}
                                title="Скачать"
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
                </>
                )}
              </div>
            </main>
          ) : (
          <main className="main-area">
            <div className="chat-column">
              <div className="messages-area" ref={scrollRef}>
                {hasSummary && (
                  <div className="summary-notice">ℹ Ранние сообщения сжаты в резюме</div>
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
                      onExportDocx={m.role === "assistant" ? (content: string) => handleExportDocx(content, prevUserMsg?.content || "Запрос") : undefined}
                      onExportExcel={m.role === "assistant" && containsMarkdownTable(m.content) ? (content: string) => handleExportExcel(content, prevUserMsg?.content || "Запрос") : undefined}
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
          )}

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
          <span className="footer-full">СнабЧат · Дирекция по закупкам · 2026 · </span>
          Разработка @Кирилл Трубицын
        </footer>
      </div>

      {viewingSource && (
        <ChatDocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
        />
      )}

      {/* ── Support Modal ── */}
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
              <h3 style={{ margin: 0, fontSize: 18 }}>Поддержка</h3>
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
                  Здесь будут ваши обращения в поддержку
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
                        Администратор {m.admin_number ?? ""} · {m.replied_at ? new Date(m.replied_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) : ""}
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
                placeholder="Опишите вашу проблему или вопрос..."
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
                {supportSending ? "Отправка..." : "Отправить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
