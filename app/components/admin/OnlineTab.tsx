"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";

interface OnlineUser {
  invite_code_id: string;
  name: string;
  organization: string | null;
  device_count: number;
  last_seen_at: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1 мин назад";
  if (minutes < 5) return `${minutes} мин назад`;
  return `${minutes} мин назад`;
}

export default function OnlineTab({ adminCode }: { adminCode: string }) {
  const [users, setUsers] = useState<OnlineUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const headers = getAdminHeaders(adminCode);

  const loadOnlineUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/admin/online-users"), { headers });
      const data = await res.json();
      if (data.users) setUsers(data.users);
    } catch { /* ignore */ }
    setLoading(false);
  }, [adminCode]);

  useEffect(() => {
    loadOnlineUsers();
  }, [loadOnlineUsers]);

  const disconnectUser = async (inviteCodeId: string, userName: string) => {
    if (!confirm(`Отключить пользователя "${userName}"? Все устройства будут разлогинены.`)) return;
    setDisconnecting(inviteCodeId);
    try {
      await fetch(apiUrl("/api/admin/disconnect-user"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ invite_code_id: inviteCodeId }),
      });
      setUsers((prev) => prev.filter((u) => u.invite_code_id !== inviteCodeId));
    } catch { /* ignore */ }
    setDisconnecting(null);
  };

  const q = search.toLowerCase().trim();
  const filteredUsers = q
    ? users.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          (u.organization && u.organization.toLowerCase().includes(q))
      )
    : users;

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(loadOnlineUsers, 30_000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, loadOnlineUsers]);

  return (
    <>
      {/* Header card */}
      <div className="admin-card admin-card-table">
        <div className="admin-card-header">
          <div className="admin-card-header-left">
            <h2 className="admin-card-title">Онлайн-пользователи</h2>
            <span className="admin-card-badge">{search ? `${filteredUsers.length} / ${users.length}` : users.length}</span>
          </div>
          <div className="admin-card-actions">
            <div className="admin-search-field">
              <input
                type="text"
                placeholder="Поиск по имени, организации..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <label className="admin-online-auto-refresh">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              <span>Автообновление</span>
            </label>
            <button
              className="admin-btn-secondary"
              onClick={loadOnlineUsers}
              disabled={loading}
            >
              <span className="material-symbols-outlined">refresh</span>
              <span>Обновить</span>
            </button>
          </div>
        </div>

        {loading && users.length === 0 ? (
          <div className="admin-empty-state">
            <span className="material-symbols-outlined">hourglass_empty</span>
            <p>Загрузка...</p>
          </div>
        ) : users.length === 0 ? (
          <div className="admin-empty-state">
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#94A3B8" }}>
              person_off
            </span>
            <p>Нет пользователей онлайн</p>
            <p className="admin-text-muted" style={{ fontSize: 13 }}>
              Пользователи считаются онлайн, если были активны в последние 5 минут
            </p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="admin-empty-state">
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: "#94A3B8" }}>
              search_off
            </span>
            <p>Ничего не найдено</p>
          </div>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}></th>
                  <th>Пользователь</th>
                  <th>Организация</th>
                  <th>Устройства</th>
                  <th>Последняя активность</th>
                  <th style={{ width: 100 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.invite_code_id}>
                    <td>
                      <span className="admin-online-dot" />
                    </td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{u.name}</div>
                    </td>
                    <td>{u.organization || <span className="admin-text-muted">—</span>}</td>
                    <td>
                      <span className="admin-online-device-badge">
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>devices</span>
                        {u.device_count}
                      </span>
                    </td>
                    <td className="admin-text-muted">{timeAgo(u.last_seen_at)}</td>
                    <td>
                      <button
                        className="admin-btn-disconnect"
                        onClick={() => disconnectUser(u.invite_code_id, u.name)}
                        disabled={disconnecting === u.invite_code_id}
                        title="Отключить пользователя"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>logout</span>
                        <span>{disconnecting === u.invite_code_id ? "..." : "Отключить"}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
