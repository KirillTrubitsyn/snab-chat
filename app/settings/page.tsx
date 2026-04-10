"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/app/lib/api";
import { QRCodeSVG } from "qrcode.react";

interface TwoFAStatus {
  telegram: boolean;
  sms: boolean;
  totp: boolean;
  phone: string | null;
}

export default function SettingsPage() {
  const router = useRouter();
  const [inviteCode, setInviteCode] = useState("");
  const [userName, setUserName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // 2FA status
  const [twoFA, setTwoFA] = useState<TwoFAStatus>({ telegram: false, sms: false, totp: false, phone: null });

  // Change password
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  // Setup states
  const [setupMethod, setSetupMethod] = useState<"" | "telegram" | "sms" | "totp">("");
  const [setupStep, setSetupStep] = useState<"" | "configure" | "verify">("");

  // Telegram
  const [telegramBotUrl, setTelegramBotUrl] = useState("");
  const telegramPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // SMS
  const [phone, setPhone] = useState("+7");

  // TOTP
  const [totpSecret, setTotpSecret] = useState("");
  const [totpUrl, setTotpUrl] = useState("");

  // OTP
  const [otp, setOtp] = useState("");

  useEffect(() => {
    const code = localStorage.getItem("snabchat_invite_code");
    const name = localStorage.getItem("snabchat_user_name");
    if (!code || !name) {
      router.push("/");
      return;
    }
    setInviteCode(code);
    setUserName(name);
  }, [router]);

  useEffect(() => {
    return () => {
      if (telegramPollRef.current) clearInterval(telegramPollRef.current);
    };
  }, []);

  const loadStatus = useCallback(async () => {
    if (!inviteCode) return;
    try {
      const res = await fetch(apiUrl(`/api/auth/2fa-status?code=${encodeURIComponent(inviteCode)}`));
      if (res.ok) {
        const data = await res.json();
        setTwoFA(data);
      }
    } catch { /* ignore */ }
  }, [inviteCode]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword.length < 8) {
      setError("Новый пароль должен быть не менее 8 символов");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError("Пароли не совпадают");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/change-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: inviteCode,
          oldPassword,
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      setSuccess("Пароль успешно изменён");
      setOldPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setShowPasswordForm(false);
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveMethod = async (method: string) => {
    if (!confirm(`Отключить ${method === "telegram" ? "Telegram" : method === "sms" ? "SMS" : "Authenticator"}?`)) return;

    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl("/api/auth/2fa-method"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: inviteCode, method }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      await loadStatus();
      setSuccess(`Метод ${method} отключён`);
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Telegram setup ── */
  const handleTelegramSetup = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/telegram-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: inviteCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      setTelegramBotUrl(data.botUrl);
      setSetupMethod("telegram");
      setSetupStep("configure");

      if (telegramPollRef.current) clearInterval(telegramPollRef.current);
      telegramPollRef.current = setInterval(async () => {
        await loadStatus();
        const r = await fetch(apiUrl(`/api/auth/2fa-status?code=${encodeURIComponent(inviteCode)}`));
        if (r.ok) {
          const s = await r.json();
          if (s.telegram) {
            if (telegramPollRef.current) clearInterval(telegramPollRef.current);
            setTwoFA(s);
            setSetupMethod("");
            setSetupStep("");
            setTelegramBotUrl("");
            setSuccess("Telegram привязан");
          }
        }
      }, 3000);
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── SMS setup ── */
  const handleSmsSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/setup-sms"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: inviteCode, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      setSetupStep("verify");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── TOTP setup ── */
  const handleTotpSetup = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/auth/setup-totp?code=${encodeURIComponent(inviteCode)}`));
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      setTotpSecret(data.secret);
      setTotpUrl(data.otpauthUrl);
      setSetupMethod("totp");
      setSetupStep("verify");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Verify setup OTP ── */
  const handleVerifySetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const body: Record<string, string> = {
        code: inviteCode,
        otp,
        method: setupMethod,
      };
      if (setupMethod === "sms") body.phone = phone;
      if (setupMethod === "totp") body.totpSecret = totpSecret;

      const res = await fetch(apiUrl("/api/auth/verify-setup-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Неверный код");
        return;
      }
      await loadStatus();
      setOtp("");
      setSetupMethod("");
      setSetupStep("");
      setTotpSecret("");
      setTotpUrl("");
      setSuccess(setupMethod === "sms" ? "Номер привязан" : "Authenticator настроен");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  const cancelSetup = () => {
    if (telegramPollRef.current) clearInterval(telegramPollRef.current);
    setSetupMethod("");
    setSetupStep("");
    setOtp("");
    setError("");
    setTotpSecret("");
    setTotpUrl("");
    setTelegramBotUrl("");
  };

  return (
    <div className="invite-gate" style={{ minHeight: "100vh" }}>
      <div className="invite-gate-card" style={{ maxWidth: 440 }}>
        <h1 className="invite-gate-title" style={{ fontSize: 22 }}>Настройки</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, textAlign: "center", marginBottom: 20 }}>
          {userName}
        </p>

        {error && <p className="invite-gate-error" style={{ marginBottom: 12 }}>{error}</p>}
        {success && <p style={{ color: "var(--success, #4caf50)", fontSize: 13, textAlign: "center", marginBottom: 12 }}>{success}</p>}

        {/* ── Пароль ── */}
        <div style={{ marginBottom: 20, padding: "16px", background: "var(--bg-secondary, #f5f7fa)", borderRadius: 12 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Пароль</h3>
          {!showPasswordForm ? (
            <button
              className="invite-gate-back"
              style={{ margin: 0, color: "var(--primary)" }}
              onClick={() => { setShowPasswordForm(true); setSuccess(""); }}
            >
              Сменить пароль
            </button>
          ) : (
            <form onSubmit={handleChangePassword} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="Текущий пароль"
                className="invite-gate-input invite-gate-input-text"
                disabled={loading}
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Новый пароль (мин. 8 символов)"
                className="invite-gate-input invite-gate-input-text"
                disabled={loading}
              />
              <input
                type="password"
                value={newPasswordConfirm}
                onChange={(e) => setNewPasswordConfirm(e.target.value)}
                placeholder="Подтвердите новый пароль"
                className="invite-gate-input invite-gate-input-text"
                disabled={loading}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" disabled={loading} className="invite-gate-submit" style={{ margin: 0, flex: 1 }}>
                  {loading ? "..." : "Сохранить"}
                </button>
                <button type="button" className="invite-gate-back" style={{ margin: 0 }} onClick={() => { setShowPasswordForm(false); setError(""); }}>
                  Отмена
                </button>
              </div>
            </form>
          )}
        </div>

        {/* ── 2FA методы ── */}
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Двухфакторная аутентификация</h3>

          {/* Telegram */}
          <MethodCard
            name="Telegram"
            enabled={twoFA.telegram}
            detail={twoFA.telegram ? "Привязан" : undefined}
            onEnable={handleTelegramSetup}
            onDisable={() => handleRemoveMethod("telegram")}
            loading={loading && setupMethod === "telegram"}
          />

          {/* SMS */}
          <MethodCard
            name="SMS"
            enabled={twoFA.sms}
            detail={twoFA.phone || undefined}
            onEnable={() => { setSetupMethod("sms"); setSetupStep("configure"); setError(""); }}
            onDisable={() => handleRemoveMethod("sms")}
            loading={loading && setupMethod === "sms"}
          />

          {/* TOTP */}
          <MethodCard
            name="Authenticator"
            enabled={twoFA.totp}
            detail={twoFA.totp ? "Настроен" : undefined}
            onEnable={handleTotpSetup}
            onDisable={() => handleRemoveMethod("totp")}
            loading={loading && setupMethod === "totp"}
          />
        </div>

        {/* ── Setup dialogs ── */}
        {setupStep === "configure" && setupMethod === "telegram" && (
          <SetupDialog title="Привязка Telegram" onCancel={cancelSetup}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
              Нажмите кнопку, чтобы открыть бот в Telegram. Затем нажмите &quot;Start&quot;.
            </p>
            <a
              href={telegramBotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="invite-gate-submit"
              style={{ display: "block", textAlign: "center", textDecoration: "none" }}
            >
              Открыть Telegram
            </a>
            <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", marginTop: 8 }}>
              Ожидание привязки...
            </p>
          </SetupDialog>
        )}

        {setupStep === "configure" && setupMethod === "sms" && (
          <SetupDialog title="Привязка SMS" onCancel={cancelSetup}>
            <form onSubmit={handleSmsSetup}>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7XXXXXXXXXX"
                className="invite-gate-input invite-gate-input-text"
                disabled={loading}
                autoFocus
              />
              <button type="submit" disabled={!/^\+7\d{10}$/.test(phone) || loading} className="invite-gate-submit">
                {loading ? "Отправка..." : "Отправить код"}
              </button>
            </form>
          </SetupDialog>
        )}

        {setupStep === "verify" && (setupMethod === "sms" || setupMethod === "totp") && (
          <SetupDialog
            title={setupMethod === "totp" ? "Настройка Authenticator" : "Подтверждение номера"}
            onCancel={cancelSetup}
          >
            {setupMethod === "totp" && totpUrl && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 12 }}>
                <div style={{ background: "var(--bg-secondary, #f5f5f5)", borderRadius: 10, padding: "12px 16px", marginBottom: 12, fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)", textAlign: "left", width: "100%" }}>
                  <p style={{ margin: "0 0 6px", fontWeight: 600, color: "var(--text-primary)" }}>Как настроить:</p>
                  <p style={{ margin: "0 0 4px" }}>1. Скачайте приложение-аутентификатор:</p>
                  <p style={{ margin: "0 0 4px", paddingLeft: 12 }}>
                    <a href="https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Google Authenticator</a>
                    {" или "}
                    <a href="https://play.google.com/store/apps/details?id=com.yandex.key" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Яндекс Ключ</a>
                  </p>
                  <p style={{ margin: "0 0 4px" }}>2. Откройте приложение и нажмите &quot;+&quot;</p>
                  <p style={{ margin: "0 0 4px" }}>3. Отсканируйте QR-код ниже</p>
                  <p style={{ margin: 0 }}>4. Введите 6-значный код из приложения</p>
                </div>
                <div style={{ background: "#fff", padding: 12, borderRadius: 8, marginBottom: 8 }}>
                  <QRCodeSVG value={totpUrl} size={160} />
                </div>
                <p style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", textAlign: "center" }}>
                  Или введите секрет вручную: {totpSecret}
                </p>
              </div>
            )}
            {setupMethod === "sms" && (
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8, textAlign: "center" }}>
                Код отправлен на {phone}
              </p>
            )}
            <form onSubmit={handleVerifySetup}>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                placeholder="6-значный код"
                className="invite-gate-input invite-gate-input-text"
                style={{ textAlign: "center", letterSpacing: 8, fontSize: 24 }}
                disabled={loading}
                autoFocus
                autoComplete="one-time-code"
              />
              <button type="submit" disabled={otp.length !== 6 || loading} className="invite-gate-submit">
                {loading ? "Проверка..." : "Подтвердить"}
              </button>
            </form>
          </SetupDialog>
        )}

        {/* ── Назад ── */}
        <button
          className="invite-gate-back"
          onClick={() => router.push("/")}
          style={{ width: "100%", marginTop: 8 }}
        >
          Вернуться в чат
        </button>
      </div>
    </div>
  );
}

/* ── Карточка метода 2FA ── */
function MethodCard({
  name, enabled, detail, onEnable, onDisable, loading,
}: {
  name: string;
  enabled: boolean;
  detail?: string;
  onEnable: () => void;
  onDisable: () => void;
  loading?: boolean;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 16px",
      background: "var(--bg-secondary, #f5f7fa)",
      borderRadius: 10,
      marginBottom: 8,
    }}>
      <div>
        <span style={{ fontWeight: 500, fontSize: 14 }}>{name}</span>
        {enabled && detail && (
          <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: 8 }}>{detail}</span>
        )}
      </div>
      {enabled ? (
        <button
          onClick={onDisable}
          style={{
            background: "none",
            border: "1px solid var(--border, #ddd)",
            borderRadius: 6,
            padding: "4px 12px",
            fontSize: 12,
            cursor: "pointer",
            color: "var(--text-muted)",
          }}
        >
          Отключить
        </button>
      ) : (
        <button
          onClick={onEnable}
          disabled={loading}
          style={{
            background: "var(--primary, #1976d2)",
            border: "none",
            borderRadius: 6,
            padding: "4px 12px",
            fontSize: 12,
            cursor: "pointer",
            color: "#fff",
          }}
        >
          {loading ? "..." : "Включить"}
        </button>
      )}
    </div>
  );
}

/* ── Обёртка для диалогов настройки ── */
function SetupDialog({
  title, children, onCancel,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
}) {
  return (
    <div style={{
      padding: 16,
      background: "var(--bg-secondary, #f5f7fa)",
      borderRadius: 12,
      marginBottom: 16,
    }}>
      <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, textAlign: "center" }}>{title}</h4>
      {children}
      <button className="invite-gate-back" onClick={onCancel} style={{ width: "100%", marginTop: 8 }}>
        Отмена
      </button>
    </div>
  );
}
