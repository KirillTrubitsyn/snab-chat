"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface InviteGateProps {
  onSuccess: (data: {
    type: "user" | "admin";
    code: string;
    userName: string;
    inviteCodeId?: string;
  }) => void;
}

export default function InviteGate({ onSuccess }: InviteGateProps) {
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ошибка авторизации");
        return;
      }

      if (data.type === "admin") {
        // Сохраняем данные админа
        localStorage.setItem("snabchat_admin_code", data.code);
        localStorage.setItem("snabchat_user_name", data.adminName);
        localStorage.setItem("snabchat_is_admin", "true");
        // Также сохраняем как invite code для использования чата
        localStorage.setItem("snabchat_invite_code", data.code);
        router.push("/admin");
      } else {
        // Сохраняем данные пользователя
        localStorage.setItem("snabchat_invite_code", data.code);
        localStorage.setItem("snabchat_invite_code_id", data.inviteCodeId);
        localStorage.setItem("snabchat_user_name", data.name);
        localStorage.removeItem("snabchat_is_admin");
        localStorage.removeItem("snabchat_admin_code");
        onSuccess({
          type: "user",
          code: data.code,
          userName: data.name,
          inviteCodeId: data.inviteCodeId,
        });
      }
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="invite-gate">
      <div className="invite-gate-card">
        <div className="invite-gate-logo">
          <svg width="48" height="48" viewBox="0 0 512 512" fill="none">
            <rect width="512" height="512" rx="112" fill="#F0F4FA"/>
            <rect x="120" y="100" width="200" height="260" rx="28" fill="#0D47A1"/>
            <rect x="160" y="140" width="200" height="260" rx="28" fill="#1976D2"/>
            <rect x="200" y="180" width="200" height="260" rx="28" fill="#42A5F5"/>
            <rect x="328" y="368" width="52" height="40" rx="12" fill="#fff"/>
            <polygon points="338,408 328,424 348,408" fill="#fff"/>
          </svg>
        </div>
        <h1 className="invite-gate-title">СнабЧат</h1>
        <p className="invite-gate-subtitle">
          ИИ-ассистент Дирекции по закупкам
        </p>

        <form onSubmit={handleSubmit} className="invite-gate-form">
          <div className="invite-gate-input-wrapper">
            <input
              type={showCode ? "text" : "password"}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Введите инвайт-код"
              className="invite-gate-input"
              disabled={loading}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowCode(!showCode)}
              className="invite-gate-toggle"
              tabIndex={-1}
            >
              {showCode ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                  <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
                </svg>
              )}
            </button>
          </div>

          {error && (
            <p className="invite-gate-error">{error}</p>
          )}

          <button
            type="submit"
            disabled={!code.trim() || loading}
            className="invite-gate-submit"
          >
            {loading ? "Проверка..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
