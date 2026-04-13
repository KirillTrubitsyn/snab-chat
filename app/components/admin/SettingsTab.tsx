"use client";

import { useState } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";

export default function SettingsTab({ adminCode }: { adminCode: string }) {
  const [webhookStatus, setWebhookStatus] = useState<string | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [test2FAStatus, setTest2FAStatus] = useState<string | null>(null);
  const [test2FALoading, setTest2FALoading] = useState(false);

  const headers = getAdminHeaders(adminCode);

  const registerWebhook = async () => {
    setWebhookLoading(true);
    setWebhookStatus(null);
    try {
      const res = await fetch(apiUrl("/api/telegram/setup"), { method: "POST", headers });
      const data = await res.json();
      if (res.ok) {
        const lines: string[] = [];

        // Main bot
        const main = data.main_bot;
        if (main) {
          const ok = main.telegram_response?.ok;
          lines.push(
            ok
              ? `✅ Основной бот: webhook зарегистрирован` +
                (main.secret_configured ? " (secret ✓)" : " (⚠ secret не настроен)")
              : `❌ Основной бот: ${main.telegram_response?.description || "ошибка"}`
          );
        }

        // 2FA bot
        const twoFA = data.two_fa_bot;
        if (twoFA && twoFA.status !== "not_configured") {
          const ok2 = twoFA.telegram_response?.ok;
          lines.push(
            ok2
              ? `✅ 2FA бот: webhook зарегистрирован` +
                (twoFA.secret_configured ? " (secret ✓)" : " (⚠ secret не настроен)")
              : `❌ 2FA бот: ${twoFA.telegram_response?.description || "ошибка"}`
          );
        } else if (twoFA) {
          lines.push("⬜ 2FA бот: не настроен (TELEGRAM_2FA_BOT_TOKEN не задан)");
        }

        // Fallback for old response format
        if (!main && data.telegram_response) {
          const ok = data.telegram_response?.ok;
          lines.push(
            ok
              ? `✅ Webhook зарегистрирован: ${data.webhook_url}` +
                (data.secret_configured ? " (secret ✓)" : " (⚠ secret не настроен)")
              : `❌ Ошибка Telegram: ${data.telegram_response?.description || "неизвестная"}`
          );
        }

        setWebhookStatus(lines.join("\n"));
      } else {
        setWebhookStatus(`❌ ${data.error || "Ошибка сервера"}`);
      }
    } catch {
      setWebhookStatus("❌ Сетевая ошибка");
    } finally {
      setWebhookLoading(false);
    }
  };

  const testTelegram = async () => {
    setTestLoading(true);
    setTestStatus(null);
    try {
      const res = await fetch(apiUrl("/api/telegram/test"), { method: "POST", headers });
      const data = await res.json();
      if (!data.bot_token_set) {
        setTestStatus("❌ TELEGRAM_BOT_TOKEN не задан");
        return;
      }
      const lines: string[] = [];
      for (const r of data.send_results ?? []) {
        if (r.status === "skipped") {
          lines.push(`⬜ ${r.id}: не задан`);
        } else if (r.status === "ok") {
          lines.push(`✅ ${r.id} (${r.chatId}): доставлено`);
        } else {
          const desc = r.telegram_response?.description || r.error || r.status;
          lines.push(`❌ ${r.id} (${r.chatId}): ${desc}`);
        }
      }
      setTestStatus(lines.join("\n"));
    } catch {
      setTestStatus("❌ Сетевая ошибка");
    } finally {
      setTestLoading(false);
    }
  };

  const test2FA = async () => {
    setTest2FALoading(true);
    setTest2FAStatus(null);
    try {
      const res = await fetch(apiUrl("/api/telegram/test-2fa"), { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) {
        setTest2FAStatus(`❌ ${data.error || "Ошибка сервера"}`);
        return;
      }
      const lines: string[] = [];
      lines.push(`🤖 Бот: @${data.bot_username || "?"}`);
      lines.push(`🔑 Токен: ${data.bot_token_set ? "задан ✓" : "❌ не задан"}`);
      lines.push(`🔗 Webhook: ${data.webhook?.url || "не зарегистрирован"}`);
      if (data.webhook?.last_error_message) {
        lines.push(`⚠️ Последняя ошибка: ${data.webhook.last_error_message}`);
      }
      if (data.test_send) {
        lines.push(
          data.test_send.ok
            ? `✅ Тестовое сообщение: доставлено (chat_id: ${data.test_send.chat_id})`
            : `❌ Тестовое сообщение: ${data.test_send.error || "ошибка"}`
        );
      }
      setTest2FAStatus(lines.join("\n"));
    } catch {
      setTest2FAStatus("❌ Сетевая ошибка");
    } finally {
      setTest2FALoading(false);
    }
  };

  return (
    <div className="admin-section">
      <h2>Настройки</h2>
      <div className="admin-card" style={{ maxWidth: 520, marginTop: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>Telegram Webhook</h3>
        <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 14 }}>
          Регистрация webhook для обоих ботов (основной + 2FA). Нажмите после деплоя или при смене домена.
        </p>
        <button className="admin-btn admin-btn-primary" disabled={webhookLoading} onClick={registerWebhook}>
          {webhookLoading ? "Регистрация..." : "Зарегистрировать Webhook"}
        </button>
        {webhookStatus && (
          <p style={{ marginTop: 12, fontSize: 14, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>{webhookStatus}</p>
        )}
      </div>

      <div className="admin-card" style={{ maxWidth: 520, marginTop: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>Тест уведомлений</h3>
        <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 14 }}>
          Отправить тестовое сообщение всем настроенным получателям и проверить доставку.
        </p>
        <button className="admin-btn admin-btn-primary" disabled={testLoading} onClick={testTelegram}>
          {testLoading ? "Отправка..." : "Отправить тестовое сообщение"}
        </button>
        {testStatus && (
          <p style={{ marginTop: 12, fontSize: 14, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
            {testStatus}
          </p>
        )}
      </div>

      <div className="admin-card" style={{ maxWidth: 520, marginTop: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>2FA Бот (@SC2FA_Bot)</h3>
        <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 14 }}>
          Проверить статус 2FA-бота: токен, webhook, отправка тестового сообщения.
        </p>
        <button className="admin-btn admin-btn-primary" disabled={test2FALoading} onClick={test2FA}>
          {test2FALoading ? "Проверка..." : "Проверить 2FA бот"}
        </button>
        {test2FAStatus && (
          <p style={{ marginTop: 12, fontSize: 14, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
            {test2FAStatus}
          </p>
        )}
      </div>
    </div>
  );
}
