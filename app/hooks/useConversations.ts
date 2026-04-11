import { useState, useRef, useCallback, useEffect, type MutableRefObject } from "react";
import { apiUrl } from "@/app/lib/api";
import type { Conversation } from "@/app/components/chat/types";

export const CONV_LIMIT = 20;

export function useConversations(
  inviteCode: string,
  inviteCodeRef: MutableRefObject<string>,
  handleLogout: () => void,
) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const convIdRef = useRef<string | null>(null);
  const [chatKey, setChatKey] = useState(() => `new-${Date.now()}`);
  const [hasSummary, setHasSummary] = useState(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [convBulkMode, setConvBulkMode] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [messages, setMessagesRaw] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const isLoading = false; // streaming state managed by isSending
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setInput(e.target.value),
    [],
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
    [],
  );

  /* ── Load conversations ── */
  const loadConversations = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl("/api/conversations"), {
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      const data = await res.json();
      if (Array.isArray(data)) setConversations(data);
    } catch {
      // ignore
    }
  }, [inviteCode, inviteCodeRef]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  /* ── Heartbeat: update online status every 2 min ── */
  useEffect(() => {
    if (!inviteCode) return;
    const deviceId =
      typeof window !== "undefined"
        ? localStorage.getItem("snabchat_device_id") || ""
        : "";
    const sendHeartbeat = () => {
      fetch(apiUrl("/api/heartbeat"), {
        method: "POST",
        headers: {
          "x-invite-code": encodeURIComponent(inviteCode),
          "x-device-id": deviceId,
        },
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.logout) handleLogout();
        })
        .catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [inviteCode, handleLogout]);

  /* ── Pending submit ref (for new conversation flow) ── */
  const pendingSubmitRef = useRef<string | null>(null);

  /* ── Load messages after activeConvId changes ── */
  useEffect(() => {
    if (!activeConvId) return;
    if (pendingSubmitRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/conversations/messages?id=${activeConvId}`), {
          headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        });
        const data = await res.json();
        if (cancelled) return;
        setHasSummary(data.conversation?.hasSummary ?? false);
        if (data.messages) {
          setMessages(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data.messages.map((m: { id: string; role: string; content: string; metadata?: any }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              ...(m.metadata?.sources ? { sources: m.metadata.sources } : {}),
              ...(m.metadata ? { metadata: m.metadata } : {}),
            })),
          );
        }
      } catch {
        if (!cancelled) setMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConvId, inviteCodeRef, setMessages]);

  /* ── Reload messages from server to replace temp IDs after streaming ── */
  const reloadMessagesFromServer = useCallback(
    async (convId: string, expectedCount: number) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          const res = await fetch(apiUrl(`/api/conversations/messages?id=${convId}`), {
            headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
          });
          const data = await res.json();
          if (!data.messages) continue;
          if (data.messages.length >= expectedCount || attempt === 2) {
            setHasSummary(data.conversation?.hasSummary ?? false);
            setMessages(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data.messages.map((m: { id: string; role: string; content: string; metadata?: any }) => ({
                id: m.id,
                role: m.role as "user" | "assistant",
                content: m.content,
                ...(m.metadata?.sources ? { sources: m.metadata.sources } : {}),
                ...(m.metadata ? { metadata: m.metadata } : {}),
              })),
            );
            return;
          }
        } catch {
          // ignore, retry
        }
      }
    },
    [inviteCodeRef, setMessages],
  );

  /* ── Periodic sync for messages (admin reply etc.) ── */
  useEffect(() => {
    if (!activeConvId) return;
    const SYNC_INTERVAL = 30000;

    const syncMessages = async () => {
      if (pendingSubmitRef.current) return;
      try {
        const res = await fetch(apiUrl(`/api/conversations/messages?id=${activeConvId}`), {
          headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        });
        const data = await res.json();
        if (!data.messages) return;
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
            })),
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
  }, [activeConvId, messages, inviteCodeRef, setMessages]);

  /* ── Create conversation (with retry) ── */
  const createConversation = useCallback(
    async (title?: string) => {
      const MAX_RETRIES = 2;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(apiUrl("/api/conversations"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-invite-code": encodeURIComponent(inviteCodeRef.current),
            },
            body: JSON.stringify({ title: title || "Новый диалог" }),
          });
          if (!res.ok) {
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
          if (lastError.message.includes("401")) throw lastError;
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
        }
      }
      throw lastError!;
    },
    [handleLogout, inviteCodeRef, setMessages],
  );

  /* ── Delete conversation ── */
  const deleteConversation = useCallback(
    async (convId: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      await fetch(apiUrl(`/api/conversations?id=${convId}`), {
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
    [activeConvId, inviteCodeRef, setMessages],
  );

  /* ── Switch conversation ── */
  const switchConversation = useCallback((convId: string) => {
    setActiveConvId(convId);
    convIdRef.current = convId;
  }, []);

  /* ── Start new chat ── */
  const startNewChat = useCallback(() => {
    setActiveConvId(null);
    convIdRef.current = null;
    setChatKey(`new-${Date.now()}`);
    setMessages([]);
    setHasSummary(false);
  }, [setMessages]);

  /* ── Bulk delete conversations ── */
  const deleteSelectedConversations = useCallback(async () => {
    if (selectedConvIds.size === 0) return;
    const ids = Array.from(selectedConvIds);
    await fetch(apiUrl("/api/conversations"), {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "x-invite-code": encodeURIComponent(inviteCodeRef.current),
      },
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
  }, [selectedConvIds, activeConvId, inviteCodeRef, setMessages]);

  const deleteAllConversations = useCallback(async () => {
    await fetch(apiUrl("/api/conversations?all=true&confirm=true"), {
      method: "DELETE",
      headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
    });
    setConversations([]);
    setActiveConvId(null);
    convIdRef.current = null;
    setChatKey(`new-${Date.now()}`);
    setMessages([]);
    setHasSummary(false);
    setSelectedConvIds(new Set());
    setConvBulkMode(false);
  }, [inviteCodeRef, setMessages]);

  /* ── Rename helpers ── */
  const startRename = useCallback((id: string, currentName: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRenamingId(id);
    setRenameValue(currentName);
  }, []);

  const submitRenameConversation = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    const trimmed = renameValue.trim();
    await fetch(apiUrl("/api/conversations"), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-invite-code": encodeURIComponent(inviteCodeRef.current),
      },
      body: JSON.stringify({ id: renamingId, title: trimmed }),
    });
    setConversations((prev) => prev.map((c) => (c.id === renamingId ? { ...c, title: trimmed } : c)));
    setRenamingId(null);
  }, [renamingId, renameValue, inviteCodeRef]);

  return {
    conversations,
    activeConvId,
    setActiveConvId,
    convIdRef,
    pendingSubmitRef,
    chatKey,
    setChatKey,
    hasSummary,
    setHasSummary,
    messages,
    setMessages,
    input,
    setInput,
    isLoading,
    handleInputChange,
    loadConversations,
    createConversation,
    deleteConversation,
    switchConversation,
    startNewChat,
    deleteSelectedConversations,
    deleteAllConversations,
    selectedConvIds,
    setSelectedConvIds,
    convBulkMode,
    setConvBulkMode,
    renamingId,
    setRenamingId,
    renameValue,
    setRenameValue,
    startRename,
    submitRenameConversation,
    reloadMessagesFromServer,
    CONV_LIMIT,
  };
}
