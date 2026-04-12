"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/app/lib/api";
import AdminPanel from "@/app/components/AdminPanel";

export default function AdminPage() {
  const [adminCode, setAdminCode] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [isDocAdmin, setIsDocAdmin] = useState(false);
  const [canDeleteCodes, setCanDeleteCodes] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const code = localStorage.getItem("snabchat_admin_code");
    const name = localStorage.getItem("snabchat_user_name");
    const isAdmin = localStorage.getItem("snabchat_is_admin");

    if (!code || isAdmin !== "true") {
      router.push("/");
      return;
    }

    setAdminCode(code);
    setUserName(name || "Администратор");

    // Fetch isDocAdmin from server (localStorage may be stale/missing)
    fetch(apiUrl("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.isDocumentAdmin) {
          setIsDocAdmin(true);
          localStorage.setItem("snabchat_is_doc_admin", "true");
        }
        if (data.canDeleteCodes) {
          setCanDeleteCodes(true);
        }
        if (data.isPrimaryAdmin) {
          localStorage.setItem("snabchat_is_primary_admin", "true");
        } else {
          localStorage.removeItem("snabchat_is_primary_admin");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [router]);

  /* ── Heartbeat: keep admin visible as online while on /admin ── */
  useEffect(() => {
    const inviteCode = localStorage.getItem("snabchat_invite_code") || localStorage.getItem("snabchat_admin_code");
    if (!inviteCode) return;
    const deviceId = localStorage.getItem("snabchat_device_id") || "";
    const sendHeartbeat = () => {
      fetch(apiUrl("/api/heartbeat"), {
        method: "POST",
        headers: {
          "x-invite-code": encodeURIComponent(inviteCode),
          "x-device-id": deviceId,
        },
      }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("snabchat_admin_code");
    localStorage.removeItem("snabchat_user_name");
    localStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_invite_code");
    localStorage.removeItem("snabchat_is_doc_admin");
    router.push("/");
  };

  if (loading) {
    return (
      <div className="admin-loading">
        <div className="admin-spinner" />
      </div>
    );
  }

  return (
    <AdminPanel
      adminCode={adminCode!}
      userName={userName}
      isDocAdmin={isDocAdmin}
      canDeleteCodes={canDeleteCodes}
      onLogout={handleLogout}
    />
  );
}
