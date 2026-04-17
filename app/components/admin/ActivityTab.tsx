"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";
import { formatDateTime } from "@/app/lib/date-utils";
import type { ActivityItem } from "./types";

type DateFilter = "today" | "7days" | "30days" | "all";
type TypeFilter = "all" | "chat" | "infographic" | "document";

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7days", label: "7 дней" },
  { key: "30days", label: "30 дней" },
  { key: "all", label: "Все время" },
];

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "chat", label: "Чат" },
  { key: "infographic", label: "Инфографика" },
  { key: "document", label: "Документы" },
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
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [orgFilter, setOrgFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const headers = getAdminHeaders(adminCode);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const [actRes, uploadsRes] = await Promise.all([
        fetch(apiUrl("/api/admin/activity"), { headers }),
        fetch("/api/admin/chat-uploads", { headers }),
      ]);
      const actData = await actRes.json();
      const uploadsData = await uploadsRes.json().catch(() => ({}));
      const combined: ActivityItem[] = [
        ...(actData.activity || []),
        ...(uploadsData.uploads || []),
      ];
      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setActivity(combined);
    } catch { /* ignore */ }
    setActivityLoading(false);
  }, [adminCode]);

  const orgs = useMemo(
    () => [...new Set(activity.map((a) => a.organization).filter(Boolean))].sort() as string[],
    [activity]
  );

  const hasActiveFilters = searchText !== "" || typeFilter !== "all" || orgFilter !== "";

  const resetFilters = () => {
    setSearchText("");
    setTypeFilter("all");
    setOrgFilter("");
  };

  const filteredActivity = useMemo(() => {
    let items = filterByDate(activity, dateFilter);
    if (typeFilter !== "all") items = items.filter((a) => a.type === typeFilter);
    if (orgFilter) items = items.filter((a) => a.organization === orgFilter);
    if (searchText) {
      const q = searchText.toLowerCase();
      items = items.filter(
        (a) =>
          a.user_name.toLowerCase().includes(q) ||
          (a.organization ?? "").toLowerCase().includes(q) ||
          a.content.toLowerCase().includes(q)
      );
    }
    return items;
  }, [activity, dateFilter, typeFilter, orgFilter, searchText]);

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
      await fetch(apiUrl(`/api/admin/activity?type=messages&ids=${ids}`), { method: "DELETE", headers });
      setSelectedIds(new Set());
      loadActivity();
    } catch { /* ignore */ }
    setDeleting(false);
  };

  const deleteSingle = async (id: string) => {
    try {
      await fetch(apiUrl(`/api/admin/activity?type=messages&ids=${id}`), { method: "DELETE", headers });
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      loadActivity();
    } catch { /* ignore */ }
  };

  const cleanupOrphaned = async () => {
    if (!confirm("Удалить все диалоги без привязки к инвайт-коду?")) return;
    try {
      const res = await fetch(apiUrl("/api/admin/activity?type=orphaned"), { method: "DELETE", headers });
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
            <div className="admin-form-field admin-search-field">
              <input
                placeholder="Поиск по имени, организации, запросу..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            </div>
            {orgs.length > 0 && (
              <select
                value={orgFilter}
                onChange={(e) => setOrgFilter(e.target.value)}
                style={{ height: 36, fontSize: 13, padding: "0 8px", border: "1px solid #E2E8F0", borderRadius: 6, background: "#fff", color: "#0F172A", cursor: "pointer" }}
              >
                <option value="">Все организации</option>
                {orgs.map((org) => <option key={org} value={org}>{org}</option>)}
              </select>
            )}
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

        {/* Filters */}
        <div style={{ padding: "8px 24px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #E2E8F0", background: "#fff" }}>
          <div className="admin-doc-pills">
            {DATE_FILTERS.map((f) => (
              <button key={f.key} className={`admin-doc-pill ${dateFilter === f.key ? "active" : ""}`} onClick={() => { setDateFilter(f.key); setSelectedIds(new Set()); }}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="admin-doc-pills">
            {TYPE_FILTERS.map((f) => (
              <button key={f.key} className={`admin-doc-pill ${typeFilter === f.key ? "active" : ""}`} onClick={() => setTypeFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          {hasActiveFilters && (
            <button className="admin-action-link" onClick={resetFilters} style={{ fontSize: 13 }}>
              Сбросить фильтры
            </button>
          )}
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
                      <span className={`admin-status ${a.type === "chat" ? "active" : a.type === "infographic" ? "infographic" : "document"}`}>
                        {a.type === "chat" ? "Чат" : a.type === "infographic" ? "Инфографика" : "Документ"}
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
                    <td className="admin-cell-date" style={{ textAlign: "right", paddingLeft: 0 }}>{formatDateTime(a.created_at)}</td>
                    <td style={{ textAlign: "right" }}>
                      {a.type !== "document" && (
                        <button className="admin-btn-icon-danger" onClick={() => deleteSingle(a.id)} title="Удалить">
                          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                        </button>
                      )}
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
