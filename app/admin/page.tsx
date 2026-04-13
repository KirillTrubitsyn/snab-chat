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

    if (!code || isAdmin !== "true") {
      router.push("/");
      return;
    }

    setAdminCode(code);
    setUserName(name || "Администратор");

    // Verify admin code server-side and fetch permissions
    fetch(apiUrl("/api/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => {
        if (!res.ok) {
          // Server rejected the admin code — clear session and redirect
          sessionStorage.removeItem("snabchat_admin_code");
          sessionStorage.removeItem("snabchat_is_admin");
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
        // Network error — clear session and redirect for safety
        sessionStorage.removeItem("snabchat_admin_code");
        sessionStorage.removeItem("snabchat_is_admin");
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
    localStorage.removeItem("snabchat_user_name");
    sessionStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_invite_code");
    sessionStorage.removeItem("snabchat_is_doc_admin");
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
