"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl, getAuthHeaders } from "@/app/lib/api";
import AdminPanel from "@/app/components/AdminPanel";

export default function AdminPage() {
  const [adminCode, setAdminCode] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
  const [isDocAdmin, setIsDocAdmin] = useState(false);
  const [canDeleteCodes, setCanDeleteCodes] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const code = sessionStorage.getItem("snabchat_admin_code");
    const name = localStorage.getItem("snabchat_user_name");
    const isAdmin = sessionStorage.getItem("snabchat_is_admin");
    const adminSession = sessionStorage.getItem("snabchat_admin_session");

    if (!code || isAdmin !== "true") {
      router.push("/");
      return;
    }

    // If no session token, redirect to login for 2FA
    if (!adminSession) {
      console.warn("[admin] No admin session token — redirecting to login");
      sessionStorage.removeItem("snabchat_admin_code");
      sessionStorage.removeItem("snabchat_is_admin");
      router.push("/");
      return;
    }

    setAdminCode(code);
    setUserName(name || "Администратор");

    // Verify admin code + session server-side and fetch permissions
    fetch(apiUrl("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => {
        if (!res.ok) {
          sessionStorage.removeItem("snabchat_admin_code");
          sessionStorage.removeItem("snabchat_is_admin");
          sessionStorage.removeItem("snabchat_admin_session");
          router.push("/");
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        if (data.isDocumentAdmin) {
          setIsDocAdmin(true);
          sessionStorage.setItem("snabchat_is_doc_admin", "true");
        }
        if (data.canDeleteCodes) {
          setCanDeleteCodes(true);
        }
        if (data.isPrimaryAdmin) {
          sessionStorage.setItem("snabchat_is_primary_admin", "true");
        } else {
          sessionStorage.removeItem("snabchat_is_primary_admin");
        }
      })
      .catch(() => {
        sessionStorage.removeItem("snabchat_admin_code");
        sessionStorage.removeItem("snabchat_is_admin");
        sessionStorage.removeItem("snabchat_admin_session");
        router.push("/");
      })
      .finally(() => setLoading(false));
  }, [router]);

  /* ── Heartbeat: keep admin visible as online while on /admin ── */
  useEffect(() => {
    const inviteCode = localStorage.getItem("snabchat_invite_code") || sessionStorage.getItem("snabchat_admin_code");
    if (!inviteCode) return;
    const deviceId = localStorage.getItem("snabchat_device_id") || "";
    const sendHeartbeat = () => {
      fetch(apiUrl("/api/heartbeat"), {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "x-device-id": deviceId,
        },
      }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => {
    sessionStorage.removeItem("snabchat_admin_code");
    sessionStorage.removeItem("snabchat_admin_session");
    localStorage.removeItem("snabchat_user_name");
    sessionStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_invite_code");
    sessionStorage.removeItem("snabchat_is_doc_admin");
    sessionStorage.removeItem("snabchat_is_primary_admin");
    sessionStorage.removeItem("snabchat_auth_token");
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
