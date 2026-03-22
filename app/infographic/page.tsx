"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const STYLES = [
  { key: "business_infographic", label: "Деловая инфографика", icon: "📊" },
  { key: "process_timeline", label: "Таймлайн процесса", icon: "📅" },
  { key: "comparison_chart", label: "Сравнительная таблица", icon: "⚖️" },
  { key: "statistics_dashboard", label: "Дашборд статистики", icon: "📈" },
  { key: "process_flowchart", label: "Блок-схема процесса", icon: "🔀" },
  { key: "hierarchy_orgchart", label: "Оргструктура", icon: "🏢" },
  { key: "mindmap", label: "Интеллект-карта", icon: "🧠" },
  { key: "procedure_summary", label: "Резюме процедуры", icon: "📋" },
];

const ASPECT_RATIOS = [
  { key: "16:9", label: "16:9", desc: "Горизонтальная" },
  { key: "1:1", label: "1:1", desc: "Квадрат" },
  { key: "9:16", label: "9:16", desc: "Вертикальная" },
];

export default function InfographicPage() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("business_infographic");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [documentText, setDocumentText] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [generating, setGenerating] = useState(false);
  const [savedToHistory, setSavedToHistory] = useState(false);
  const [resultImage, setResultImage] = useState("");
  const [resultDescription, setResultDescription] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const ctx = sessionStorage.getItem("infographic_context");
    if (ctx) {
      try {
        const parsed = JSON.parse(ctx);
        if (parsed.documentText) setDocumentText(parsed.documentText);
        if (parsed.conversationId) setConversationId(parsed.conversationId);
        if (parsed.topic) setTopic(parsed.topic);
      } catch {
        setDocumentText(ctx);
      }
      sessionStorage.removeItem("infographic_context");
    }
  }, []);

  const handleGenerate = async () => {
    if (!topic.trim() || topic.trim().length < 3) {
      setError("Введите тему (минимум 3 символа)");
      return;
    }
    setGenerating(true);
    setError("");
    setResultImage("");
    setResultDescription("");

    try {
      const res = await fetch("/api/infographic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          style,
          aspectRatio,
          documentText,
          conversationId: conversationId || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Ошибка генерации");
        return;
      }

      setResultImage(data.image_base64);
      setResultDescription(data.description || "");
      if (data.conversationId) setSavedToHistory(true);
    } catch {
      setError("Ошибка сети. Попробуйте ещё раз.");
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!resultImage) return;
    const link = document.createElement("a");
    link.href = resultImage;
    link.download = `infographic-${Date.now()}.png`;
    link.click();
  };

  return (
    <div className="infographic-page">
      {/* Header */}
      <header className="infographic-header">
        <button className="infographic-back-btn" onClick={() => router.push("/")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Назад в чат
        </button>
        <div className="infographic-header-title">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          <span>Генератор инфографики</span>
        </div>
      </header>

      <div className="infographic-body">
        {/* Result overlay */}
        {resultImage && (
          <div className="infographic-result">
            <div className="infographic-result-card">
              <img
                src={resultImage}
                alt={topic}
                className="infographic-result-image"
              />
              {resultDescription && (
                <p className="infographic-result-desc">{resultDescription}</p>
              )}
              {savedToHistory && (
                <div className="infographic-saved-badge">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Сохранено в истории диалога
                </div>
              )}
              <div className="infographic-result-actions">
                <button className="infographic-btn primary" onClick={handleDownload}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Скачать PNG
                </button>
                {savedToHistory && (
                  <button className="infographic-btn primary" onClick={() => router.push("/")}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Вернуться в чат
                  </button>
                )}
                <button
                  className="infographic-btn secondary"
                  onClick={() => {
                    setResultImage("");
                    setResultDescription("");
                    setSavedToHistory(false);
                  }}
                >
                  Создать ещё
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Form */}
        {!resultImage && (
          <div className="infographic-form">
            <div className="infographic-form-card">
              <h2 className="infographic-form-title">Создать инфографику</h2>

              {/* Topic */}
              <div className="infographic-field">
                <label className="infographic-label">Тема инфографики</label>
                <textarea
                  className="infographic-textarea"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Например: Этапы проведения конкурентной закупки"
                  rows={3}
                />
              </div>

              {/* Context indicator */}
              {documentText && (
                <div className="infographic-context-badge">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Контекст из ответа ассистента загружен
                </div>
              )}

              {/* Style */}
              <div className="infographic-field">
                <label className="infographic-label">Стиль</label>
                <div className="infographic-styles-grid">
                  {STYLES.map((s) => (
                    <button
                      key={s.key}
                      className={`infographic-style-btn ${style === s.key ? "active" : ""}`}
                      onClick={() => setStyle(s.key)}
                    >
                      <span className="infographic-style-icon">{s.icon}</span>
                      <span className="infographic-style-label">{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Aspect ratio */}
              <div className="infographic-field">
                <label className="infographic-label">Соотношение сторон</label>
                <div className="infographic-ratio-group">
                  {ASPECT_RATIOS.map((ar) => (
                    <button
                      key={ar.key}
                      className={`infographic-ratio-btn ${aspectRatio === ar.key ? "active" : ""}`}
                      onClick={() => setAspectRatio(ar.key)}
                    >
                      <span className="infographic-ratio-value">{ar.label}</span>
                      <span className="infographic-ratio-desc">{ar.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Error */}
              {error && <div className="infographic-error">{error}</div>}

              {/* Generate button */}
              <button
                className="infographic-btn primary full"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? (
                  <>
                    <div className="infographic-spinner" />
                    Генерация... (30–60 сек)
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <line x1="3" y1="9" x2="21" y2="9" />
                      <line x1="9" y1="21" x2="9" y2="9" />
                    </svg>
                    Создать инфографику
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
