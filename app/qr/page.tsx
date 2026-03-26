"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function QRPage() {
  const [url, setUrl] = useState(() => {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "";
  });

  return (
    <div className="qr-page">
      <div className="qr-card">
        <div className="qr-logo">
          <svg width="56" height="56" viewBox="0 0 512 512" fill="none">
            <rect width="512" height="512" rx="112" fill="#F0F4FA" />
            <rect x="120" y="100" width="200" height="260" rx="28" fill="#0D47A1" />
            <rect x="160" y="140" width="200" height="260" rx="28" fill="#1976D2" />
            <rect x="200" y="180" width="200" height="260" rx="28" fill="#42A5F5" />
            <rect x="328" y="368" width="52" height="40" rx="12" fill="#fff" />
            <polygon points="338,408 328,424 348,408" fill="#fff" />
          </svg>
        </div>
        <h1 className="qr-title">СнабЧат</h1>
        <p className="qr-subtitle">ИИ-ассистент Дирекции по закупкам</p>

        <div className="qr-code-wrapper">
          {url && (
            <QRCodeSVG
              value={url}
              size={280}
              level="H"
              bgColor="#FFFFFF"
              fgColor="#0D47A1"
              includeMargin={false}
            />
          )}
        </div>

        <p className="qr-hint">
          Отсканируйте QR-код камерой телефона
        </p>
        <p className="qr-hint-secondary">
          Одноразовый пароль для входа: <strong>СГК</strong>
        </p>

        <div className="qr-url-edit">
          <label className="qr-url-label">URL приложения:</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="qr-url-input"
            placeholder="https://your-app.vercel.app"
          />
        </div>
      </div>
    </div>
  );
}
