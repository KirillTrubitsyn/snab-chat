"use client";

import { useState, useEffect, useRef, useCallback, useMemo, FormEvent } from "react";
import { useRouter } from "next/navigation";
// useChat removed in ai SDK v6 migration — streaming is fully manual
import InviteGate from "./InviteGate";
import { containsMarkdownTable } from "@/app/lib/markdown-tables";
import KBSearchBar from "@/app/components/KBSearchBar";
import { formatDateRelative } from "@/app/lib/date-utils";
import { apiUrl, getAuthHeaders } from "@/app/lib/api";
import { getAvatarColor, setAvatarColor as saveAvatarColor, AVATAR_COLORS } from "@/app/lib/avatarColors";
import { DOCUMENT_CATEGORIES } from "@/app/lib/tagging";
import {
  VoiceButton,
  CameraButton,
  MessageBubble,
  EmptyState,
  ChatDocumentViewer,
  VideoOverlay,
  SpektrIcon,
  MenuIcon,
  ArrowUpIcon,
  HistoryIcon,
  InfographicIcon,
} from "./chat";
import type { Conversation, Source, ChatFile, ChatPhoto } from "./chat/types";

/* ── Helpers ── */

const formatDate = formatDateRelative;

function TypingBubble() {
  return (
    <div className="message message-ai" style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 10 }}>
      <div className="typing-indicator">
        <span />
        <span />
        <span />
      </div>
      <span style={{ color: "var(--text-secondary, #6b7280)", fontSize: 14 }}>Ищу в документах…</span>
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
  const [avatarColor, setAvatarColor] = useState<string>("#0099CC");
  const [authLoading, setAuthLoading] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const isAdmin = typeof window !== "undefined" && sessionStorage.getItem("snabchat_is_admin") === "true";

  /* ── Keep inviteCodeRef in sync ── */
  useEffect(() => {
    inviteCodeRef.current = inviteCode;
  }, [inviteCode]);

  /* ── Check existing auth on mount ── */
  useEffect(() => {
    const code = localStorage.getItem("snabchat_invite_code");
    const name = localStorage.getItem("snabchat_user_name");
    const token = sessionStorage.getItem("snabchat_auth_token");
    const isAdmin = sessionStorage.getItem("snabchat_is_admin");
    // Require auth token for regular users (admins use admin code directly)
    if (code && name && (token || isAdmin)) {
      setInviteCode(code);
      inviteCodeRef.current = code;
      setUserName(name);
      setAvatarColor(getAvatarColor());
      setIsAuthenticated(true);
    }
    setAuthLoading(false);
  }, []);

  /* ── First-visit: auto-play video presentation ──
     Only shows when InviteGate explicitly sets the "snabchat_show_video" flag
     in sessionStorage (new user who just created a password). */
  useEffect(() => {
    if (isAuthenticated && typeof window !== "undefined") {
      const shouldShow = sessionStorage.getItem("snabchat_show_video");
      if (shouldShow) {
        sessionStorage.removeItem("snabchat_show_video");
        const t = setTimeout(() => setShowVideoOverlay(true), 800);
        return () => clearTimeout(t);
      }
    }
  }, [isAuthenticated]);

  /* ── Heartbeat: keep user visible as online while in chat ── */
  useEffect(() => {
    if (!isAuthenticated) return;
    const deviceId = localStorage.getItem("snabchat_device_id") || "";
    const sendHeartbeat = async () => {
      try {
        const res = await fetch(apiUrl("/api/heartbeat"), {
          method: "POST",
          headers: {
            ...getAuthHeaders(),
            "x-device-id": deviceId,
          },
        });
        // H-A companion: если admin/user session истекла, бэкенд отдаёт 401.
        // Раньше такие ответы молча накапливались в логах каждые 2 мин.
        // Теперь — сбрасываем auth-состояние и вынуждаем повторный логин.
        if (res.status === 401) {
          console.warn("[heartbeat] session expired — forcing re-login");
          try {
            sessionStorage.removeItem("snabchat_auth_token");
            sessionStorage.removeItem("snabchat_is_admin");
            sessionStorage.removeItem("snabchat_admin_session");
            sessionStorage.removeItem("snabchat_admin_code");
          } catch { /* storage unavailable */ }
          setIsAuthenticated(false);
          return;
        }
        // Backend signals forced logout (device was removed by admin)
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.logout) {
            setIsAuthenticated(false);
          }
        }
      } catch { /* network hiccup — ignore, retry on next tick */ }
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  const handleVideoClose = useCallback(() => {
    setShowVideoOverlay(false);
    if (typeof window !== "undefined") {
      localStorage.setItem("snabchat_video_seen", "1");
      // Mark video as seen on the server (fire-and-forget)
      const id = localStorage.getItem("snabchat_invite_code_id");
      if (id) {
        fetch(apiUrl("/api/auth/video-seen"), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ inviteCodeId: id }),
        }).catch(() => {});
      }
    }
  }, []);

  const handleAuthSuccess = useCallback((data: { type: string; code: string; userName: string }) => {
    setInviteCode(data.code);
    inviteCodeRef.current = data.code;
    setUserName(data.userName);
    setAvatarColor(getAvatarColor());
    setIsAuthenticated(true);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("snabchat_invite_code");
    localStorage.removeItem("snabchat_invite_code_id");
    localStorage.removeItem("snabchat_user_name");
    sessionStorage.removeItem("snabchat_is_admin");
    sessionStorage.removeItem("snabchat_admin_code");
    sessionStorage.removeItem("snabchat_is_doc_admin");
    sessionStorage.removeItem("snabchat_auth_token");
    // snabchat_video_seen intentionally preserved — user already watched the onboarding video
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
  const [hiddenSources, setHiddenSources] = useState<Source[]>([]);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [viewingSource, setViewingSource] = useState<Source | null>(null);
  const [chatFiles, setChatFiles] = useState<ChatFile[]>([]);
  const [chatPhotos, setChatPhotos] = useState<ChatPhoto[]>([]);
  // Phase 2: Session documents — keep uploaded document content across messages in the same conversation
  const sessionDocsRef = useRef<Array<{ filename: string; markdown: string }>>([]);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [convBulkMode, setConvBulkMode] = useState(false);
  const [selectedInfographicIds, setSelectedInfographicIds] = useState<Set<string>>(new Set());
  const [infoBulkMode, setInfoBulkMode] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"chats" | "infographics">("chats");
  const [infographics, setInfographics] = useState<Array<{ id: string; topic: string; style: string; aspect_ratio: string; description: string; created_at: string; conversation_id: string | null }>>([]);
  const [viewingInfographic, setViewingInfographic] = useState<{ id: string; topic: string; image_base64: string; description: string; created_at: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"chat" | "knowledge-base">("chat");
  const [kbCategoryFilter, setKbCategoryFilter] = useState<string>("all");
  const [kbPage, setKbPage] = useState(1);
  const [showKbCategoryPicker, setShowKbCategoryPicker] = useState(false);
  const KB_PAGE_SIZE = 20;

  // .doc / .xls format warning modal
  const [showDocFormatModal, setShowDocFormatModal] = useState(false);
  const [docFormatFileName, setDocFormatFileName] = useState("");
  const [docFormatType, setDocFormatType] = useState<"doc" | "xls">("doc");

  // Support modal state
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [supportModalTab, setSupportModalTab] = useState<"help" | "support">("support");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportSending, setSupportSending] = useState(false);
  const [supportFiles, setSupportFiles] = useState<File[]>([]);
  const [supportHistory, setSupportHistory] = useState<{ id: string; message: string; admin_reply: string | null; admin_number: number | null; status: string; created_at: string; replied_at: string | null }[]>([]);
  const [unreadSupportCount, setUnreadSupportCount] = useState(0);

  // Video presentation overlay
  const [showVideoOverlay, setShowVideoOverlay] = useState(false);

  const router = useRouter();

  const CONV_LIMIT = 20;
  const INFO_LIMIT = 20;

  /* ── Infographic navigation ── */
  const navigateToInfographic = useCallback((content?: string) => {
    if (infographics.length >= INFO_LIMIT) {
      setChatError(`Достигнут лимит инфографик (${INFO_LIMIT}). Удалите старые, чтобы создать новую.`);
      return;
    }
    const ctx: Record<string, string> = {};
    if (content) ctx.documentText = content;
    if (convIdRef.current) ctx.conversationId = convIdRef.current;
    if (Object.keys(ctx).length > 0) {
      sessionStorage.setItem("infographic_context", JSON.stringify(ctx));
    }
    router.push("/infographic");
  }, [router, infographics.length, INFO_LIMIT]);

  const [docxDownloading, setDocxDownloading] = useState(false);
  const handleExportDocx = useCallback(async (answerContent: string, questionContent: string) => {
    if (docxDownloading) return;
    setDocxDownloading(true);
    try {
      const res = await fetch(apiUrl("/api/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ question: questionContent, answer: answerContent }),
      });
      if (!res.ok) throw new Error("Export failed");
      // Extract filename from Content-Disposition header
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
      // Fallback when Content-Disposition could not be parsed: same naming
      // policy as the backend (PR #5) — date prefix, no brand.
      const filename = filenameMatch
        ? decodeURIComponent(filenameMatch[1])
        : `${new Date().toISOString().slice(0, 10)} ответ.docx`;
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
      const res = await fetch(apiUrl("/api/export-excel"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ question: questionContent, answer: answerContent }),
      });
      if (!res.ok) throw new Error("Excel export failed");
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
      const filename = filenameMatch
        ? decodeURIComponent(filenameMatch[1])
        : `${new Date().toISOString().slice(0, 10)} таблица.xlsx`;
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

  /* ── Message & input state (manual streaming — useChat removed in ai SDK v6) ── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [messages, setMessagesRaw] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const isLoading = false; // streaming state managed by isSending
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setInput(e.target.value),
    []
  );

  // Reset messages when active conversation changes
  useEffect(() => {
    setMessagesRaw([]);
  }, [activeConvId, chatKey]);

  // Always use the latest setMessages via ref to avoid stale closure issues
  const setMessagesRef = useRef(setMessagesRaw);
  setMessagesRef.current = setMessagesRaw;
  const setMessages = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (updater: any[] | ((prev: any[]) => any[])) => setMessagesRef.current(updater),
    []
  );

  /* ── Load conversations ── */
  const loadConversations = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl("/api/conversations"), {
        headers: { ...getAuthHeaders() },
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

  /* ── Load infographics ── */
  const loadInfographics = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl("/api/infographics"), {
        headers: { ...getAuthHeaders() },
      });
      const data = await res.json();
      if (data.infographics) setInfographics(data.infographics);
    } catch {
      // ignore
    }
  }, [inviteCode]);

  useEffect(() => {
    loadInfographics();
  }, [loadInfographics]);

  /* ── Load sources ── */
  const loadSources = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/sources?view=chat"), { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.sources) setSources(data.sources);
      if (data.denormalized) setHiddenSources(data.denormalized);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) loadSources();
  }, [loadSources, isAuthenticated]);

  // Combined list for source matching in citations (visible + hidden denormalized)
  const allSourcesForMatching = useMemo(
    () => [...sources, ...hiddenSources],
    [sources, hiddenSources]
  );

  /* ── Support ── */
  const loadSupportHistory = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl("/api/support"), {
        headers: { ...getAuthHeaders() },
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
      const formData = new FormData();
      formData.append("message", supportMessage.trim());
      supportFiles.forEach((f) => formData.append("files", f));
      const res = await fetch(apiUrl("/api/support"), {
        method: "POST",
        headers: { ...getAuthHeaders() },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("[Support] POST error:", err);
      }
      setSupportMessage("");
      setSupportFiles([]);
      await loadSupportHistory();
    } catch (e) { console.error("[Support] send error:", e); }
    setSupportSending(false);
  };

  const openSupportModal = (tab: "help" | "support" = "support") => {
    setShowSupportModal(true);
    setSupportModalTab(tab);
    loadSupportHistory();
    // Mark as seen
    localStorage.setItem("supportLastSeen", String(Date.now()));
    setUnreadSupportCount(0);
  };

  /* ── Switch conversation ── */
  const switchConversation = useCallback(
    (convId: string) => {
      setActiveConvId(convId);
      convIdRef.current = convId;
      setRightOpen(false);
      // Phase 2: Clear session documents when switching conversations
      sessionDocsRef.current = [];
    },
    []
  );

  // Load messages after activeConvId changes (ensures useChat has re-initialized with new id)
  useEffect(() => {
    if (!activeConvId) return;
    // Skip loading from server if we're about to submit a new message
    // (createConversation sets activeConvId before the message is sent)
    if (pendingSubmitRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/conversations/messages?id=${activeConvId}`), {
          headers: { ...getAuthHeaders() },
        });
        const data = await res.json();
        if (cancelled) return;
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
        if (!cancelled) setMessages([]);
      }
    })();
    return () => { cancelled = true; };
  }, [activeConvId]);  // setMessages is stable via ref wrapper

  // ── Reload messages from server to replace temp IDs after streaming ──
  const reloadMessagesFromServer = useCallback(async (convId: string, expectedCount: number) => {
    // Retry a few times until server has all messages saved
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        const res = await fetch(apiUrl(`/api/conversations/messages?id=${convId}`), {
          headers: { ...getAuthHeaders() },
        });
        const data = await res.json();
        if (data.messages && data.messages.length >= expectedCount) {
          setMessages(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.messages.map((m: { id: string; role: string; content: string; metadata?: any }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              ...(m.metadata?.sources ? { sources: m.metadata.sources } : {}),
              ...(m.metadata ? { metadata: m.metadata } : {}),
            }))
          );
          return; // Success — replaced temp IDs
        }
      } catch {
        // ignore — will retry or give up
      }
    }
    // All retries exhausted — messages still visible with temp IDs
  }, []);  // setMessages is stable via ref wrapper

  // ── Sync messages when admin deletes them (poll + tab focus) ──
  useEffect(() => {
    if (!activeConvId) return;
    const SYNC_INTERVAL = 30_000; // 30 seconds

    const syncMessages = async () => {
      // Don't sync while user is streaming or sending
      if (pendingSubmitRef.current || isSending) return;
      try {
        const res = await fetch(apiUrl(`/api/conversations/messages?id=${activeConvId}`), {
          headers: { ...getAuthHeaders() },
        });
        const data = await res.json();
        if (!data.messages) return;
        // Compare message IDs — only update if something changed
        // Skip temp IDs (from streaming) — they won't exist on server yet
        const serverIds = new Set<string>(data.messages.map((m: { id: string }) => m.id));
        const localIds = new Set<string>(messages.filter((m) => !m.id.startsWith("temp-")).map((m) => m.id));
        const hasTempIds = messages.some((m) => m.id.startsWith("temp-"));
        const deleted = [...localIds].some((id) => !serverIds.has(id));
        const added = [...serverIds].some((id) => !localIds.has(id));
        if ((deleted || added) && !hasTempIds) {
          setMessages(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.messages.map((m: { id: string; role: string; content: string; metadata?: any }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              ...(m.metadata?.sources ? { sources: m.metadata.sources } : {}),
              ...(m.metadata ? { metadata: m.metadata } : {}),
            }))
          );
        }
      } catch {
        // ignore sync errors
      }
    };

    const interval = setInterval(syncMessages, SYNC_INTERVAL);
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncMessages();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeConvId, messages, isSending]);  // setMessages is stable via ref wrapper

  /* ── Create conversation (with retry for transient errors) ── */
  const createConversation = useCallback(
    async (title?: string) => {
      const MAX_RETRIES = 2;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(apiUrl("/api/conversations"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ title: title || "Новый диалог" }),
          });
          if (!res.ok) {
            // 401 is not retryable
            if (res.status === 401) {
              handleLogout();
              throw new Error(`Не удалось создать диалог: ${res.status}`);
            }
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
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // Don't retry auth errors
          if (lastError.message.includes("401")) throw lastError;
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
        }
      }
      throw lastError!;
    },
    [handleLogout]  // setMessages is stable via ref wrapper
  );

  /* ── Delete conversation ── */
  const deleteConversation = useCallback(
    async (convId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      await fetch(apiUrl(`/api/conversations?id=${convId}`), {
        method: "DELETE",
        headers: { ...getAuthHeaders() },
      });
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeConvId === convId) {
        setActiveConvId(null);
        convIdRef.current = null;
        setMessages([]);
        setHasSummary(false);
      }
    },
    [activeConvId]  // setMessages is stable via ref wrapper
  );

  /* ── Infographic helpers ── */
  const viewInfographic = useCallback(async (id: string) => {
    try {
      const res = await fetch(apiUrl("/api/infographics"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.infographic) setViewingInfographic(data.infographic);
    } catch {
      // ignore
    }
  }, []);

  const deleteInfographic = useCallback(async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    await fetch(apiUrl(`/api/infographics?id=${id}`), {
      method: "DELETE",
      headers: { ...getAuthHeaders() },
    });
    setInfographics((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const deleteSelectedInfographics = useCallback(async () => {
    if (selectedInfographicIds.size === 0) return;
    const ids = Array.from(selectedInfographicIds);
    await Promise.all(ids.map((id) =>
      fetch(apiUrl(`/api/infographics?id=${id}`), {
        method: "DELETE",
        headers: { ...getAuthHeaders() },
      })
    ));
    setInfographics((prev) => prev.filter((i) => !selectedInfographicIds.has(i.id)));
    setSelectedInfographicIds(new Set());
    setInfoBulkMode(false);
  }, [selectedInfographicIds]);

  /* ── Rename helpers ── */
  const startRename = useCallback((id: string, currentName: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRenamingId(id);
    setRenameValue(currentName);
  }, []);

  const submitRenameConversation = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    const trimmed = renameValue.trim();
    await fetch(apiUrl("/api/conversations"), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ id: renamingId, title: trimmed }),
    });
    setConversations((prev) => prev.map((c) => c.id === renamingId ? { ...c, title: trimmed } : c));
    setRenamingId(null);
  }, [renamingId, renameValue]);

  const submitRenameInfographic = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    const trimmed = renameValue.trim();
    await fetch(apiUrl("/api/infographics"), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ id: renamingId, topic: trimmed }),
    });
    setInfographics((prev) => prev.map((i) => i.id === renamingId ? { ...i, topic: trimmed } : i));
    setRenamingId(null);
  }, [renamingId, renameValue]);

  /* ── Chat file attach handlers ── */
  const MAX_CHAT_FILES = 10;
  const MAX_CHAT_PHOTOS = 10;
  const MAX_CHAT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
  const ACCEPTED_CHAT_TYPES = ".pdf,.doc,.docx,.xlsx,.xls,.pptx,.txt,.md,.mp3,.wav,.jpg,.jpeg,.png,.gif,.bmp,.webp";
  const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "bmp", "webp"];

  const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024; // 4 MB (Vercel body limit)

  const parseFileViaApi = useCallback(async (file: File, fileId: string, isPhoto: boolean) => {
    try {
      const formData = new FormData();

      // Large files: upload to Storage first, then pass storagePath to parse
      if (file.size > LARGE_FILE_THRESHOLD) {
        const urlRes = await fetch(apiUrl("/api/chat-upload-url"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({ filename: file.name, mimeType: file.type }),
        });
        if (urlRes.ok) {
          const { uploadUrl, storagePath } = await urlRes.json();
          const putRes = await fetch(uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": file.type, "x-upsert": "false" },
            body: file,
          });
          if (putRes.ok) {
            formData.append("storagePath", storagePath);
            formData.append("storageBucket", "chat-uploads");
            formData.append("filename", file.name);
            formData.append("mimeType", file.type);
          } else {
            throw new Error("Storage upload failed");
          }
        } else {
          throw new Error("Failed to get upload URL");
        }
      } else {
        formData.append("file", file);
      }

      const res = await fetch(apiUrl("/api/parse"), { method: "POST", body: formData, headers: { ...getAuthHeaders() } });
      if (!res.ok) {
        let serverError = "Parse failed";
        try { const errData = await res.json(); serverError = errData.error || serverError; } catch { /* ignore */ }
        throw new Error(serverError);
      }
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
    } catch (err) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const errMsg = err instanceof Error ? err.message : "";

      // Legacy .doc file → show resave modal
      if (ext === "doc") {
        setChatFiles((prev) => prev.filter((f) => f.id !== fileId));
        setDocFormatFileName(file.name);
        setDocFormatType("doc");
        setShowDocFormatModal(true);
        return;
      }
      // Old binary .xls format (Excel 97-2003) — may be disguised as .xlsx
      if (ext === "xls" || errMsg.includes("Excel 97-2003") || errMsg.includes("старый формат")) {
        setChatFiles((prev) => prev.filter((f) => f.id !== fileId));
        setDocFormatFileName(file.name);
        setDocFormatType("xls");
        setShowDocFormatModal(true);
        return;
      }
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
          alert(`Файл "${file.name}" превышает 50 МБ`);
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
        if (!["pdf", "doc", "docx", "xlsx", "xls", "pptx", "txt", "md", "mp3", "wav"].includes(ext)) {
          alert(`Формат .${ext} не поддерживается. Допустимые: PDF, DOC, DOCX, XLSX, PPTX, TXT, MD, MP3, WAV, изображения`);
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
    await fetch(apiUrl("/api/conversations"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
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
  }, [selectedConvIds, activeConvId]);

  const deleteAllConversations = useCallback(async () => {
    await fetch(apiUrl("/api/conversations?all=true&confirm=true"), { method: "DELETE", headers: { ...getAuthHeaders() } });
    setConversations([]);
    setActiveConvId(null);
    convIdRef.current = null;
    setChatKey(`new-${Date.now()}`);
    setMessages([]);
    setHasSummary(false);
    setSelectedConvIds(new Set());
    setConvBulkMode(false);
  }, []);

  /* ── Submit handler with pending logic ── */
  const handleSubmit = useCallback(
    async (e?: FormEvent, overrideText?: string) => {
      e?.preventDefault();
      const text = (overrideText ?? input).trim();
      const hasFiles = chatFiles.filter((f) => !f.parsing && !f.error && f.markdown).length > 0;
      const hasPhotos = chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown).length > 0;
      if ((!text && !hasFiles && !hasPhotos) || isLoading || isSending) return;

      // Block new conversations if limit reached
      if (!convIdRef.current && conversations.length >= CONV_LIMIT) {
        setChatError(`Достигнут лимит диалогов (${CONV_LIMIT}). Удалите старые диалоги, чтобы начать новый.`);
        return;
      }

      setIsSending(true);
      setChatError(null);

      // Prepare attached documents from chatFiles + chatPhotos
      const readyFiles = chatFiles.filter((f) => !f.parsing && !f.error && f.markdown);
      const readyPhotos = chatPhotos.filter((p) => !p.parsing && !p.error && p.markdown);
      const attachedDocuments: Array<{ filename: string; markdown: string }> = [
        ...readyFiles.map((f) => ({ filename: f.filename, markdown: f.markdown })),
        ...readyPhotos.map((p, i) => ({ filename: p.file.name || `Фото ${i + 1}`, markdown: p.markdown })),
      ];
      const attachmentNames = [
        ...readyFiles.map((f) => f.filename),
        ...readyPhotos.map((p) => p.file.name || "Фото"),
      ];

      // Fire-and-forget: log file attachments to Vercel API (not Railway)
      if (attachmentNames.length > 0) {
        fetch("/api/admin/chat-uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ filenames: attachmentNames, conversationId: convIdRef.current || null }),
        }).catch(() => {});
      }

      // ── Auto-detect and fetch URLs from message text ──
      const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
      const detectedUrls = text ? [...new Set(text.match(urlRegex) || [])] : [];
      if (detectedUrls.length > 0) {
        const urlResults = await Promise.allSettled(
          detectedUrls.slice(0, 5).map(async (url) => {
            const res = await fetch(apiUrl("/api/fetch-url"), {
              method: "POST",
              headers: { "Content-Type": "application/json", ...getAuthHeaders() },
              body: JSON.stringify({ url }),
            });
            if (!res.ok) return null;
            return res.json();
          })
        );
        for (const result of urlResults) {
          if (result.status === "fulfilled" && result.value) {
            const { title, url: fetchedUrl, markdown } = result.value;
            attachedDocuments.push({ filename: `${title} (${fetchedUrl})`, markdown });
            attachmentNames.push(title || fetchedUrl);
          }
        }
      }
      const messageText = text || (attachmentNames.length > 0 ? `Проверь ${attachmentNames.length === 1 ? "документ" : "документы"}: ${attachmentNames.join(", ")}` : "");

      // Phase 2: Save newly attached documents to session for future messages
      if (attachedDocuments.length > 0) {
        // Replace session docs (don't accumulate infinitely; keep latest upload set)
        sessionDocsRef.current = attachedDocuments.map((d) => ({ filename: d.filename, markdown: d.markdown }));
      }

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
          if (!errMsg.includes("401")) setChatError(errMsg);
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
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 90000);

          const res = await fetch(apiUrl("/api/chat"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({
              messages: [{ role: "user", content: messageText }],
              conversationId: newId,
              ...(attachedDocuments.length > 0 && { attachedDocuments }),
              // Phase 2: Send session docs for follow-up context (only if no new attachments)
              ...(attachedDocuments.length === 0 && sessionDocsRef.current.length > 0 && { sessionDocuments: sessionDocsRef.current }),
            }),
            signal: controller.signal,
          });

          clearTimeout(timeout);

          if (!res.ok || !res.body) {
            if (res.status === 401) {
              handleLogout();
            } else if (res.status === 429) {
              setChatError("Слишком много запросов. Подождите немного и попробуйте снова.");
            } else if (res.status >= 500) {
              setChatError("Сервер временно недоступен. Попробуйте через несколько секунд.");
            } else {
              setChatError("Не удалось получить ответ от ИИ. Попробуйте ещё раз.");
            }
            throw new Error(`Stream failed: ${res.status}`);
          }

          // Parse sources from header
          let sources: string[] = [];
          let chunkImages: { url: string; source: string; chunk: number }[] = [];
          try {
            const srcHeader = res.headers.get("X-Sources");
            if (srcHeader) sources = JSON.parse(decodeURIComponent(srcHeader));
          } catch { /* ignore */ }
          try {
            const imgHeader = res.headers.get("X-Chunk-Images");
            if (imgHeader) chunkImages = JSON.parse(decodeURIComponent(imgHeader));
          } catch { /* ignore */ }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let assistantText = "";
          const assistantId = `temp-assistant-${Date.now()}`;

          setMessages((prev) => [
            ...prev,
            { id: assistantId, role: "assistant", content: "", sources, ...(chunkImages.length > 0 && { chunkImages }) },
          ]);
          setIsStreaming(true);

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
          if (err instanceof DOMException && err.name === "AbortError") {
            setChatError("Запрос занял слишком много времени. Попробуйте переформулировать вопрос короче.");
          }
          console.error("Manual stream error:", err);
        }

        pendingSubmitRef.current = null;
        setIsSending(false);
        setIsStreaming(false);
        // Reload messages from server to replace temp IDs with real ones
        reloadMessagesFromServer(newId, 2); // expect user + assistant messages
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);

        const res = await fetch(apiUrl("/api/chat"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({
            messages: currentMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            conversationId: convIdRef.current,
            ...(attachedDocuments.length > 0 && { attachedDocuments }),
            // Phase 2: Send session docs for follow-up context (only if no new attachments)
            ...(attachedDocuments.length === 0 && sessionDocsRef.current.length > 0 && { sessionDocuments: sessionDocsRef.current }),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!res.ok || !res.body) {
          if (res.status === 401) {
            handleLogout();
          } else if (res.status === 429) {
            setChatError("Слишком много запросов. Подождите немного и попробуйте снова.");
          } else if (res.status >= 500) {
            setChatError("Сервер временно недоступен. Попробуйте через несколько секунд.");
          } else {
            setChatError("Не удалось получить ответ от ИИ. Попробуйте ещё раз.");
          }
          throw new Error(`Stream failed: ${res.status}`);
        }

        // Parse sources and chunk images from headers
        let sources: string[] = [];
        let chunkImages: { url: string; source: string; chunk: number }[] = [];
        try {
          const srcHeader = res.headers.get("X-Sources");
          if (srcHeader) sources = JSON.parse(decodeURIComponent(srcHeader));
        } catch { /* ignore */ }
        try {
          const imgHeader = res.headers.get("X-Chunk-Images");
          if (imgHeader) chunkImages = JSON.parse(decodeURIComponent(imgHeader));
        } catch { /* ignore */ }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = "";
        const assistantId = `temp-assistant-${Date.now()}`;

        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: "", sources, ...(chunkImages.length > 0 && { chunkImages }) },
        ]);
        setIsStreaming(true);

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
        if (err instanceof DOMException && err.name === "AbortError") {
          setChatError("Запрос занял слишком много времени. Попробуйте переформулировать вопрос короче.");
        }
        console.error("Stream error:", err);
      } finally {
        setIsSending(false);
        setIsStreaming(false);
        // Reload messages from server to replace temp IDs with real ones
        if (convIdRef.current) reloadMessagesFromServer(convIdRef.current, messages.length + 2); // +user +assistant
      }
    },
    [input, isLoading, isSending, messages, chatFiles, chatPhotos, setInput, createConversation, loadConversations, reloadMessagesFromServer, conversations]
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
                  {isAdmin && (
                    <a
                      className="mobile-hamburger-item"
                      href="/admin"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      Админ-панель
                    </a>
                  )}
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
                sessionDocsRef.current = [];
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
              onClick={() => openSupportModal()}
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
            {isAdmin && (
              <a
                className="header-labeled-btn accent desktop-only"
                href="/admin"
                title="Админ-панель"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span className="btn-label">Админ-панель</span>
              </a>
            )}
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
            {/* User avatar with dropdown menu (desktop + mobile) */}
            <div className="user-menu-wrapper" ref={userMenuRef}>
              <button
                className="user-menu-btn"
                onClick={() => setUserMenuOpen((o) => !o)}
                title={userName}
                style={{ background: avatarColor }}
              >
                {userInitials}
              </button>
              {userMenuOpen && (
                <div className="user-menu-dropdown">
                  <div className="user-menu-header">
                    <div className="user-menu-header-info">
                      <div className="user-menu-name">{userName}</div>
                      <div className="user-menu-role">
                        {isAdmin ? "Администратор" : "Пользователь"}
                      </div>
                    </div>
                    <div className="user-menu-header-avatar" style={{ background: avatarColor }}>
                      {userInitials}
                    </div>
                  </div>
                  <div className="user-menu-divider" />

                  {/* Цвет аватара */}
                  <div className="user-menu-color-section">
                    <span className="user-menu-color-label">Цвет аватара</span>
                    <div className="user-menu-color-swatches">
                      {AVATAR_COLORS.map(color => (
                        <button
                          key={color}
                          className="user-menu-color-swatch"
                          style={{
                            background: color,
                            outline: avatarColor === color ? `2px solid ${color}` : "none",
                            outlineOffset: 2,
                            boxShadow: avatarColor === color ? "0 0 0 1px #fff inset" : "none",
                          }}
                          onClick={() => {
                            saveAvatarColor(color);
                            setAvatarColor(color);
                          }}
                          title={color}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="user-menu-divider" />

                  {/* Пароль */}
                  <a className="user-menu-item" href="/settings">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    Сменить пароль
                  </a>

                  {/* 2FA */}
                  {!isAdmin && (
                    <a className="user-menu-item" href="/settings">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="M9 12l2 2 4-4" />
                      </svg>
                      Двухфакторная аутентификация
                    </a>
                  )}

                  {isAdmin && (
                    <a className="user-menu-item" href="/admin">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                      Админ-панель
                    </a>
                  )}

                  {/* Выйти */}
                  <button className="user-menu-item user-menu-item--danger" onClick={handleLogout}>
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
                </div>

                {(() => {
                  const categoryCounts = DOCUMENT_CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
                    acc[cat.key] = sources.filter((s) => (s.folder_path || "standards") === cat.key).length;
                    return acc;
                  }, {});
                  const activeCategory = DOCUMENT_CATEGORIES.find((c) => c.key === kbCategoryFilter);
                  const currentLabel = kbCategoryFilter === "all" ? "Все" : activeCategory?.label || "Все";
                  const currentCount = kbCategoryFilter === "all" ? sources.length : (categoryCounts[kbCategoryFilter] || 0);
                  return (
                    <>
                      <div className="admin-doc-filters" style={{ marginBottom: 16 }}>
                        <button
                          type="button"
                          className={`admin-doc-filter-btn ${kbCategoryFilter !== "all" ? "active" : ""}`}
                          onClick={() => setShowKbCategoryPicker(true)}
                        >
                          <span className="material-symbols-outlined admin-doc-filter-icon">
                            {activeCategory?.icon || "category"}
                          </span>
                          <span className="admin-doc-filter-text">
                            <span className="admin-doc-filter-label">Категория</span>
                            <span className="admin-doc-filter-value">{currentLabel} ({currentCount})</span>
                          </span>
                          <span className="material-symbols-outlined admin-doc-filter-chevron">expand_more</span>
                        </button>
                      </div>

                      {showKbCategoryPicker && (
                        <div className="admin-modal-overlay" onClick={() => setShowKbCategoryPicker(false)}>
                          <div className="admin-modal admin-picker-modal" onClick={(e) => e.stopPropagation()}>
                            <div className="admin-modal-header">
                              <h3>Выберите категорию</h3>
                              <button
                                type="button"
                                onClick={() => setShowKbCategoryPicker(false)}
                                className="admin-modal-close"
                                aria-label="Закрыть"
                              >
                                &times;
                              </button>
                            </div>
                            <div className="admin-modal-body">
                              <div className="admin-picker-list">
                                <button
                                  type="button"
                                  className={`admin-picker-option ${kbCategoryFilter === "all" ? "active" : ""}`}
                                  onClick={() => { setKbCategoryFilter("all"); setKbPage(1); setShowKbCategoryPicker(false); }}
                                >
                                  <span className="material-symbols-outlined admin-picker-option-icon">apps</span>
                                  <span className="admin-picker-option-label">Все</span>
                                  <span className="admin-picker-option-count">{sources.length}</span>
                                  {kbCategoryFilter === "all" && (
                                    <span className="material-symbols-outlined admin-picker-option-check">check</span>
                                  )}
                                </button>
                                {DOCUMENT_CATEGORIES.map((cat) => (
                                  <button
                                    type="button"
                                    key={cat.key}
                                    className={`admin-picker-option ${kbCategoryFilter === cat.key ? "active" : ""}`}
                                    onClick={() => { setKbCategoryFilter(cat.key); setKbPage(1); setShowKbCategoryPicker(false); }}
                                  >
                                    <span className="material-symbols-outlined admin-picker-option-icon">{cat.icon}</span>
                                    <span className="admin-picker-option-label">{cat.label}</span>
                                    <span className="admin-picker-option-count">{categoryCounts[cat.key] || 0}</span>
                                    {kbCategoryFilter === cat.key && (
                                      <span className="material-symbols-outlined admin-picker-option-check">check</span>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}

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
                  onDownload={async (sourceId, filename) => {
                    try {
                      const isMd = filename?.endsWith(".md");
                      const endpoint = isMd ? "/api/sources/download-docx" : "/api/sources/download";
                      const res = await fetch(apiUrl(endpoint + "?id=" + sourceId + "&action=download"), { headers: getAuthHeaders() });
                      if (!res.ok) return;
                      const blob = await res.blob();
                      const disposition = res.headers.get("content-disposition");
                      const match = disposition?.match(/filename\*?=(?:UTF-8'')?([^;\n]+)/i);
                      const fname = match ? decodeURIComponent(match[1]) : filename || "download";
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url; a.download = fname; document.body.appendChild(a); a.click();
                      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
                    } catch (e) { console.error("Download error:", e); }
                  }}
                />
                  {(() => {
                    const kbFiltered = sources.filter((s) => kbCategoryFilter === "all" || (s.folder_path || "standards") === kbCategoryFilter);
                    const kbTotalPages = Math.max(1, Math.ceil(kbFiltered.length / KB_PAGE_SIZE));
                    const kbSafePage = Math.min(kbPage, kbTotalPages);
                    const kbPaginated = kbFiltered.slice((kbSafePage - 1) * KB_PAGE_SIZE, kbSafePage * KB_PAGE_SIZE);
                    return (<>
                  <div className="kb-list">
                    {kbPaginated.map((doc) => {
                        const ext = doc.mime_type?.includes("x-denormalized") || doc.filename.endsWith(".md") ? "md"
                          : doc.mime_type?.includes("pdf") ? "pdf"
                          : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx"
                          : doc.mime_type?.includes("presentationml") || doc.filename.endsWith(".pptx") ? "pptx"
                          : doc.mime_type?.includes("html") || doc.filename.endsWith(".html") ? "html"
                          : "docx";
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
                          <div key={doc.id} className="kb-row">
                            <div className={`kb-row-icon ${ext}`}>
                              {ext === "pdf" ? "PDF" : ext === "xlsx" ? "XLS" : ext === "pptx" ? "PPT" : ext === "html" ? "HTML" : ext === "md" ? "MD" : "DOC"}
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
                              <button
                                className="kb-action-btn"
                                title="Скачать"
                                onClick={async () => {
                                  try {
                                    const endpoint = ext === "md" ? "download-docx" : "download";
                                    const res = await fetch(apiUrl(`/api/sources/${endpoint}?id=${doc.id}&action=download`), { headers: getAuthHeaders() });
                                    if (!res.ok) return;
                                    const blob = await res.blob();
                                    const disposition = res.headers.get("content-disposition");
                                    const match = disposition?.match(/filename\*?=(?:UTF-8'')?([^;\n]+)/i);
                                    const fname = match ? decodeURIComponent(match[1]) : doc.filename || "download";
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
                                    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
                                  } catch (e) { console.error("Download error:", e); }
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                  <polyline points="7 10 12 15 17 10" />
                                  <line x1="12" y1="15" x2="12" y2="3" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                  {kbTotalPages > 1 && (
                    <div className="kb-pagination">
                      <button className="kb-pagination-btn" disabled={kbSafePage <= 1} onClick={() => setKbPage(kbSafePage - 1)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                      </button>
                      {Array.from({ length: kbTotalPages }, (_, i) => i + 1)
                        .filter((p) => p === 1 || p === kbTotalPages || Math.abs(p - kbSafePage) <= 2)
                        .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                          if (idx > 0 && p - arr[idx - 1] > 1) acc.push("...");
                          acc.push(p);
                          return acc;
                        }, [])
                        .map((p, i) =>
                          p === "..." ? (
                            <span key={`dots-${i}`} className="kb-pagination-dots">&hellip;</span>
                          ) : (
                            <button key={p} className={`kb-pagination-btn${p === kbSafePage ? " active" : ""}`} onClick={() => setKbPage(p as number)}>{p}</button>
                          )
                        )}
                      <button className="kb-pagination-btn" disabled={kbSafePage >= kbTotalPages} onClick={() => setKbPage(kbSafePage + 1)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                      </button>
                      <span className="kb-pagination-info">{(kbSafePage - 1) * KB_PAGE_SIZE + 1}–{Math.min(kbSafePage * KB_PAGE_SIZE, kbFiltered.length)} из {kbFiltered.length}</span>
                    </div>
                  )}
                  </>);
                  })()}
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
                      allSources={allSourcesForMatching}
                      onViewSource={setViewingSource}
                      onCreateInfographic={m.role === "assistant" ? navigateToInfographic : undefined}
                      onExportDocx={m.role === "assistant" ? (content: string) => handleExportDocx(content, prevUserMsg?.content || "Запрос") : undefined}
                      onExportExcel={m.role === "assistant" && containsMarkdownTable(m.content) ? (content: string) => handleExportExcel(content, prevUserMsg?.content || "Запрос") : undefined}
                      onFollowUpClick={m.role === "assistant" ? (text: string) => handleSubmit(undefined, text) : undefined}
                    />
                  );
                })}
                {isSending && !isStreaming && <TypingBubble />}
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
              {/* Tab toggle: Чаты | Инфографика */}
              <div className="sidebar-tab-toggle">
                <button
                  className={`sidebar-tab-btn ${sidebarTab === "chats" ? "active" : ""}`}
                  onClick={() => setSidebarTab("chats")}
                >
                  Чаты
                </button>
                <button
                  className={`sidebar-tab-btn ${sidebarTab === "infographics" ? "active" : ""}`}
                  onClick={() => { setSidebarTab("infographics"); loadInfographics(); }}
                >
                  Инфографика
                  {infographics.length > 0 && (
                    <span className="sidebar-tab-badge">{infographics.length}</span>
                  )}
                </button>
              </div>

              {sidebarTab === "chats" ? (
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>ДИАЛОГИ</span>
                  <button
                    onClick={() => {
                      if (conversations.length >= CONV_LIMIT) return;
                      setActiveConvId(null);
                      convIdRef.current = null;
                      setChatKey(`new-${Date.now()}`);
                      setMessages([]);
                      setHasSummary(false);
                      sessionDocsRef.current = [];
                    }}
                    title={conversations.length >= CONV_LIMIT ? "Лимит диалогов достигнут" : "Новый диалог"}
                    style={{ fontSize: 16, color: conversations.length >= CONV_LIMIT ? "var(--error)" : "var(--text-secondary)", lineHeight: 1 }}
                    disabled={conversations.length >= CONV_LIMIT}
                  >
                    +
                  </button>
                </div>
                {/* Limit indicator */}
                <div style={{ padding: "0 12px 6px", display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, (conversations.length / CONV_LIMIT) * 100)}%`, background: conversations.length >= CONV_LIMIT ? "var(--error)" : conversations.length >= CONV_LIMIT * 0.8 ? "var(--warning)" : "var(--accent)", borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: conversations.length >= CONV_LIMIT ? "var(--error)" : "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {conversations.length}/{CONV_LIMIT}
                  </span>
                </div>
                {conversations.length >= CONV_LIMIT && (
                  <div style={{ margin: "0 12px 8px", padding: "6px 10px", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: 8, fontSize: 11, color: "var(--error)", fontWeight: 500 }}>
                    Лимит достигнут. Удалите старые диалоги.
                  </div>
                )}
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
                        {renamingId === c.id ? (
                          <input
                            className="sidebar-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={submitRenameConversation}
                            onKeyDown={(e) => { if (e.key === "Enter") submitRenameConversation(); if (e.key === "Escape") setRenamingId(null); }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          onDoubleClick={(e) => startRename(c.id, c.title, e)}
                        >
                          {c.title}
                        </div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {formatDate(c.updated_at)}
                        </div>
                      </div>
                      {!convBulkMode && renamingId !== c.id && (
                        <div className="sidebar-item-actions">
                          <button
                            className="doc-delete-btn"
                            onClick={(e) => startRename(c.id, c.title, e)}
                            title="Переименовать"
                            style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            className="doc-delete-btn"
                            onClick={(e) => deleteConversation(c.id, e)}
                            title="Удалить диалог"
                            style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              ) : (
              /* ── Infographics tab ── */
              <div className="sidebar-section" style={{ flex: 1 }}>
                <div className="sidebar-section-title">
                  <span>ИНФОГРАФИКА</span>
                  <button
                    onClick={() => navigateToInfographic()}
                    title="Создать инфографику"
                    style={{ fontSize: 16, color: infographics.length >= INFO_LIMIT ? "var(--error)" : "var(--text-secondary)", lineHeight: 1 }}
                    disabled={infographics.length >= INFO_LIMIT}
                  >
                    +
                  </button>
                </div>
                {/* Limit indicator */}
                <div style={{ padding: "0 12px 6px", display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, (infographics.length / INFO_LIMIT) * 100)}%`, background: infographics.length >= INFO_LIMIT ? "var(--error)" : infographics.length >= INFO_LIMIT * 0.8 ? "var(--warning)" : "var(--accent)", borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ fontSize: 10, color: infographics.length >= INFO_LIMIT ? "var(--error)" : "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {infographics.length}/{INFO_LIMIT}
                  </span>
                </div>
                {infographics.length >= INFO_LIMIT && (
                  <div style={{ margin: "0 12px 8px", padding: "6px 10px", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: 8, fontSize: 11, color: "var(--error)", fontWeight: 500 }}>
                    Лимит достигнут. Удалите старые инфографики.
                  </div>
                )}
                {infographics.length > 0 && (
                  <div style={{ display: "flex", gap: 4, padding: "0 12px 8px" }}>
                    {!infoBulkMode ? (
                      <button
                        className="btn-secondary"
                        style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                        onClick={() => setInfoBulkMode(true)}
                      >
                        Выбрать
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                          onClick={() => {
                            if (selectedInfographicIds.size === infographics.length) {
                              setSelectedInfographicIds(new Set());
                            } else {
                              setSelectedInfographicIds(new Set(infographics.map((i) => i.id)));
                            }
                          }}
                        >
                          {selectedInfographicIds.size === infographics.length ? "Снять всё" : "Выбрать все"}
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ flex: 1, fontSize: 11, padding: "4px 8px", color: selectedInfographicIds.size > 0 ? "var(--error)" : undefined }}
                          disabled={selectedInfographicIds.size === 0}
                          onClick={deleteSelectedInfographics}
                        >
                          Удалить ({selectedInfographicIds.size})
                        </button>
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                          onClick={() => { setSelectedInfographicIds(new Set()); setInfoBulkMode(false); }}
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                )}
                {infographics.length === 0 ? (
                  <div style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    Нет сохранённых инфографик
                  </div>
                ) : (
                <div className="sidebar-list">
                  {infographics.map((ig) => (
                    <div
                      className="sidebar-item infographic-card-item"
                      onClick={() => {
                        if (infoBulkMode) {
                          setSelectedInfographicIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(ig.id)) next.delete(ig.id); else next.add(ig.id);
                            return next;
                          });
                          return;
                        }
                        viewInfographic(ig.id);
                      }}
                      key={ig.id}
                    >
                      {infoBulkMode && (
                        <input
                          type="checkbox"
                          checked={selectedInfographicIds.has(ig.id)}
                          onChange={() => {
                            setSelectedInfographicIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(ig.id)) next.delete(ig.id); else next.add(ig.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      {!infoBulkMode && (
                        <div className="infographic-card-icon">
                          <InfographicIcon size={16} />
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {renamingId === ig.id ? (
                          <input
                            className="sidebar-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={submitRenameInfographic}
                            onKeyDown={(e) => { if (e.key === "Enter") submitRenameInfographic(); if (e.key === "Escape") setRenamingId(null); }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          onDoubleClick={(e) => startRename(ig.id, ig.topic || "", e)}
                        >
                          {ig.topic || "Без темы"}
                        </div>
                        )}
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {formatDate(ig.created_at)}
                        </div>
                      </div>
                      {!infoBulkMode && renamingId !== ig.id && (
                      <div className="sidebar-item-actions">
                        <button
                          className="doc-delete-btn"
                          onClick={(e) => startRename(ig.id, ig.topic || "", e)}
                          title="Переименовать"
                          style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          className="doc-delete-btn"
                          onClick={(e) => deleteInfographic(ig.id, e)}
                          title="Удалить инфографику"
                          style={{ fontSize: 14, color: "var(--text-muted)", flexShrink: 0 }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                      )}
                    </div>
                  ))}
                </div>
                )}
              </div>
              )}
            </div>

          </aside>
        </div>

        {/* ── Footer ── */}
        <footer className="app-footer">
          <span className="footer-text">
            <span className="footer-full">СнабЧат · Дирекция по закупкам · 2026 · </span>
            Разработка @Кирилл Трубицын
          </span>
        </footer>
      </div>

      {viewingSource && (
        <ChatDocumentViewer
          source={viewingSource}
          onClose={() => setViewingSource(null)}
          inviteCode={inviteCodeRef.current}
        />
      )}

      {/* ── Infographic Viewer Modal ── */}
      {viewingInfographic && (
        <div className="modal-overlay" style={{ zIndex: 9998 }} onClick={() => setViewingInfographic(null)}>
          <div className="infographic-viewer-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="infographic-viewer-close"
              onClick={() => setViewingInfographic(null)}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="infographic-viewer-header">
              <InfographicIcon size={18} />
              <span>{viewingInfographic.topic || "Инфографика"}</span>
              <span className="infographic-viewer-date">{formatDate(viewingInfographic.created_at)}</span>
            </div>
            <img
              src={viewingInfographic.image_base64}
              alt={viewingInfographic.topic || "Инфографика"}
              className="infographic-viewer-image"
            />
            {viewingInfographic.description && (
              <p className="infographic-viewer-desc">{viewingInfographic.description}</p>
            )}
            <div className="infographic-viewer-actions">
              <button
                className="infographic-btn primary"
                onClick={() => {
                  const link = document.createElement("a");
                  link.href = viewingInfographic.image_base64;
                  link.download = `infographic-${Date.now()}.png`;
                  link.click();
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Скачать PNG
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Support Modal ── */}
      {/* .doc / .xls format warning modal */}
      {showDocFormatModal && (
        <div className="modal-overlay" style={{ zIndex: 9999 }} onClick={() => setShowDocFormatModal(false)}>
          <div className="modal-card doc-format-modal" onClick={(e) => e.stopPropagation()}>
            <div className="doc-format-modal-icon">⚠️</div>
            <h3 className="doc-format-modal-title">Устаревший формат файла</h3>
            <p className="doc-format-modal-filename">{docFormatFileName}</p>
            {docFormatType === "xls" ? (
              <>
                <p className="doc-format-modal-text">
                  Этот файл сохранён в формате <strong>.xls</strong> (Excel 97–2003), который не поддерживается чатом.
                  Пересохраните его в современном формате <strong>.xlsx</strong>:
                </p>
                <ol className="doc-format-modal-steps">
                  <li>Откройте файл в Microsoft Excel</li>
                  <li>Нажмите <strong>Файл → Сохранить как</strong></li>
                  <li>В поле «Тип файла» выберите <strong>Книга Excel (.xlsx)</strong></li>
                  <li>Нажмите <strong>Сохранить</strong> и загрузите новый файл в чат</li>
                </ol>
              </>
            ) : (
              <>
                <p className="doc-format-modal-text">
                  Этот файл сохранён в формате <strong>.doc</strong> (Word 97–2003), который не поддерживается чатом.
                  Пересохраните его в современном формате <strong>.docx</strong>:
                </p>
                <ol className="doc-format-modal-steps">
                  <li>Откройте файл в Microsoft Word</li>
                  <li>Нажмите <strong>Файл → Сохранить как</strong></li>
                  <li>В поле «Тип файла» выберите <strong>Документ Word (.docx)</strong></li>
                  <li>Нажмите <strong>Сохранить</strong> и загрузите новый файл в чат</li>
                </ol>
              </>
            )}
            <button
              className="doc-format-modal-btn"
              onClick={() => setShowDocFormatModal(false)}
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      {/* Video presentation overlay */}
      <VideoOverlay open={showVideoOverlay} onClose={handleVideoClose} />

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
              width: "100%", maxWidth: 600,
              height: supportModalTab === "help" ? "88vh" : "auto",
              maxHeight: "88vh",
              display: "flex", flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{
              padding: "14px 16px 0", borderBottom: "1px solid var(--border, #eee)",
              display: "flex", flexDirection: "column", gap: 0, flexShrink: 0,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontWeight: 700, fontSize: 17 }}>Помощь</span>
                <button onClick={() => setShowSupportModal(false)} style={{
                  background: "none", border: "none", fontSize: 22, cursor: "pointer",
                  color: "var(--text-muted)", padding: 4, lineHeight: 1,
                }}>&times;</button>
              </div>
              {/* Tabs */}
              <div style={{ display: "flex", gap: 0 }}>
                {([
                  { key: "help", label: "Инструкция", icon: (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                  )},
                  { key: "support", label: "Написать в поддержку", icon: (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                  )},
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setSupportModalTab(tab.key)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 14px", fontSize: 13, fontWeight: supportModalTab === tab.key ? 700 : 500,
                      background: "none", border: "none", cursor: "pointer",
                      borderBottom: supportModalTab === tab.key ? "2px solid var(--accent, #2563EB)" : "2px solid transparent",
                      color: supportModalTab === tab.key ? "var(--accent, #2563EB)" : "var(--text-secondary)",
                      transition: "color 0.15s",
                      position: "relative", top: 1,
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.key === "support" && unreadSupportCount > 0 && (
                      <span style={{
                        background: "#e53935", color: "#fff", borderRadius: "50%",
                        width: 16, height: 16, fontSize: 10, fontWeight: 700,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                      }}>{unreadSupportCount}</span>
                    )}
                  </button>
                ))}
                <button
                  onClick={() => { setShowSupportModal(false); setShowVideoOverlay(true); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 14px", fontSize: 13, fontWeight: 500,
                    background: "none", border: "none", cursor: "pointer",
                    borderBottom: "2px solid transparent",
                    color: "var(--text-secondary)",
                    transition: "color 0.15s",
                    position: "relative", top: 1,
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  Видео-презентация
                </button>
              </div>
            </div>

            {/* Tab content */}
            {supportModalTab === "help" ? (
              <iframe
                src="/help?embedded=1"
                style={{ flex: 1, border: "none", borderRadius: "0 0 16px 16px", minHeight: 0 }}
                title="Инструкция"
              />
            ) : (
              <>
                {/* Presentation link */}
                <div style={{ padding: "10px 16px 0", flexShrink: 0 }}>
                  <button
                    onClick={() => { setShowSupportModal(false); setShowVideoOverlay(true); }}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 10,
                      background: "var(--bg-secondary, #F5F5F5)", boxSizing: "border-box",
                      border: "1px solid var(--border, #E2E8F0)", borderRadius: 10, padding: "10px 14px",
                      color: "var(--text-primary, #333)", cursor: "pointer", textDecoration: "none",
                      fontFamily: "inherit", fontSize: "inherit",
                    }}
                  >
                    <span style={{
                      width: 32, height: 32, borderRadius: 10, background: "#EFF6FF",
                      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      color: "#2563EB",
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                      </svg>
                    </span>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>Презентация СнабЧата</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted, #94A3B8)" }}>Обзор системы · ~5 мин</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #94A3B8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </button>
                </div>

                {/* Messages history */}
                <div style={{
                  flex: 1, overflowY: "auto", padding: 16,
                  display: "flex", flexDirection: "column", gap: 12,
                }}>
                  {supportHistory.length === 0 && (
                    <div style={{ textAlign: "center", color: "var(--text-muted)", padding: 24, fontSize: 14 }}>
                      <div style={{ marginBottom: 8 }}>Здесь будут ваши обращения в поддержку</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Обратная связь помогает сделать систему лучше — пишите смело!</div>
                    </div>
                  )}
                  {supportHistory.map((m) => (
                    <div key={m.id}>
                      <div style={{
                        background: "var(--bg-secondary, #f5f5f5)", borderRadius: 12,
                        padding: 12, marginBottom: m.admin_reply ? 8 : 0, fontSize: 14,
                      }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                          {new Date(m.created_at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}
                        </div>
                        {m.message}
                      </div>
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
                <div style={{ padding: 16, borderTop: "1px solid var(--border, #eee)", flexShrink: 0 }}>
                  <textarea
                    value={supportMessage}
                    onChange={(e) => setSupportMessage(e.target.value)}
                    placeholder="Опишите проблему или идею по улучшению..."
                    rows={3}
                    style={{
                      width: "100%", borderRadius: 10, border: "1px solid var(--border, #ddd)",
                      padding: 12, fontSize: 14, resize: "none", fontFamily: "inherit",
                      background: "var(--bg-primary, #fff)", color: "var(--text-primary, #333)",
                      boxSizing: "border-box",
                    }}
                  />
                  {/* File attachments */}
                  {supportFiles.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0 4px" }}>
                      {supportFiles.map((f, i) => (
                        <div key={i} style={{
                          display: "flex", alignItems: "center", gap: 4,
                          background: "var(--bg-secondary, #f5f5f5)", borderRadius: 8,
                          padding: "3px 8px 3px 6px", fontSize: 12, color: "var(--text-secondary)",
                          border: "1px solid var(--border, #ddd)", maxWidth: 160,
                        }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                          <button
                            onClick={() => setSupportFiles((prev) => prev.filter((_, j) => j !== i))}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, lineHeight: 1, flexShrink: 0 }}
                          >×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <label style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                      border: "1px solid var(--border, #ddd)", cursor: "pointer",
                      color: "var(--text-secondary)", background: "var(--bg-primary, #fff)",
                      whiteSpace: "nowrap",
                    }} title="Прикрепить файл (скриншот, PDF, DOCX, XLSX)">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                      </svg>
                      Файл
                      <input
                        type="file"
                        multiple
                        accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.docx,.xlsx"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []).slice(0, 5);
                          setSupportFiles((prev) => [...prev, ...files].slice(0, 5));
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      onClick={sendSupportMessage}
                      disabled={supportSending || !supportMessage.trim()}
                      style={{
                        flex: 1, padding: "10px 16px",
                        borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600,
                        background: supportSending || !supportMessage.trim() ? "#ccc" : "#1976d2",
                        color: "#fff", cursor: supportSending ? "wait" : "pointer",
                      }}
                    >
                      {supportSending ? "Отправка..." : "Отправить"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </>
  );
}
