"use client";

import { useState, useCallback, useEffect } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";
import { formatDateTime } from "@/app/lib/date-utils";
import { ERROR_TYPE_LABELS } from "./constants";
import type { ErrorItem } from "./types";

export default function ErrorsTab({ adminCode }: { adminCode: string }) {
  const [errors, setErrors] = useState<ErrorItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(7);
  const [typeFilter, setTypeFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const headers = getAdminHeaders(adminCode);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/errors?days=${days}&type=${typeFilter}`), { headers });
      const data = await res.json();
      if (data.errors) setErrors(data.errors);
    } catch { /* ignore */ }
    setLoading(false);
  }, [adminCode, days, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const deleteError = async (id: string) => {
    try {
      await fetch(apiUrl(`/api/admin/errors?id=${id}`), { method: "DELETE", headers });
      setErrors((prev) => prev.filter((e) => e.id !== id));
    } catch { /* ignore */ }
  };

  return (
    <div>
      <div className="admin-card admin-card-table">
        <div className="admin-card-header">
          <div className="admin-card-header-left">
            <h3 className="admin-card-title">Ошибки</h3>
            <span className="admin-card-badge">{errors.length}</span>
          </div>
          <div className="admin-card-actions">
            {[1, 7, 30, 90].map((d) => (
              <button key={d} className={`admin-btn-secondary ${days === d ? "admin-btn-active" : ""}`} onClick={() => setDays(d)}>
                {d === 1 ? "Сегодня" : `${d} дн`}
              </button>
            ))}
            <span style={{ width: 1, background: "var(--border-color, #e0e0e0)", alignSelf: "stretch" }} />
            {["all", "chat", "parse", "ingest", "client"].map((t) => (
              <button key={t} className={`admin-btn-secondary ${typeFilter === t ? "admin-btn-active" : ""}`} onClick={() => setTypeFilter(t)}>
                {t === "all" ? "Все" : ERROR_TYPE_LABELS[t] ?? t}
              </button>
            ))}
            <button className="admin-btn-secondary" onClick={load} disabled={loading}>
              <span className="material-symbols-outlined">refresh</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
        ) : errors.length === 0 ? (
          <div className="admin-empty">
            <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>check_circle</span>
            <p>Нет ошибок за этот период</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
            {errors.map((e) => (
              <div key={e.id} className="admin-card" style={{ padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="admin-code-badge" style={{
                      fontSize: 11,
                      background: e.error_type === "chat" ? "#fff3bf" : e.error_type === "client" ? "#ffe8cc" : e.error_type === "parse" ? "#d3f9d8" : "#e7f5ff",
                    }}>
                      {ERROR_TYPE_LABELS[e.error_type] ?? e.error_type}
                    </span>
                    {e.user_name && <span style={{ fontSize: 13 }}>{e.user_name}</span>}
                    {e.endpoint && <span className="admin-text-muted" style={{ fontSize: 12 }}>{e.endpoint}</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="admin-cell-date">{formatDateTime(e.created_at)}</span>
                    <button className="admin-action-link admin-action-danger" onClick={() => deleteError(e.id)} title="Удалить">
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    whiteSpace: expanded.has(e.id) ? "pre-wrap" : "nowrap",
                    overflow: expanded.has(e.id) ? "visible" : "hidden",
                    textOverflow: "ellipsis",
                  }}
                  onClick={() => setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
                    return next;
                  })}
                >
                  {e.error_message}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
