"use client";

import { useState, useCallback, useEffect } from "react";
import { formatDateTime } from "@/app/lib/date-utils";
import type { ActivityItem } from "./types";

type DateFilter = "today" | "7days" | "30days" | "all";

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7days", label: "7 дней" },
  { key: "30days", label: "30 дней" },
  { key: "all", label: "Все время" },
];

function filterByDate(items: ActivityItem[], filter: DateFilter): ActivityItem[] {
  if (filter === "all") return items;
  const now = new Date();
  const cutoff = new Date();
  if (filter === "today") cutoff.setHours(0, 0, 0, 0);
  else if (filter === "7days") cutoff.setDate(now.getDate() - 7);
  else if (filter === "30days") cutoff.setDate(now.getDate() - 30);
  return items.filter((a) => new Date(a.created_at) >= cutoff);
}

export default function ActivityTab({ adminCode }: { adminCode: string }) {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>("today");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await fetch("/api/admin/activity", { headers });
      const data = await res.json();
      if (data.activity) setActivity(data.activity);
    } catch { /* ignore */ }
    setActivityLoading(false);
  }, [adminCode]);

  const filteredActivity = filterByDate(activity, dateFilter);

  useEffect(() => { loadActivity(); }, [loadActivity]);

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === filteredActivity.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredActivity.map((a) => a.id)));
  };

  const deleteSelected = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Удалить ${selectedIds.size} записей?`)) return;
    setDeleting(true);
    try {
      const ids = Array.from(selectedIds).join(",");
      await fetch(`/api/admin/activity?type=messages&ids=${ids}`, { method: "DELETE", headers });
      setSelectedIds(new Set());
      loadActivity();
    } catch { /* ignore */ }
    setDeleting(false);
  };

  const deleteSingle = async (id: string) => {
    try {
      await fetch(`/api/admin/activity?type=messages&ids=${id}`, { method: "DELETE", headers });
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      loadActivity();
    } catch { /* ignore */ }
  };

  const cleanupOrphaned = async () => {
    if (!confirm("Удалить все диалоги без привязки к инвайт-коду?")) return;
    try {
      const res = await fetch("/api/admin/activity", { method: "DELETE", headers });
      const data = await res.json();
      alert(`Удалено диалогов: ${data.deleted || 0}`);
      loadActivity();
    } catch { /* ignore */ }
  };

  return (
    <div>
      <div className="admin-card admin-card-table">
        <div className="admin-card-header">
          <div className="admin-card-header-left">
            <h3 className="admin-card-title">Запросы пользователей</h3>
            <span className="admin-card-badge">{filteredActivity.length}</span>
          </div>
          <div className="admin-card-actions">
            {selectedIds.size > 0 && (
              <button className="admin-btn-danger" onClick={deleteSelected} disabled={deleting}>
                <span className="material-symbols-outlined">delete</span>
                {deleting ? "Удаление..." : `Удалить (${selectedIds.size})`}
              </button>
            )}
            <button className="admin-btn-secondary" onClick={cleanupOrphaned}>
              <span className="material-symbols-outlined">delete_sweep</span>
              Очистить старые
            </button>
            <button className="admin-btn-secondary" onClick={loadActivity} disabled={activityLoading}>
              <span className="material-symbols-outlined">refresh</span>
              Обновить
            </button>
          </div>
        </div>

        {/* Date filter pills */}
        <div className="admin-doc-pills" style={{ marginBottom: 0 }}>
          {DATE_FILTERS.map((f) => (
            <button key={f.key} className={`admin-doc-pill ${dateFilter === f.key ? "active" : ""}`} onClick={() => { setDateFilter(f.key); setSelectedIds(new Set()); }}>
              {f.label}
            </button>
          ))}
        </div>

        {activityLoading ? (
          <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
        ) : filteredActivity.length === 0 ? (
          <div className="admin-empty">Нет активности</div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input type="checkbox" checked={selectedIds.size === filteredActivity.length && filteredActivity.length > 0} onChange={toggleAll} />
                  </th>
                  <th>ФИО</th><th>Организация</th><th>Тип</th><th>Запрос</th>
                  <th style={{ textAlign: "center" }}>Модель</th>
                  <th style={{ textAlign: "right" }}>Время</th>
                  <th style={{ width: 60, textAlign: "right" }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredActivity.map((a) => (
                  <tr key={a.id} className={selectedIds.has(a.id) ? "admin-row-selected" : ""}>
                    <td><input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleSelection(a.id)} /></td>
                    <td className="admin-cell-name">{a.user_name}</td>
                    <td className="admin-cell-name">{a.organization || <span className="admin-text-muted">—</span>}</td>
                    <td>
                      <span className={`admin-status ${a.type === "chat" ? "active" : "infographic"}`}>
                        {a.type === "chat" ? "Чат" : "Инфографика"}
                      </span>
                    </td>
                    <td
                      className={`admin-cell-title${expandedId === a.id ? " admin-cell-expanded" : ""}`}
                      onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                      style={{ cursor: "pointer" }}
                    >
                      {expandedId === a.id
                        ? a.content
                        : a.content.length > 120
                          ? a.content.slice(0, 120) + "…"
                          : a.content}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {a.model ? (
                        <span className={`admin-model-badge ${a.model.includes("pro") ? "admin-model-pro" : "admin-model-flash"}`}>
                          {a.model.includes("pro") ? "Pro" : "Flash"}
                        </span>
                      ) : (
                        <span className="admin-text-muted">—</span>
                      )}
                    </td>
                    <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(a.created_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="admin-btn-icon-danger" onClick={() => deleteSingle(a.id)} title="Удалить">
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
