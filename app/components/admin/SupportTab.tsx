"use client";

import { useState, useCallback, useEffect } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";
import { formatDateTime } from "@/app/lib/date-utils";
import type { SupportItem } from "./types";

export default function SupportTab({ adminCode }: { adminCode: string }) {
  const [messages, setMessages] = useState<SupportItem[]>([]);
  const [stats, setStats] = useState({ total: 0, open: 0, answered: 0, closed: 0 });
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);

  const headers = getAdminHeaders(adminCode);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = filter ? apiUrl(`/api/admin/support?status=${filter}`) : apiUrl("/api/admin/support");
      const res = await fetch(url, { headers });
      const data = await res.json();
      if (data.messages) setMessages(data.messages);
      if (data.stats) setStats(data.stats);
    } catch { /* ignore */ }
    setLoading(false);
  }, [adminCode, filter]);

  useEffect(() => { load(); }, [load]);

  const reply = async (id: string) => {
    if (!replyText.trim()) return;
    setReplySending(true);
    try {
      await fetch(apiUrl("/api/admin/support"), {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: replyText.trim() }),
      });
      setReplyingTo(null);
      setReplyText("");
      load();
    } catch { /* ignore */ }
    setReplySending(false);
  };

  const deleteMessage = async (id: string) => {
    if (!confirm("Удалить это обращение?")) return;
    try {
      await fetch(apiUrl(`/api/admin/support?id=${id}`), { method: "DELETE", headers });
      load();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        {[
          { label: "Открытые", value: stats.open, color: "#e67700" },
          { label: "Отвечено", value: stats.answered, color: "#2f9e44" },
          { label: "Закрытые", value: stats.closed, color: "#868e96" },
        ].map((s) => (
          <div key={s.label} className="admin-card" style={{ flex: 1, textAlign: "center", padding: 16 }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div className="admin-card admin-card-table">
        <div className="admin-card-header">
          <div className="admin-card-header-left">
            <h3 className="admin-card-title">Обращения</h3>
          </div>
          <div className="admin-card-actions">
            {["", "open", "answered", "closed"].map((f) => (
              <button key={f} className={`admin-btn-secondary ${filter === f ? "admin-btn-active" : ""}`} onClick={() => setFilter(f)}>
                {f === "" ? "Все" : f === "open" ? "Открытые" : f === "answered" ? "Отвечено" : "Закрытые"}
              </button>
            ))}
            <button className="admin-btn-secondary" onClick={load} disabled={loading}>
              <span className="material-symbols-outlined">refresh</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
        ) : messages.length === 0 ? (
          <div className="admin-empty">
            <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>headset_mic</span>
            <p>Нет обращений</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
            {messages.map((m) => (
              <div key={m.id} className="admin-card" style={{ padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <strong>{m.user_name}</strong>
                    {m.organization && <span className="admin-text-muted"> · {m.organization}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className={`admin-status ${m.status === "open" ? "active" : m.status === "answered" ? "" : "inactive"}`}>
                      {m.status === "open" ? "Открыто" : m.status === "answered" ? "Отвечено" : "Закрыто"}
                    </span>
                    <span className="admin-cell-date">{formatDateTime(m.created_at)}</span>
                  </div>
                </div>
                <div style={{ background: "var(--bg-secondary, #f5f5f5)", borderRadius: 8, padding: 12, marginBottom: 8 }}>{m.message}</div>
                {m.admin_reply && (
                  <div style={{ background: "#e8f4fd", borderRadius: 8, padding: 12, marginBottom: 8, borderLeft: "3px solid #1976d2" }}>
                    <div style={{ fontSize: 12, color: "#1976d2", marginBottom: 4 }}>
                      Ответ администратора{m.admin_number !== null ? ` №${m.admin_number}` : ""}{m.replied_at ? ` · ${formatDateTime(m.replied_at)}` : ""}
                    </div>
                    {m.admin_reply}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  {!m.admin_reply && replyingTo !== m.id && (
                    <button className="admin-btn-primary" onClick={() => { setReplyingTo(m.id); setReplyText(""); }}>Ответить</button>
                  )}
                  {replyingTo === m.id && (
                    <div style={{ flex: 1 }}>
                      <textarea className="admin-textarea" value={replyText} onChange={(e) => setReplyText(e.target.value)} placeholder="Введите ответ..." rows={3} style={{ width: "100%", marginBottom: 8 }} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button className="admin-btn-primary" onClick={() => reply(m.id)} disabled={replySending || !replyText.trim()}>
                          {replySending ? "Отправка..." : "Отправить"}
                        </button>
                        <button className="admin-btn-secondary" onClick={() => setReplyingTo(null)}>Отмена</button>
                      </div>
                    </div>
                  )}
                  <button className="admin-action-link admin-action-danger" onClick={() => deleteMessage(m.id)} title="Удалить">
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
