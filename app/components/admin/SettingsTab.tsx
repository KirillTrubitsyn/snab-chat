"use client";

import { useEffect, useState } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";

interface EvalRun {
  id: number;
  run_at: string;
  total_chunks: number;
  entity_f1: number | null;
  entity_precision: number | null;
  entity_recall: number | null;
  relation_f1: number | null;
  notes: string | null;
  gold_model: string | null;
  metrics: {
    domains?: Record<string, { entities: { f1: number | null }; relations: { f1: number | null }; chunks: number }>;
  } | null;
}

interface DiagEntityReport {
  id: number;
  name: string;
  canonicalName: string;
  entityType: string;
  chunkCount: number;
  linkedFiles: string[];
  authorityMatrixChunks: number;
  outgoing: Array<{ type: string; confidence: number | null; target: string; targetType: string }>;
  incoming: Array<{ type: string; confidence: number | null; source: string; sourceType: string }>;
}

interface DiagResponse {
  query: string;
  entitiesFound: number;
  entityReports: DiagEntityReport[];
  filenameSources: Array<{ id: number; filename: string; tags: string[]; folderPath: string | null; isAuthorityMatrix: boolean }>;
  diagnosis: string[];
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return (v * 100).toFixed(1) + "%";
}

export default function SettingsTab({ adminCode }: { adminCode: string }) {
  const [webhookStatus, setWebhookStatus] = useState<string | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [test2FAStatus, setTest2FAStatus] = useState<string | null>(null);
  const [test2FALoading, setTest2FALoading] = useState(false);

  // ── RAG diagnostics state ──
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [goldSize, setGoldSize] = useState<number>(0);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalResult, setEvalResult] = useState<string | null>(null);
  const [seedRunning, setSeedRunning] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [diagQuery, setDiagQuery] = useState("");
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResp, setDiagResp] = useState<DiagResponse | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const headers = getAdminHeaders(adminCode);

  // kg-eval / rag-diagnostics / kg-eval/seed-gold живут ТОЛЬКО в Next.js
  // app/api (server-only доступ к Supabase + Google AI). apiUrl() уводит
  // запросы на Railway backend, где этих маршрутов нет — поэтому ходим
  // same-origin относительными путями.
  const loadRuns = async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await fetch("/api/admin/kg-eval?limit=20", { headers });
      const data = await res.json();
      if (!res.ok) {
        setRunsError(data.error || "Ошибка загрузки");
        return;
      }
      setRuns(data.runs ?? []);
      setGoldSize(data.goldDatasetSize ?? 0);
    } catch {
      setRunsError("Сетевая ошибка");
    } finally {
      setRunsLoading(false);
    }
  };

  useEffect(() => {
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runEval = async () => {
    setEvalRunning(true);
    setEvalResult(null);
    try {
      const res = await fetch("/api/admin/kg-eval", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50, notes: "Запуск из админки" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEvalResult(`❌ ${data.error || "Ошибка прогона"}`);
        return;
      }
      if (data.totalChunks === 0) {
        setEvalResult(
          `⚠️ Золотой датасет пуст (${data.message || "kg_eval_gold пуст"}). Сначала нажмите «Сгенерировать золотой датасет».`
        );
        return;
      }
      setEvalResult(
        `✅ Прогон завершён. Чанков: ${data.totalChunks}. Entities F1: ${fmt(data.entities?.f1)}, Relations F1: ${fmt(data.relations?.f1)}.`
      );
      await loadRuns();
    } catch {
      setEvalResult("❌ Сетевая ошибка");
    } finally {
      setEvalRunning(false);
    }
  };

  const runSeedGold = async () => {
    setSeedRunning(true);
    setSeedResult(null);
    try {
      const res = await fetch("/api/admin/kg-eval/seed-gold", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ perDomain: 10, notes: "Автогенерация из админки" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSeedResult(`❌ ${data.error || data.message || "Ошибка генерации"}`);
        return;
      }
      const perDomain = (data.stats ?? [])
        .map((s: { domain: string; extracted: number; skipped: number; failed: number }) =>
          `${s.domain}: +${s.extracted} (пропущено ${s.skipped}, ошибок ${s.failed})`
        )
        .join("; ");
      setSeedResult(
        `✅ Добавлено ${data.totalInserted} записей (всего в gold: ${data.goldDatasetSize}). ${perDomain}`
      );
      await loadRuns();
    } catch {
      setSeedResult("❌ Сетевая ошибка");
    } finally {
      setSeedRunning(false);
    }
  };

  const runDiagnose = async () => {
    const q = diagQuery.trim();
    if (!q) return;
    setDiagLoading(true);
    setDiagError(null);
    setDiagResp(null);
    try {
      const res = await fetch("/api/admin/rag-diagnostics", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDiagError(data.error || "Ошибка диагностики");
        return;
      }
      setDiagResp(data as DiagResponse);
    } catch {
      setDiagError("Сетевая ошибка");
    } finally {
      setDiagLoading(false);
    }
  };

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

      {/* ── Диагностика RAG ── */}
      <h2 style={{ marginTop: 32 }}>Диагностика RAG</h2>

      <div className="admin-card" style={{ maxWidth: 860, marginTop: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>История прогонов kg-eval</h3>
        <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 14 }}>
          Precision / Recall / F1 извлечения сущностей и связей. Сравнивайте значения после каждого
          изменения в граф-RAG, чтобы ловить регрессии. Золотой датасет:{" "}
          <strong>{goldSize}</strong> записей.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="admin-btn admin-btn-primary" disabled={runsLoading} onClick={loadRuns}>
            {runsLoading ? "Загрузка..." : "Обновить"}
          </button>
          <button
            className="admin-btn admin-btn-primary"
            disabled={evalRunning || goldSize === 0}
            onClick={runEval}
            title={goldSize === 0 ? "Сначала сгенерируйте золотой датасет" : ""}
          >
            {evalRunning ? "Прогон..." : "Запустить kg-eval (50 чанков)"}
          </button>
          <button className="admin-btn" disabled={seedRunning} onClick={runSeedGold}>
            {seedRunning ? "Генерация..." : goldSize === 0 ? "Сгенерировать золотой датасет" : "Досыпать в датасет"}
          </button>
        </div>
        {goldSize === 0 && (
          <p style={{ marginTop: 12, fontSize: 13, color: "#d97706" }}>
            ⚠️ Золотой датасет пуст. Нажмите «Сгенерировать золотой датасет» — сильная модель
            (gemini-3-pro-preview) разметит ~60 чанков (по 10 на каждый из 6 доменов).
            Занимает несколько минут.
          </p>
        )}
        {evalResult && (
          <p style={{ marginTop: 12, fontSize: 14, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
            {evalResult}
          </p>
        )}
        {seedResult && (
          <p style={{ marginTop: 8, fontSize: 14, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
            {seedResult}
          </p>
        )}
        {runsError && (
          <p style={{ marginTop: 12, fontSize: 14, color: "#dc2626" }}>{runsError}</p>
        )}
        {runs.length > 0 && (
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border, #ddd)" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Дата</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>Чанков</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>Ent F1</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>Ent P/R</th>
                  <th style={{ textAlign: "right", padding: "6px 8px" }}>Rel F1</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>authority_matrix F1</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Эталон</th>
                  <th style={{ textAlign: "left", padding: "6px 8px" }}>Заметка</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const amDomain = r.metrics?.domains?.authority_matrix;
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border-subtle, #eee)" }}>
                      <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                        {new Date(r.run_at).toLocaleString("ru-RU")}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>{r.total_chunks}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>
                        {fmt(r.entity_f1)}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12 }}>
                        {fmt(r.entity_precision)} / {fmt(r.entity_recall)}
                      </td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(r.relation_f1)}</td>
                      <td style={{ padding: "6px 8px" }}>
                        {amDomain
                          ? `ent ${fmt(amDomain.entities.f1)} / rel ${fmt(amDomain.relations.f1)} (${amDomain.chunks} ч.)`
                          : "—"}
                      </td>
                      <td style={{ padding: "6px 8px", fontSize: 12 }}>{r.gold_model || "manual"}</td>
                      <td style={{ padding: "6px 8px", fontSize: 12 }}>{r.notes || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="admin-card" style={{ maxWidth: 860, marginTop: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>Диагностика по организации / запросу</h3>
        <p style={{ margin: "0 0 12px", color: "var(--text-secondary)", fontSize: 14 }}>
          Введите название организации (например, <em>Новомосковская ГРЭС</em>) или фрагмент запроса.
          Покажет: какие сущности знает knowledge graph, сколько чанков к ним привязано, есть ли среди
          них матрица полномочий, какие документы подходят по имени файла. Полезно для разбора жалоб
          на неверные ответы.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Например: Новомосковская ГРЭС"
            value={diagQuery}
            onChange={(e) => setDiagQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !diagLoading) runDiagnose();
            }}
            style={{
              flex: "1 1 260px",
              minWidth: 200,
              padding: "8px 10px",
              border: "1px solid var(--border, #ccc)",
              borderRadius: 6,
              fontSize: 14,
            }}
          />
          <button
            className="admin-btn admin-btn-primary"
            disabled={diagLoading || !diagQuery.trim()}
            onClick={runDiagnose}
          >
            {diagLoading ? "Проверка..." : "Проверить"}
          </button>
        </div>
        {diagError && (
          <p style={{ marginTop: 12, fontSize: 14, color: "#dc2626" }}>{diagError}</p>
        )}
        {diagResp && (
          <div style={{ marginTop: 12, fontSize: 14 }}>
            <p style={{ margin: "0 0 6px" }}>
              <strong>Найдено сущностей:</strong> {diagResp.entitiesFound}
            </p>
            {diagResp.diagnosis.length > 0 && (
              <ul style={{ margin: "0 0 12px 20px", color: "var(--text-secondary)" }}>
                {diagResp.diagnosis.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            {diagResp.entityReports.map((e) => (
              <div
                key={e.id}
                style={{
                  padding: 12,
                  border: "1px solid var(--border-subtle, #eee)",
                  borderRadius: 6,
                  marginBottom: 8,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {e.name}{" "}
                  <span style={{ color: "var(--text-secondary)", fontWeight: 400 }}>
                    ({e.entityType}) · #{e.id}
                  </span>
                </div>
                <div style={{ marginTop: 4, fontSize: 13 }}>
                  Чанков: <strong>{e.chunkCount}</strong>
                  {" · "}
                  Матрица полномочий:{" "}
                  <strong style={{ color: e.authorityMatrixChunks > 0 ? "#059669" : "#dc2626" }}>
                    {e.authorityMatrixChunks}
                  </strong>
                </div>
                {e.linkedFiles.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                    Файлы: {e.linkedFiles.slice(0, 6).join(", ")}
                    {e.linkedFiles.length > 6 ? " …" : ""}
                  </div>
                )}
                {e.outgoing.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: "pointer", fontSize: 12 }}>
                      Исходящие связи ({e.outgoing.length})
                    </summary>
                    <ul style={{ margin: "4px 0 0 20px", fontSize: 12 }}>
                      {e.outgoing.map((r, i) => (
                        <li key={i}>
                          {r.type} → {r.target} ({r.targetType})
                          {r.confidence !== null ? ` · conf ${r.confidence.toFixed(2)}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {e.incoming.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: "pointer", fontSize: 12 }}>
                      Входящие связи ({e.incoming.length})
                    </summary>
                    <ul style={{ margin: "4px 0 0 20px", fontSize: 12 }}>
                      {e.incoming.map((r, i) => (
                        <li key={i}>
                          {r.source} ({r.sourceType}) → {r.type}
                          {r.confidence !== null ? ` · conf ${r.confidence.toFixed(2)}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
            {diagResp.filenameSources.length > 0 && (
              <>
                <p style={{ margin: "12px 0 6px" }}>
                  <strong>Файлы в sources по совпадению имени ({diagResp.filenameSources.length}):</strong>
                </p>
                <ul style={{ margin: "0 0 0 20px", fontSize: 13 }}>
                  {diagResp.filenameSources.map((s) => (
                    <li key={s.id}>
                      {s.filename}
                      {s.isAuthorityMatrix ? " — матрица полномочий ✅" : ""}
                      {s.tags.length > 0 && (
                        <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                          {" · "}
                          {s.tags.slice(0, 5).join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
