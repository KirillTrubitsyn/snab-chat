"use client";

import { useState } from "react";
import { apiUrl } from "@/app/lib/api";

export default function SettingsTab({ adminCode }: { adminCode: string }) {
  const [webhookStatus, setWebhookStatus] = useState<string | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(false);

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  const registerWebhook = async () => {
    setWebhookLoading(true);
    setWebhookStatus(null);
    try {
      const res = await fetch(apiUrl("/api/telegram/setup"), { method: "POST", headers });
      const data = await res.json();
      if (res.ok) {
        const ok = data.telegram_response?.ok;
        setWebhookStatus(
          ok
            ? `✅ Webhook зарегистрирован: ${data.webhook_url}` +
              (data.secret_configured ? " (secret ✓)" : " (⚠ secret не настроен)")
            : `❌ Ошибка Telegram: ${data.telegram_response?.description || "неизвестная"}`
        );
      } else {
        setWebhookStatus(`❌ ${data.error || "Ошибка сервера"}`);
      }
    } catch {
      setWebhookStatus("❌ Сетевая ошибка");
    } finally {
      setWebhookLoading(false);
    }
  };

  return (
    <div className="admin-section">
      <h2>Настройки</h2>
      <div className="admin-card" style={{ maxWidth: 520, marginTop: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>Telegram Webhook</h3>
        <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 14 }}>
          Регистрация webhook для уведомлений в Telegram. Нажмите после деплоя или при смене домена.
        </p>
        <button className="admin-btn admin-btn-primary" disabled={webhookLoading} onClick={registerWebhook}>
          {webhookLoading ? "Регистрация..." : "Зарегистрировать Webhook"}
        </button>
        {webhookStatus && (
          <p style={{ marginTop: 12, fontSize: 14, whiteSpace: "pre-wrap" }}>{webhookStatus}</p>
        )}
      </div>
    </div>
  );
}
