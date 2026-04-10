"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/app/lib/api";
import { getOrAssignAvatarColor } from "@/app/lib/avatarColors";
import { QRCodeSVG } from "qrcode.react";

type Step =
  | "code"
  | "set-password"
  | "password"
  | "recommend-2fa"
  | "setup-2fa"
  | "2fa-choose"
  | "2fa-verify";

interface InviteGateProps {
  onSuccess: (data: {
    type: "user" | "admin";
    code: string;
    userName: string;
    inviteCodeId?: string;
  }) => void;
}

export default function InviteGate({ onSuccess }: InviteGateProps) {
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [showCode, setShowCode] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Данные пользователя после первого шага
  const [inviteCodeId, setInviteCodeId] = useState("");
  const [userName, setUserName] = useState("");
  const [savedCode, setSavedCode] = useState("");
  const [twoFactorMethods, setTwoFactorMethods] = useState<string[]>([]);
  const [chosen2FAMethod, setChosen2FAMethod] = useState("");

  // TOTP setup
  const [totpSecret, setTotpSecret] = useState("");
  const [totpUrl, setTotpUrl] = useState("");

  // Telegram linking
  const [telegramBotUrl, setTelegramBotUrl] = useState("");
  const telegramPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // SMS setup
  const [phone, setPhone] = useState("+7");

  // 2FA status (для setup)
  const [twoFAStatus, setTwoFAStatus] = useState({ telegram: false, sms: false, totp: false });

  // Setup 2FA sub-step
  const [setupMethod, setSetupMethod] = useState<"" | "telegram" | "sms" | "totp">("");
  const [setupSubStep, setSetupSubStep] = useState<"choose" | "configure" | "verify">("choose");

  const getOrCreateDeviceId = (): string => {
    const key = "snabchat_device_id";
    let deviceId = localStorage.getItem(key);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(key, deviceId);
    }
    return deviceId;
  };

  // Очистка поллинга при размонтировании
  useEffect(() => {
    return () => {
      if (telegramPollRef.current) clearInterval(telegramPollRef.current);
    };
  }, []);

  // На входе загружаем сохранённый код (если есть)
  useEffect(() => {
    const stored = localStorage.getItem("snabchat_invite_code");
    if (stored) {
      setCode(stored);
      setSavedCode(stored);
    }
  }, []);

  const completeLogin = useCallback((data: {
    inviteCodeId: string;
    name: string;
    code: string;
  }) => {
    localStorage.setItem("snabchat_invite_code", data.code);
    localStorage.setItem("snabchat_invite_code_id", data.inviteCodeId);
    localStorage.setItem("snabchat_user_name", data.name);
    localStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_admin_code");
    getOrAssignAvatarColor();
    onSuccess({
      type: "user",
      code: data.code,
      userName: data.name,
      inviteCodeId: data.inviteCodeId,
    });
  }, [onSuccess]);

  /* ── Единый ввод: пароль или инвайт-код ── */
  const handleUnifiedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const input = code.trim();
    if (!input) return;
    setLoading(true);

    try {
      const deviceId = getOrCreateDeviceId();

      // 1. Попробовать как пароль (возвращающиеся пользователи)
      const pwRes = await fetch(apiUrl("/api/auth/login-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: input, device_id: deviceId }),
      });

      if (pwRes.ok) {
        const data = await pwRes.json();
        setInviteCodeId(data.inviteCodeId);
        setUserName(data.name);
        setSavedCode(data.code);
        localStorage.setItem("snabchat_invite_code", data.code);
        setTwoFactorMethods(data.twoFactorMethods || []);
        setCode("");

        if (data.twoFactorMethods && data.twoFactorMethods.length > 0) {
          setStep("2fa-choose");
        } else {
          setStep("recommend-2fa");
        }
        return;
      }

      // 2. Попробовать как инвайт-код (первый вход) или админ-код
      const codeRes = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: input.toUpperCase(), device_id: deviceId }),
      });

      const codeData = await codeRes.json();

      if (!codeRes.ok) {
        setError("Неверный пароль или инвайт-код");
        return;
      }

      // Админ
      if (codeData.type === "admin") {
        localStorage.setItem("snabchat_admin_code", codeData.code);
        localStorage.setItem("snabchat_user_name", codeData.adminName);
        getOrAssignAvatarColor();
        localStorage.setItem("snabchat_is_admin", "true");
        localStorage.setItem("snabchat_invite_code", codeData.code);
        if (codeData.isDocumentAdmin) localStorage.setItem("snabchat_is_doc_admin", "true");
        else localStorage.removeItem("snabchat_is_doc_admin");
        if (codeData.isPrimaryAdmin) localStorage.setItem("snabchat_is_primary_admin", "true");
        else localStorage.removeItem("snabchat_is_primary_admin");
        router.push("/admin");
        return;
      }

      // Пользователь с инвайт-кодом
      setInviteCodeId(codeData.inviteCodeId);
      setUserName(codeData.name);
      setSavedCode(codeData.code);
      localStorage.setItem("snabchat_invite_code", codeData.code);

      if (!codeData.hasPassword) {
        setStep("set-password");
      } else {
        // У пользователя есть пароль — инвайт-код больше не нужен
        setError("Введите ваш пароль, а не инвайт-код. Инвайт-код действует только при первом входе.");
      }
    } catch (err) {
      console.error("[login] fetch failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("TypeError")) {
        setError("Не удалось подключиться к серверу");
      } else {
        setError("Ошибка подключения к серверу");
      }
    } finally {
      setLoading(false);
    }
  };

  /* ── Шаг 2: Установка пароля (первый вход) ── */
  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Пароль должен быть не менее 8 символов");
      return;
    }
    if (password !== passwordConfirm) {
      setError("Пароли не совпадают");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/set-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: savedCode, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }

      setPassword("");
      setPasswordConfirm("");
      setStep("recommend-2fa");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Шаг 3: Ввод пароля (повторные входы) ── */
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const deviceId = getOrCreateDeviceId();

      // Если есть сохранённый код — используем verify-password, иначе login-password
      const hasCode = !!savedCode;
      const url = hasCode ? "/api/auth/verify-password" : "/api/auth/login-password";
      const body = hasCode
        ? { code: savedCode, password, device_id: deviceId }
        : { password, device_id: deviceId };

      const res = await fetch(apiUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }

      setInviteCodeId(data.inviteCodeId);
      setUserName(data.name);
      setSavedCode(data.code);
      localStorage.setItem("snabchat_invite_code", data.code);
      setTwoFactorMethods(data.twoFactorMethods || []);
      setPassword("");

      if (data.twoFactorMethods && data.twoFactorMethods.length > 0) {
        setStep("2fa-choose");
      } else {
        // Всегда предлагать настроить 2FA если она не настроена
        setStep("recommend-2fa");
      }
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Шаг 5: Отправка OTP для входа ── */
  const handleSendLoginOTP = async (method: string) => {
    setError("");
    setLoading(true);
    setChosen2FAMethod(method);

    if (method === "totp") {
      setStep("2fa-verify");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(apiUrl("/api/auth/send-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: savedCode, method }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка отправки кода");
        return;
      }

      setStep("2fa-verify");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Шаг 6: Проверка OTP при входе ── */
  const handleVerifyLoginOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(apiUrl("/api/auth/verify-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: savedCode, otp, method: chosen2FAMethod }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Неверный код");
        return;
      }

      completeLogin({ inviteCodeId: data.inviteCodeId, name: data.name, code: data.code });
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
      setOtp("");
    }
  };

  /* ── Загрузка статуса 2FA ── */
  const loadTwoFAStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/auth/2fa-status?code=${encodeURIComponent(savedCode)}`));
      if (res.ok) {
        const data = await res.json();
        setTwoFAStatus(data);
        return data;
      }
    } catch { /* ignore */ }
    return null;
  }, [savedCode]);

  const [telegramOtp, setTelegramOtp] = useState("");

  /* ── Настройка Telegram ── */
  const handleTelegramSetup = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/telegram-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: savedCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка создания кода");
        return;
      }
      setTelegramOtp(data.otp || "");
      setTelegramBotUrl(data.botUrl);
      setSetupSubStep("configure");

      // Начать поллинг статуса
      if (telegramPollRef.current) clearInterval(telegramPollRef.current);
      telegramPollRef.current = setInterval(async () => {
        const status = await loadTwoFAStatus();
        if (status?.telegram) {
          if (telegramPollRef.current) clearInterval(telegramPollRef.current);
          setTwoFAStatus(status);
          setSetupSubStep("choose");
          setSetupMethod("");
          setTelegramBotUrl("");
        }
      }, 3000);
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Настройка SMS: отправка кода ── */
  const handleSmsSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/setup-sms"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: savedCode, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      setSetupSubStep("verify");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Настройка TOTP: генерация секрета ── */
  const handleTotpSetup = async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/auth/setup-totp?code=${encodeURIComponent(savedCode)}`));
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Ошибка");
        return;
      }
      setTotpSecret(data.secret);
      setTotpUrl(data.otpauthUrl);
      setSetupSubStep("verify");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Верификация OTP при настройке 2FA ── */
  const handleVerifySetupOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const body: Record<string, string> = {
        code: savedCode,
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
      // Обновить статус
      await loadTwoFAStatus();
      setOtp("");
      setSetupSubStep("choose");
      setSetupMethod("");
      setTotpSecret("");
      setTotpUrl("");
    } catch {
      setError("Ошибка подключения к серверу");
    } finally {
      setLoading(false);
    }
  };

  /* ── Загрузить статус при входе в setup-2fa ── */
  useEffect(() => {
    if (step === "setup-2fa" && savedCode) {
      loadTwoFAStatus();
    }
  }, [step, savedCode, loadTwoFAStatus]);

  const EyeIcon = ({ open }: { open: boolean }) =>
    open ? (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
      </svg>
    ) : (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
      </svg>
    );

  const MethodLabel: Record<string, string> = {
    telegram: "Telegram",
    sms: "SMS",
    totp: "Authenticator",
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

        {/* ══ Единое поле: пароль или инвайт-код ══ */}
        {step === "code" && (
          <form onSubmit={handleUnifiedSubmit} className="invite-gate-form">
            <div className="invite-gate-input-wrapper">
              <input
                type={showCode ? "text" : "password"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Пароль или инвайт-код"
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
                <EyeIcon open={showCode} />
              </button>
            </div>
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={!code.trim() || loading} className="invite-gate-submit">
              {loading ? "Проверка..." : "Войти"}
            </button>
          </form>
        )}

        {/* ══ Шаг 2: Установка пароля ══ */}
        {step === "set-password" && (
          <form onSubmit={handleSetPassword} className="invite-gate-form">
            <p className="invite-gate-register-hint">
              Создайте пароль для входа в СнабЧат
            </p>
            <div className="invite-gate-field">
              <label className="invite-gate-label">Пароль (не менее 8 символов)</label>
              <div className="invite-gate-input-wrapper">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Придумайте пароль"
                  className="invite-gate-input"
                  disabled={loading}
                  autoFocus
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="invite-gate-toggle" tabIndex={-1}>
                  <EyeIcon open={showPassword} />
                </button>
              </div>
            </div>
            <div className="invite-gate-field">
              <label className="invite-gate-label">Подтвердите пароль</label>
              <div className="invite-gate-input-wrapper">
                <input
                  type={showPassword ? "text" : "password"}
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  placeholder="Повторите пароль"
                  className="invite-gate-input"
                  disabled={loading}
                />
              </div>
            </div>
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={loading} className="invite-gate-submit">
              {loading ? "Сохранение..." : "Создать пароль"}
            </button>
          </form>
        )}


        {/* ══ Шаг 4: Рекомендация 2FA ══ */}
        {step === "recommend-2fa" && (
          <div className="invite-gate-form">
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <p className="invite-gate-register-hint" style={{ fontWeight: 500 }}>
              Рекомендуем настроить двухфакторную аутентификацию
            </p>
            <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginBottom: 16 }}>
              Это защитит ваш аккаунт от несанкционированного доступа.
              Доступны: Telegram, SMS, Google Authenticator.
            </p>
            <button
              className="invite-gate-submit"
              onClick={() => { setStep("setup-2fa"); setSetupSubStep("choose"); setSetupMethod(""); }}
            >
              Настроить
            </button>
            <button
              className="invite-gate-back"
              onClick={() => completeLogin({ inviteCodeId, name: userName, code: savedCode })}
            >
              Пропустить
            </button>
          </div>
        )}

        {/* ══ Шаг 5: Выбор метода 2FA для входа ══ */}
        {step === "2fa-choose" && (
          <div className="invite-gate-form">
            <p className="invite-gate-register-hint" style={{ marginBottom: 12 }}>
              Подтвердите вход
            </p>
            {error && <p className="invite-gate-error">{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {twoFactorMethods.map((method) => (
                <button
                  key={method}
                  className="invite-gate-submit"
                  onClick={() => handleSendLoginOTP(method)}
                  disabled={loading}
                  style={{ margin: 0 }}
                >
                  {loading && chosen2FAMethod === method ? "Отправка..." : `Через ${MethodLabel[method] || method}`}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { setStep("password"); setError(""); }}
              className="invite-gate-back"
              disabled={loading}
            >
              Назад
            </button>
          </div>
        )}

        {/* ══ Шаг 6: Проверка OTP при входе ══ */}
        {step === "2fa-verify" && (
          <form onSubmit={handleVerifyLoginOTP} className="invite-gate-form">
            <p className="invite-gate-register-hint" style={{ marginBottom: 8 }}>
              {chosen2FAMethod === "totp"
                ? "Введите код из приложения Authenticator"
                : chosen2FAMethod === "telegram"
                  ? "Код отправлен в Telegram"
                  : "Код отправлен по SMS"}
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              placeholder="Введите 6-значный код"
              className="invite-gate-input invite-gate-input-text"
              style={{ textAlign: "center", letterSpacing: 8, fontSize: 24 }}
              disabled={loading}
              autoFocus
              autoComplete="one-time-code"
            />
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={otp.length !== 6 || loading} className="invite-gate-submit">
              {loading ? "Проверка..." : "Подтвердить"}
            </button>
            <button
              type="button"
              onClick={() => { setStep("2fa-choose"); setError(""); setOtp(""); }}
              className="invite-gate-back"
              disabled={loading}
            >
              Другой метод
            </button>
          </form>
        )}

        {/* ══ Шаг 7: Настройка 2FA ══ */}
        {step === "setup-2fa" && (
          <div className="invite-gate-form">
            {setupSubStep === "choose" && (
              <>
                <p className="invite-gate-register-hint" style={{ marginBottom: 12 }}>
                  Настройка двухфакторной аутентификации
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {/* Telegram */}
                  <button
                    className="invite-gate-submit"
                    style={{ margin: 0, background: twoFAStatus.telegram ? "var(--success, #4caf50)" : undefined }}
                    onClick={() => { if (!twoFAStatus.telegram) { setSetupMethod("telegram"); handleTelegramSetup(); } }}
                    disabled={twoFAStatus.telegram || loading}
                  >
                    {twoFAStatus.telegram ? "Telegram (привязан)" : "Привязать Telegram"}
                  </button>
                  {/* SMS */}
                  <button
                    className="invite-gate-submit"
                    style={{ margin: 0, background: twoFAStatus.sms ? "var(--success, #4caf50)" : undefined }}
                    onClick={() => { if (!twoFAStatus.sms) { setSetupMethod("sms"); setSetupSubStep("configure"); } }}
                    disabled={twoFAStatus.sms || loading}
                  >
                    {twoFAStatus.sms ? "SMS (привязан)" : "Привязать SMS"}
                  </button>
                  {/* TOTP */}
                  <button
                    className="invite-gate-submit"
                    style={{ margin: 0, background: twoFAStatus.totp ? "var(--success, #4caf50)" : undefined }}
                    onClick={() => { if (!twoFAStatus.totp) { setSetupMethod("totp"); handleTotpSetup(); } }}
                    disabled={twoFAStatus.totp || loading}
                  >
                    {twoFAStatus.totp ? "Authenticator (настроен)" : "Настроить Authenticator"}
                  </button>
                </div>
                {error && <p className="invite-gate-error">{error}</p>}
                <button
                  className="invite-gate-back"
                  onClick={() => completeLogin({ inviteCodeId, name: userName, code: savedCode })}
                  style={{ marginTop: 12 }}
                >
                  {twoFAStatus.telegram || twoFAStatus.sms || twoFAStatus.totp ? "Готово" : "Пропустить"}
                </button>
              </>
            )}

            {/* Telegram configure: показать ссылку */}
            {setupSubStep === "configure" && setupMethod === "telegram" && (
              <>
                <p className="invite-gate-register-hint">Привязка Telegram</p>
                <div style={{ background: "var(--bg-secondary, #f5f5f5)", borderRadius: 10, padding: "12px 16px", marginBottom: 12, fontSize: 13, lineHeight: 1.5 }}>
                  <p style={{ margin: "0 0 4px" }}>1. Откройте бот в Telegram</p>
                  <p style={{ margin: "0 0 4px" }}>2. Отправьте ему код ниже</p>
                  <p style={{ margin: 0 }}>3. Дождитесь подтверждения</p>
                </div>
                {telegramOtp && (
                  <div style={{ textAlign: "center", margin: "12px 0" }}>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Ваш код привязки:</p>
                    <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 8, fontFamily: "monospace", color: "var(--accent)" }}>
                      {telegramOtp}
                    </div>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Действителен 10 минут</p>
                  </div>
                )}
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
                {error && <p className="invite-gate-error">{error}</p>}
                <button
                  className="invite-gate-back"
                  onClick={() => {
                    if (telegramPollRef.current) clearInterval(telegramPollRef.current);
                    setSetupSubStep("choose");
                    setSetupMethod("");
                  }}
                >
                  Назад
                </button>
              </>
            )}

            {/* SMS configure: ввод номера */}
            {setupSubStep === "configure" && setupMethod === "sms" && (
              <form onSubmit={handleSmsSetup}>
                <p className="invite-gate-register-hint">Привязка SMS</p>
                <div className="invite-gate-field">
                  <label className="invite-gate-label">Номер телефона</label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+7XXXXXXXXXX"
                    className="invite-gate-input invite-gate-input-text"
                    disabled={loading}
                    autoFocus
                  />
                </div>
                {error && <p className="invite-gate-error">{error}</p>}
                <button type="submit" disabled={!/^\+7\d{10}$/.test(phone) || loading} className="invite-gate-submit">
                  {loading ? "Отправка..." : "Отправить код"}
                </button>
                <button
                  type="button"
                  className="invite-gate-back"
                  onClick={() => { setSetupSubStep("choose"); setSetupMethod(""); setError(""); }}
                >
                  Назад
                </button>
              </form>
            )}

            {/* TOTP/SMS verify: ввод кода */}
            {setupSubStep === "verify" && (setupMethod === "totp" || setupMethod === "sms") && (
              <form onSubmit={handleVerifySetupOTP}>
                <p className="invite-gate-register-hint">
                  {setupMethod === "totp"
                    ? "Настройка Authenticator"
                    : "Подтверждение номера"}
                </p>
                {setupMethod === "totp" && totpUrl && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ background: "var(--bg-secondary, #f5f5f5)", borderRadius: 10, padding: "12px 16px", marginBottom: 12, fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)" }}>
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
                      <QRCodeSVG value={totpUrl} size={180} />
                    </div>
                    <p style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", textAlign: "center" }}>
                      Или введите секрет вручную: {totpSecret}
                    </p>
                  </div>
                )}
                {setupMethod === "sms" && (
                  <p style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", marginBottom: 8 }}>
                    Код отправлен на {phone}
                  </p>
                )}
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="Введите 6-значный код"
                  className="invite-gate-input invite-gate-input-text"
                  style={{ textAlign: "center", letterSpacing: 8, fontSize: 24 }}
                  disabled={loading}
                  autoFocus
                  autoComplete="one-time-code"
                />
                {error && <p className="invite-gate-error">{error}</p>}
                <button type="submit" disabled={otp.length !== 6 || loading} className="invite-gate-submit">
                  {loading ? "Проверка..." : "Подтвердить"}
                </button>
                <button
                  type="button"
                  className="invite-gate-back"
                  onClick={() => { setSetupSubStep("choose"); setSetupMethod(""); setError(""); setOtp(""); }}
                >
                  Назад
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
