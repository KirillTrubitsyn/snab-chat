import { useState, useEffect, useCallback, type MutableRefObject } from "react";
import { apiUrl } from "@/app/lib/api";

interface SupportMessage {
  id: string;
  message: string;
  admin_reply: string | null;
  admin_number: number | null;
  status: string;
  created_at: string;
  replied_at: string | null;
}

export function useSupport(inviteCode: string, inviteCodeRef: MutableRefObject<string>) {
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [supportModalTab, setSupportModalTab] = useState<"help" | "support">("support");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportSending, setSupportSending] = useState(false);
  const [supportFiles, setSupportFiles] = useState<File[]>([]);
  const [supportHistory, setSupportHistory] = useState<SupportMessage[]>([]);
  const [unreadSupportCount, setUnreadSupportCount] = useState(0);

  const loadSupportHistory = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl("/api/support"), {
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
      });
      const data = await res.json();
      if (data.messages) {
        setSupportHistory(data.messages);
        const lastSeen = localStorage.getItem("supportLastSeen") ?? "0";
        const unread = data.messages.filter(
          (m: { admin_reply: string | null; replied_at: string | null }) =>
            m.admin_reply && m.replied_at && new Date(m.replied_at).getTime() > parseInt(lastSeen),
        ).length;
        setUnreadSupportCount(unread);
      }
    } catch (e) {
      console.error("[Support] load error:", e);
    }
  }, [inviteCode, inviteCodeRef]);

  // Initial load
  useEffect(() => {
    loadSupportHistory();
  }, [loadSupportHistory]);

  // Polling: every 15s when modal is open, every 60s in background (for badge)
  useEffect(() => {
    if (!inviteCode) return;
    const interval = setInterval(
      () => loadSupportHistory(),
      showSupportModal ? 15000 : 60000,
    );
    return () => clearInterval(interval);
  }, [inviteCode, showSupportModal, loadSupportHistory]);

  const sendSupportMessage = useCallback(async () => {
    if (!supportMessage.trim() || supportSending) return;
    setSupportSending(true);
    try {
      const formData = new FormData();
      formData.append("message", supportMessage.trim());
      supportFiles.forEach((f) => formData.append("files", f));
      const res = await fetch(apiUrl("/api/support"), {
        method: "POST",
        headers: { "x-invite-code": encodeURIComponent(inviteCodeRef.current) },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("[Support] POST error:", err);
      }
      setSupportMessage("");
      setSupportFiles([]);
      await loadSupportHistory();
    } catch (e) {
      console.error("[Support] send error:", e);
    }
    setSupportSending(false);
  }, [supportMessage, supportSending, supportFiles, inviteCodeRef, loadSupportHistory]);

  const openSupportModal = useCallback(
    (tab: "help" | "support" = "support") => {
      setShowSupportModal(true);
      setSupportModalTab(tab);
      loadSupportHistory();
      localStorage.setItem("supportLastSeen", String(Date.now()));
      setUnreadSupportCount(0);
    },
    [loadSupportHistory],
  );

  return {
    showSupportModal,
    setShowSupportModal,
    supportModalTab,
    setSupportModalTab,
    supportMessage,
    setSupportMessage,
    supportSending,
    supportFiles,
    setSupportFiles,
    supportHistory,
    unreadSupportCount,
    sendSupportMessage,
    openSupportModal,
    loadSupportHistory,
  };
}
