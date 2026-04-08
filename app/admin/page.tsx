"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdminPanel from "@/app/components/AdminPanel";

export default function AdminPage() {
  const [adminCode, setAdminCode] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("");
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
    setLoading(false);
  }, [router]);

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
      onLogout={handleLogout}
    />
  );
}
