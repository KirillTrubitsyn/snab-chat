"use client";

import { useState, useCallback, useEffect } from "react";
import { apiUrl } from "@/app/lib/api";
import { formatDateTime } from "@/app/lib/date-utils";
import { CATEGORY_LABELS } from "./constants";
import type { NontargetItem } from "./types";

export default function NontargetTab({ adminCode }: { adminCode: string }) {
  const [queries, setQueries] = useState<NontargetItem[]>([]);
  const [stats, setStats] = useState<{ total: number; by_category: Record<string, number>; by_user: Record<string, { count: number; lastQuery: string; lastDate: string }> }>({ total: 0, by_category: {}, by_user: {} });
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(7);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/off-topic?days=${days}`), { headers });
      const data = await res.json();
      if (data.queries) setQueries(data.queries);
      if (data.stats) setStats(data.stats);
    } catch { /* ignore */ }
    setLoading(false);
  }, [adminCode, days]);

  useEffect(() => { load(); }, [load]);

  const deleteQuery = async (id: string) => {
    try {
      await fetch(apiUrl(`/api/admin/off-topic?id=${id}`), { method: "DELETE", headers });
      setQueries((prev) => prev.filter((q) => q.id !== id));
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
    } catch { /* ignore */ }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const toggleAll = () => {
    if (selectedIds.size === queries.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(queries.map((q) => q.id)));
  };

  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Удалить ${selectedIds.size} нецелевых запросов?`)) return;
    setDeleting(true);
    try {
      await Promise.all(Array.from(selectedIds).map((id) => fetch(apiUrl(`/api/admin/off-topic?id=${id}`), { method: "DELETE", headers })));
      setSelectedIds(new Set());
      load();
    } catch { /* ignore */ }
    setDeleting(false);
  };

  return (
    <div>
      <div className="admin-card">
        <div className="admin-card-header">
          <div className="admin-card-header-left">
            <h3 className="admin-card-title">Нецелевые запросы</h3>
            <span className="admin-card-badge">{stats.total}</span>
          </div>
          <div className="admin-card-actions">
            {[1, 7, 30, 90].map((d) => (
              <button key={d} className={`admin-btn-secondary ${days === d ? "admin-btn-active" : ""}`} onClick={() => setDays(d)}>
                {d === 1 ? "Сегодня" : `${d} дн`}
              </button>
            ))}
            <button className="admin-btn-secondary" onClick={load} disabled={loading}>
              <span className="material-symbols-outlined">refresh</span>
            </button>
          </div>
        </div>
        {Object.keys(stats.by_category).length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 16px 16px" }}>
            {Object.entries(stats.by_category).sort(([, a], [, b]) => b - a).map(([cat, count]) => (
              <span key={cat} className="admin-code-badge" style={{ fontSize: 12 }}>{CATEGORY_LABELS[cat] ?? cat}: {count}</span>
            ))}
          </div>
        )}
      </div>

      <div className="admin-card admin-card-table">
        {selectedIds.size > 0 && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border, #E2E8F0)", display: "flex", alignItems: "center", gap: 12 }}>
            <button className="admin-btn-danger" onClick={deleteSelected} disabled={deleting}>
              <span className="material-symbols-outlined">delete</span>
              {deleting ? "Удаление..." : `Удалить (${selectedIds.size})`}
            </button>
          </div>
        )}
        {loading ? (
          <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
        ) : queries.length === 0 ? (
          <div className="admin-empty">
            <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>block</span>
            <p>Нет нецелевых запросов за этот период</p>
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}><input type="checkbox" checked={selectedIds.size === queries.length && queries.length > 0} onChange={toggleAll} /></th>
                  <th style={{ width: "13%" }}>ФИО</th>
                  <th style={{ width: "12%" }}>Организация</th>
                  <th style={{ width: "15%" }}>Категория</th>
                  <th>Запрос</th>
                  <th style={{ width: "10%" }}>Время</th>
                  <th style={{ width: 60, textAlign: "right" }}></th>
                </tr>
              </thead>
              <tbody>
                {queries.map((q) => (
                  <tr key={q.id} className={selectedIds.has(q.id) ? "admin-row-selected" : ""}>
                    <td><input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => toggleSelection(q.id)} /></td>
                    <td className="admin-cell-name">{q.user_name}</td>
                    <td>{q.organization || <span className="admin-text-muted">—</span>}</td>
                    <td><span className="admin-code-badge" style={{ fontSize: 11 }}>{CATEGORY_LABELS[q.category] ?? q.category}</span></td>
                    <td className="admin-cell-message">{q.query_text}</td>
                    <td className="admin-cell-date">{formatDateTime(q.created_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="admin-btn-icon-danger" onClick={() => deleteQuery(q.id)} title="Удалить">
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
