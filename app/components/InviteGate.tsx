"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { apiUrl } from "@/app/lib/api";

interface InviteGateProps {
  onSuccess: (data: {
    type: "user" | "admin";
    code: string;
    userName: string;
    inviteCodeId?: string;
  }) => void;
}

type Step =
  | "code"           // Enter invite code (first activation / unknown user)
  | "password"       // Enter password (returning user)
  | "set-password"   // First activation: create a password
  | "2fa-otp"        // Enter OTP from Telegram or SMS
  | "2fa-totp"       // Enter TOTP code from authenticator app
  | "setup-2fa"      // Suggest 2FA setup
  | "setup-totp-qr"; // Show QR + confirm TOTP

interface PendingAuth {
  type: "user";
  code: string;
  name: string;
  inviteCodeId: string;
}

function validatePasswordStrength(password: string) {
  return {
    length: password.length >= 8,
    upper: /[A-ZА-ЯЁ]/.test(password),
    lower: /[a-zа-яё]/.test(password),
    digit: /\d/.test(password),
  };
}

const Logo = () => (
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
);

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

export default function InviteGate({ onSuccess }: InviteGateProps) {
  const router = useRouter();

  // Determine initial step based on stored invite code
  const storedCode = typeof window !== "undefined" ? localStorage.getItem("snabchat_invite_code") : null;
  const [step, setStep] = useState<Step>(storedCode ? "password" : "code");

  // Shared state
  const [pendingCode, setPendingCode] = useState(storedCode || "");
  const [pendingAuth, setPendingAuth] = useState<PendingAuth | null>(null);
  const [twoFaMethod, setTwoFaMethod] = useState<"telegram" | "sms" | "totp" | null>(null);

  // Code step
  const [codeInput, setCodeInput] = useState("");
  const [showCode, setShowCode] = useState(false);

  // Password step
  const [passwordInput, setPasswordInput] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // Set-password step
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);

  // OTP step
  const [otpInput, setOtpInput] = useState("");
  const [otpResendSeconds, setOtpResendSeconds] = useState(0);

  // TOTP setup
  const [totpSecret, setTotpSecret] = useState("");
  const [totpOtpauthUrl, setTotpOtpauthUrl] = useState("");
  const [totpConfirmOtp, setTotpConfirmOtp] = useState("");

  // Common
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const passwordStrength = validatePasswordStrength(newPassword);
  const passwordValid = Object.values(passwordStrength).every(Boolean);
  const passwordsMatch = newPassword === confirmPassword;

  const getOrCreateDeviceId = (): string => {
    const key = "snabchat_device_id";
    let deviceId = localStorage.getItem(key);
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem(key, deviceId);
    }
    return deviceId;
  };

  const commitAuth = (auth: PendingAuth) => {
    localStorage.setItem("snabchat_invite_code", auth.code);
    localStorage.setItem("snabchat_invite_code_id", auth.inviteCodeId);
    localStorage.setItem("snabchat_user_name", auth.name);
    localStorage.removeItem("snabchat_is_admin");
    localStorage.removeItem("snabchat_admin_code");
    onSuccess({ type: "user", code: auth.code, userName: auth.name, inviteCodeId: auth.inviteCodeId });
  };

  // OTP resend countdown
  useEffect(() => {
    if (otpResendSeconds <= 0) return;
    const t = setTimeout(() => setOtpResendSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [otpResendSeconds]);

  const startResendCountdown = () => setOtpResendSeconds(60);

  // ── Step: code ──────────────────────────────────────────────
  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const trimmed = codeInput.trim().toUpperCase();
    if (!trimmed) return;

    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ошибка авторизации");
        return;
      }

      if (data.type === "admin") {
        localStorage.setItem("snabchat_admin_code", data.code);
        localStorage.setItem("snabchat_user_name", data.adminName);
        localStorage.setItem("snabchat_is_admin", "true");
        localStorage.setItem("snabchat_invite_code", data.code);
        if (data.isDocumentAdmin) localStorage.setItem("snabchat_is_doc_admin", "true");
        else localStorage.removeItem("snabchat_is_doc_admin");
        router.push("/admin");
        return;
      }

      setPendingCode(trimmed);

      if (data.needsPasswordSetup) {
        setStep("set-password");
      } else if (data.needsPassword) {
        setStep("password");
      }
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  // ── Step: password ──────────────────────────────────────────
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!passwordInput) return;

    setLoading(true);
    try {
      const deviceId = getOrCreateDeviceId();
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pendingCode, password: passwordInput, device_id: deviceId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Неверный пароль");
        return;
      }

      if (data.needs2FA) {
        setTwoFaMethod(data.method);
        if (data.method === "telegram") {
          await sendOtp("telegram");
          setStep("2fa-otp");
        } else if (data.method === "sms") {
          await sendOtp("sms");
          setStep("2fa-otp");
        } else {
          setStep("2fa-totp");
        }
        return;
      }

      // Success
      const auth: PendingAuth = { type: "user", code: data.code, name: data.name, inviteCodeId: data.inviteCodeId };
      if (data.suggest2FA) {
        setPendingAuth(auth);
        setStep("setup-2fa");
      } else {
        commitAuth(auth);
      }
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  // ── Step: set-password ──────────────────────────────────────
  const handleSetPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!passwordValid) { setError("Пароль не соответствует требованиям"); return; }
    if (!passwordsMatch) { setError("Пароли не совпадают"); return; }

    setLoading(true);
    try {
      const deviceId = getOrCreateDeviceId();
      const res = await fetch(apiUrl("/api/auth/set-password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pendingCode, password: newPassword, device_id: deviceId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ошибка установки пароля");
        return;
      }

      const auth: PendingAuth = { type: "user", code: data.code, name: data.name, inviteCodeId: data.inviteCodeId };
      setPendingAuth(auth);
      setStep("setup-2fa");
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  // ── Send OTP helper ─────────────────────────────────────────
  const sendOtp = async (method: "telegram" | "sms") => {
    const endpoint = method === "telegram" ? "/api/auth/send-otp" : "/api/auth/send-sms-otp";
    await fetch(apiUrl(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pendingCode }),
    });
    startResendCountdown();
  };

  // ── Step: 2fa-otp ───────────────────────────────────────────
  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (otpInput.length !== 6) return;

    setLoading(true);
    try {
      const deviceId = getOrCreateDeviceId();
      const res = await fetch(apiUrl("/api/auth/verify-otp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pendingCode, otp: otpInput, device_id: deviceId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Неверный код");
        return;
      }

      commitAuth({ type: "user", code: data.code, name: data.name, inviteCodeId: data.inviteCodeId });
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  // ── Step: setup-2fa ─────────────────────────────────────────
  const handleSetupTotp = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(apiUrl(`/api/auth/setup-totp?code=${encodeURIComponent(pendingCode)}`));
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Ошибка"); setLoading(false); return; }
      setTotpSecret(data.secret);
      setTotpOtpauthUrl(data.otpauthUrl);
      setStep("setup-totp-qr");
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  const handleSkip2FA = () => {
    if (pendingAuth) commitAuth(pendingAuth);
  };

  // ── Step: setup-totp-qr ─────────────────────────────────────
  const handleConfirmTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (totpConfirmOtp.length !== 6) return;

    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/auth/setup-totp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pendingCode, otp: totpConfirmOtp, secret: totpSecret }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Неверный код"); setLoading(false); return; }
      if (pendingAuth) commitAuth(pendingAuth);
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────
  return (
    <div className="invite-gate">
      <div className="invite-gate-card">
        <Logo />
        <h1 className="invite-gate-title">СнабЧат</h1>
        <p className="invite-gate-subtitle">ИИ-ассистент Дирекции по закупкам</p>

        {/* ── Code entry ── */}
        {step === "code" && (
          <form onSubmit={handleCodeSubmit} className="invite-gate-form">
            <div className="invite-gate-input-wrapper">
              <input
                type={showCode ? "text" : "password"}
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                placeholder="Введите инвайт-код"
                className="invite-gate-input"
                disabled={loading}
                autoFocus
              />
              <button type="button" onClick={() => setShowCode(!showCode)} className="invite-gate-toggle" tabIndex={-1}>
                <EyeIcon open={showCode} />
              </button>
            </div>
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={!codeInput.trim() || loading} className="invite-gate-submit">
              {loading ? "Проверка..." : "Далее"}
            </button>
          </form>
        )}

        {/* ── Password entry (returning user) ── */}
        {step === "password" && (
          <form onSubmit={handlePasswordSubmit} className="invite-gate-form">
            <p className="invite-gate-register-hint">
              Введите пароль для входа
            </p>
            <div className="invite-gate-input-wrapper">
              <input
                type={showPassword ? "text" : "password"}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Пароль"
                className="invite-gate-input"
                disabled={loading}
                autoFocus
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="invite-gate-toggle" tabIndex={-1}>
                <EyeIcon open={showPassword} />
              </button>
            </div>
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={!passwordInput || loading} className="invite-gate-submit">
              {loading ? "Проверка..." : "Войти"}
            </button>
            {!storedCode && (
              <button type="button" onClick={() => { setStep("code"); setError(""); }} className="invite-gate-back" disabled={loading}>
                Назад
              </button>
            )}
          </form>
        )}

        {/* ── Set password (first activation) ── */}
        {step === "set-password" && (
          <form onSubmit={handleSetPasswordSubmit} className="invite-gate-form">
            <p className="invite-gate-register-hint">
              Первый вход — придумайте пароль для своего аккаунта
            </p>
            <div className="invite-gate-field">
              <label className="invite-gate-label">Новый пароль</label>
              <div className="invite-gate-input-wrapper">
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Придумайте пароль"
                  className="invite-gate-input"
                  disabled={loading}
                  autoFocus
                />
                <button type="button" onClick={() => setShowNewPassword(!showNewPassword)} className="invite-gate-toggle" tabIndex={-1}>
                  <EyeIcon open={showNewPassword} />
                </button>
              </div>
              {newPassword.length > 0 && (
                <div className="invite-gate-password-rules">
                  <span className={passwordStrength.length ? "rule-ok" : "rule-fail"}>✓ Минимум 8 символов</span>
                  <span className={passwordStrength.upper ? "rule-ok" : "rule-fail"}>✓ Заглавная буква (А-Я, A-Z)</span>
                  <span className={passwordStrength.lower ? "rule-ok" : "rule-fail"}>✓ Строчная буква (а-я, a-z)</span>
                  <span className={passwordStrength.digit ? "rule-ok" : "rule-fail"}>✓ Цифра (0–9)</span>
                </div>
              )}
            </div>
            <div className="invite-gate-field">
              <label className="invite-gate-label">Подтвердите пароль</label>
              <div className="invite-gate-input-wrapper">
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Повторите пароль"
                  className="invite-gate-input"
                  disabled={loading}
                />
              </div>
            </div>
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={!passwordValid || !passwordsMatch || !confirmPassword || loading} className="invite-gate-submit">
              {loading ? "Сохранение..." : "Установить пароль"}
            </button>
          </form>
        )}

        {/* ── 2FA OTP (Telegram or SMS) ── */}
        {step === "2fa-otp" && (
          <form onSubmit={handleOtpSubmit} className="invite-gate-form">
            <p className="invite-gate-register-hint">
              {twoFaMethod === "telegram"
                ? "Введите 6-значный код из Telegram"
                : "Введите 6-значный код из SMS"}
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otpInput}
              onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="______"
              className="invite-gate-input invite-gate-otp-input"
              disabled={loading}
              autoFocus
            />
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={otpInput.length !== 6 || loading} className="invite-gate-submit">
              {loading ? "Проверка..." : "Подтвердить"}
            </button>
            <button
              type="button"
              onClick={() => { setOtpInput(""); setError(""); sendOtp(twoFaMethod as "telegram" | "sms"); }}
              disabled={otpResendSeconds > 0 || loading}
              className="invite-gate-back"
            >
              {otpResendSeconds > 0 ? `Отправить повторно (${otpResendSeconds}с)` : "Отправить код повторно"}
            </button>
          </form>
        )}

        {/* ── 2FA TOTP (authenticator app) ── */}
        {step === "2fa-totp" && (
          <form onSubmit={handleOtpSubmit} className="invite-gate-form">
            <p className="invite-gate-register-hint">
              Введите 6-значный код из приложения-аутентификатора (Google Authenticator, Яндекс Ключ, Authy)
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={otpInput}
              onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="______"
              className="invite-gate-input invite-gate-otp-input"
              disabled={loading}
              autoFocus
            />
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={otpInput.length !== 6 || loading} className="invite-gate-submit">
              {loading ? "Проверка..." : "Подтвердить"}
            </button>
          </form>
        )}

        {/* ── Setup 2FA suggestion ── */}
        {step === "setup-2fa" && (
          <div className="invite-gate-form">
            <div className="invite-gate-2fa-banner">
              <span className="invite-gate-2fa-icon">🔐</span>
              <p className="invite-gate-2fa-title">Настройте двухфакторную аутентификацию</p>
              <p className="invite-gate-2fa-desc">
                Это защитит ваш аккаунт от несанкционированного доступа. Рекомендуем настроить сейчас.
              </p>
            </div>
            <button onClick={handleSetupTotp} disabled={loading} className="invite-gate-submit">
              {loading ? "Загрузка..." : "Настроить приложение-аутентификатор"}
            </button>
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="button" onClick={handleSkip2FA} className="invite-gate-back" disabled={loading}>
              Напомнить при следующем входе
            </button>
          </div>
        )}

        {/* ── TOTP QR setup ── */}
        {step === "setup-totp-qr" && (
          <form onSubmit={handleConfirmTotp} className="invite-gate-form">
            <p className="invite-gate-register-hint">
              Отсканируйте QR-код в Google Authenticator, Яндекс Ключе или Authy, затем введите код из приложения
            </p>
            {totpOtpauthUrl && (
              <div className="invite-gate-qr">
                <QRCodeSVG value={totpOtpauthUrl} size={180} />
              </div>
            )}
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={totpConfirmOtp}
              onChange={(e) => setTotpConfirmOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="______"
              className="invite-gate-input invite-gate-otp-input"
              disabled={loading}
              autoFocus
            />
            {error && <p className="invite-gate-error">{error}</p>}
            <button type="submit" disabled={totpConfirmOtp.length !== 6 || loading} className="invite-gate-submit">
              {loading ? "Сохранение..." : "Подтвердить"}
            </button>
            <button type="button" onClick={() => { setStep("setup-2fa"); setError(""); }} className="invite-gate-back" disabled={loading}>
              Назад
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
