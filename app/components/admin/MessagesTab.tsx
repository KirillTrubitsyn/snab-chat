"use client";

import { useState, useCallback, useEffect } from "react";
import { formatDateTime } from "@/app/lib/date-utils";
import type { UserMessageItem } from "./types";

export default function MessagesTab({ adminCode }: { adminCode: string }) {
  const [messages, setMessages] = useState<UserMessageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/activity?type=messages", { headers });
      const data = await res.json();
      if (data.messages) setMessages(data.messages);
    } catch { /* ignore */ }
    setLoading(false);
  }, [adminCode]);

  useEffect(() => { load(); }, [load]);

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const toggleAll = () => {
    if (selectedIds.size === messages.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(messages.map((m) => m.id)));
  };

  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Удалить ${selectedIds.size} сообщений?`)) return;
    setDeleting(true);
    try {
      const ids = Array.from(selectedIds).join(",");
      await fetch(`/api/admin/activity?type=messages&ids=${ids}`, { method: "DELETE", headers });
      setSelectedIds(new Set());
      load();
    } catch { /* ignore */ }
    setDeleting(false);
  };

  const deleteSingle = async (id: string) => {
    if (!confirm("Удалить это сообщение?")) return;
    try {
      await fetch(`/api/admin/activity?type=messages&ids=${id}`, { method: "DELETE", headers });
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      load();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <div className="admin-card admin-card-table">
        <div className="admin-card-header">
          <div className="admin-card-header-left">
            <h3 className="admin-card-title">Сообщения пользователей</h3>
            <span className="admin-card-badge">{messages.length}</span>
          </div>
          <div className="admin-card-actions">
            {selectedIds.size > 0 && (
              <button className="admin-btn-danger" onClick={deleteSelected} disabled={deleting}>
                <span className="material-symbols-outlined">delete</span>
                {deleting ? "Удаление..." : `Удалить (${selectedIds.size})`}
              </button>
            )}
            <button className="admin-btn-secondary" onClick={load} disabled={loading}>
              <span className="material-symbols-outlined">refresh</span>Обновить
            </button>
          </div>
        </div>

        {loading ? (
          <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
        ) : messages.length === 0 ? (
          <div className="admin-empty">
            <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>forum</span>
            <p>Нет сообщений</p>
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input type="checkbox" checked={selectedIds.size === messages.length && messages.length > 0} onChange={toggleAll} />
                  </th>
                  <th style={{ width: "14%" }}>ФИО</th>
                  <th style={{ width: "13%" }}>Организация</th>
                  <th>Сообщение</th>
                  <th style={{ width: "9%", textAlign: "center" }}>Модель</th>
                  <th style={{ width: "12%", textAlign: "right" }}>Время</th>
                  <th style={{ width: 60, textAlign: "right" }}></th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id} className={selectedIds.has(m.id) ? "admin-row-selected" : ""}>
                    <td><input type="checkbox" checked={selectedIds.has(m.id)} onChange={() => toggleSelection(m.id)} /></td>
                    <td className="admin-cell-name">{m.user_name}</td>
                    <td>{m.organization || <span className="admin-text-muted">—</span>}</td>
                    <td className="admin-cell-message">{m.content}</td>
                    <td style={{ textAlign: "center" }}>
                      {m.model ? (
                        <span className={`admin-model-badge ${m.model.includes("pro") ? "admin-model-pro" : "admin-model-flash"}`}>
                          {m.model.includes("pro") ? "Pro" : "Flash"}
                        </span>
                      ) : (
                        <span className="admin-text-muted">—</span>
                      )}
                    </td>
                    <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(m.created_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="admin-btn-icon-danger" onClick={() => deleteSingle(m.id)} title="Удалить сообщение">
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
