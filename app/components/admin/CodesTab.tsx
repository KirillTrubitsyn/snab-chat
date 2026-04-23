"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { apiUrl, getAdminHeaders } from "@/app/lib/api";
import { formatDateShort } from "@/app/lib/date-utils";
import type { InviteCode } from "./types";

type StatusFilter = "all" | "active" | "inactive";
type TwoFAFilter = "all" | "has" | "none";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "active", label: "Активен" },
  { key: "inactive", label: "Отключён" },
];

const TWO_FA_FILTERS: { key: TwoFAFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "has", label: "Есть 2FA" },
  { key: "none", label: "Нет 2FA" },
];

export default function CodesTab({ adminCode, canDeleteCodes }: { adminCode: string; canDeleteCodes: boolean }) {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newChatLimit, setNewChatLimit] = useState("");
  const [newInfographicLimit, setNewInfographicLimit] = useState("");
  const [newDeviceLimit, setNewDeviceLimit] = useState("2");
  const [creating, setCreating] = useState(false);
  const [searchName, setSearchName] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [orgFilter, setOrgFilter] = useState("");
  const [twoFAFilter, setTwoFAFilter] = useState<TwoFAFilter>("all");

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Kebab menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Edit modal
  const [editingCode, setEditingCode] = useState<InviteCode | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editChatLimit, setEditChatLimit] = useState("");
  const [editInfographicLimit, setEditInfographicLimit] = useState("");
  const [editDeviceLimit, setEditDeviceLimit] = useState("");

  const headers = getAdminHeaders(adminCode);

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const res = await fetch(apiUrl("/api/admin/invite-codes"), { headers });
      const data = await res.json();
      if (data.codes) setCodes(data.codes);
    } catch { /* ignore */ }
    setCodesLoading(false);
  }, [adminCode]);

  useEffect(() => { loadCodes(); }, [loadCodes]);

  const createCode = async () => {
    if (!newCode.trim() || !newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(apiUrl("/api/admin/invite-codes"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode.trim(),
          name: newName.trim(),
          organization: newOrg.trim() || null,
          chat_limit: newChatLimit ? parseInt(newChatLimit) : null,
          infographic_limit: newInfographicLimit ? parseInt(newInfographicLimit) : null,
          device_limit: newDeviceLimit ? parseInt(newDeviceLimit) : null,
        }),
      });
      if (res.ok) {
        setNewCode(""); setNewName(""); setNewOrg("");
        setNewChatLimit(""); setNewInfographicLimit(""); setNewDeviceLimit("2");
        loadCodes();
      } else {
        const data = await res.json();
        alert(data.error || "Ошибка создания кода");
      }
    } catch { /* ignore */ }
    setCreating(false);
  };

  const deleteCode = async (id: string) => {
    if (!confirm("Удалить этот инвайт-код?")) return;
    try {
      const res = await fetch(apiUrl(`/api/admin/invite-codes?id=${id}`), { method: "DELETE", headers });
      if (res.status === 409) {
        const data = await res.json();
        if (data.requireForce) {
          if (!confirm(`У этого кода ${data.conversation_count} диалогов. Они станут осиротевшими. Удалить?`)) return;
          await fetch(apiUrl(`/api/admin/invite-codes?id=${id}&force=true`), { method: "DELETE", headers });
        }
      }
      loadCodes();
    } catch { /* ignore */ }
  };

  const toggleCodeActive = async (id: string, currentActive: boolean) => {
    try {
      await fetch(apiUrl(`/api/admin/invite-codes?id=${id}`), {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !currentActive }),
      });
      loadCodes();
    } catch { /* ignore */ }
  };

  const openEdit = (c: InviteCode) => {
    setEditingCode(c);
    setEditName(c.name);
    setEditOrg(c.organization || "");
    setEditChatLimit(c.chat_limit !== null ? String(c.chat_limit) : "");
    setEditInfographicLimit(c.infographic_limit !== null ? String(c.infographic_limit) : "");
    setEditDeviceLimit(c.device_limit !== null ? String(c.device_limit) : "");
  };

  const saveEdit = async () => {
    if (!editingCode) return;
    try {
      await fetch(apiUrl(`/api/admin/invite-codes?id=${editingCode.id}`), {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          organization: editOrg.trim() || null,
          chat_limit: editChatLimit ? parseInt(editChatLimit) : null,
          infographic_limit: editInfographicLimit ? parseInt(editInfographicLimit) : null,
          device_limit: editDeviceLimit ? parseInt(editDeviceLimit) : null,
        }),
      });
      setEditingCode(null);
      loadCodes();
    } catch { /* ignore */ }
  };

  const reset2FA = async (id: string) => {
    if (!confirm("Сбросить все методы 2FA у этого пользователя?")) return;
    try {
      const res = await fetch(apiUrl(`/api/admin/invite-codes?id=${id}`), {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ reset_2fa: true }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Ошибка сброса 2FA");
      }
      loadCodes();
    } catch { /* ignore */ }
  };

  const resetPassword = async (id: string) => {
    if (!confirm("Сбросить пароль? Пользователю придётся создать новый при следующем входе.")) return;
    try {
      const res = await fetch(apiUrl(`/api/admin/invite-codes?id=${id}`), {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ reset_password: true }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || "Ошибка сброса пароля");
      }
      loadCodes();
    } catch { /* ignore */ }
  };

  const orgs = useMemo(
    () => [...new Set(codes.map((c) => c.organization).filter(Boolean))].sort() as string[],
    [codes]
  );

  const hasActiveFilters = searchName !== "" || statusFilter !== "all" || orgFilter !== "" || twoFAFilter !== "all";

  const resetFilters = () => {
    setSearchName("");
    setStatusFilter("all");
    setOrgFilter("");
    setTwoFAFilter("all");
  };

  const filteredCodes = useMemo(() => codes.filter((c) => {
    if (searchName) {
      const q = searchName.toLowerCase();
      if (
        !c.name.toLowerCase().includes(q) &&
        !c.code.toLowerCase().includes(q) &&
        !(c.organization ?? "").toLowerCase().includes(q)
      ) return false;
    }
    if (statusFilter === "active" && !c.is_active) return false;
    if (statusFilter === "inactive" && c.is_active) return false;
    if (orgFilter && c.organization !== orgFilter) return false;
    const has2fa = c.has_telegram || c.has_sms || c.has_totp;
    if (twoFAFilter === "has" && !has2fa) return false;
    if (twoFAFilter === "none" && has2fa) return false;
    return true;
  }), [codes, searchName, statusFilter, orgFilter, twoFAFilter]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredCodes.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCodes.map((c) => c.id)));
    }
  };

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [openMenuId]);

  return (
    <>
      <div>
        {/* Create form card */}
        <div className="admin-card">
          <div className="admin-card-header">
            <div className="admin-card-header-left">
              <h3 className="admin-card-title">Создать инвайт-код</h3>
            </div>
          </div>
          <div className="admin-form-row">
            <div className="admin-form-field">
              <label>Код *</label>
              <input placeholder="напр. ИВАНОВ-2024" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} />
            </div>
            <div className="admin-form-field" style={{ flex: 2 }}>
              <label>ФИО получателя *</label>
              <input placeholder="Иванов Иван Иванович" value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="admin-form-field" style={{ flex: 1.5 }}>
              <label>Организация</label>
              <input placeholder="напр. ООО «Компания»" value={newOrg} onChange={(e) => setNewOrg(e.target.value)} />
            </div>
            <div className="admin-form-field" style={{ width: 140 }}>
              <label>Лимит чата</label>
              <input placeholder="безлимит" value={newChatLimit} onChange={(e) => setNewChatLimit(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div className="admin-form-field" style={{ width: 160 }}>
              <label>Лимит инфографики</label>
              <input placeholder="безлимит" value={newInfographicLimit} onChange={(e) => setNewInfographicLimit(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div className="admin-form-field" style={{ width: 140 }}>
              <label>Лимит устройств</label>
              <input placeholder="безлимит" value={newDeviceLimit} onChange={(e) => setNewDeviceLimit(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div className="admin-form-field admin-form-field-btn">
              <button onClick={createCode} disabled={creating || !newCode.trim() || !newName.trim()} className="admin-btn-primary">
                {creating ? "Создание..." : "Создать"}
              </button>
            </div>
          </div>
          <p className="admin-hint">Пусто = без лимита</p>
        </div>

        {/* Codes table */}
        <div className="admin-card admin-card-table">
          <div className="admin-card-header">
            <div className="admin-card-header-left">
              <h3 className="admin-card-title">Инвайт-коды</h3>
              <span className="admin-card-badge">{filteredCodes.length}</span>
            </div>
            <div className="admin-card-actions">
              <div className="admin-form-field admin-search-field">
                <input placeholder="Поиск по имени, коду, организации..." value={searchName} onChange={(e) => setSearchName(e.target.value)} />
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
              <button className="admin-btn-secondary" onClick={loadCodes} disabled={codesLoading}>
                <span className="material-symbols-outlined">refresh</span>
                Обновить
              </button>
            </div>
          </div>
          <div style={{ padding: "8px 24px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #E2E8F0", background: "#fff" }}>
            <div className="admin-doc-pills">
              {STATUS_FILTERS.map((f) => (
                <button key={f.key} className={`admin-doc-pill ${statusFilter === f.key ? "active" : ""}`} onClick={() => setStatusFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="admin-doc-pills">
              {TWO_FA_FILTERS.map((f) => (
                <button key={f.key} className={`admin-doc-pill ${twoFAFilter === f.key ? "active" : ""}`} onClick={() => setTwoFAFilter(f.key)}>
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

          {codesLoading ? (
            <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
          ) : filteredCodes.length === 0 ? (
            <div className="admin-empty">{codes.length === 0 ? "Нет инвайт-кодов" : "Ничего не найдено"}</div>
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>
                      <input type="checkbox" checked={filteredCodes.length > 0 && selectedIds.size === filteredCodes.length} onChange={toggleSelectAll} className="admin-checkbox" />
                    </th>
                    <th>Код</th><th>Имя</th><th>Организация</th><th>Чат</th>
                    <th>Инфографика</th><th>Устройства</th><th>2FA</th><th>Статус</th>
                    <th>Создан</th><th style={{ width: 48 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCodes.map((c) => {
                    const isMenuOpen = openMenuId === c.id;
                    return (
                    <tr key={c.id} className={`${!c.is_active ? "admin-row-inactive" : ""} ${selectedIds.has(c.id) ? "admin-row-selected" : ""}`}>
                      <td>
                        <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelect(c.id)} className="admin-checkbox" />
                      </td>
                      <td><span className="admin-code-badge">{c.code}</span></td>
                      <td className="admin-cell-name">{c.name}</td>
                      <td className="admin-cell-name">{c.organization || <span className="admin-text-muted">—</span>}</td>
                      <td>
                        {c.chat_limit === null ? (
                          <span className="admin-text-muted">безлимит</span>
                        ) : (
                          <span className={c.chat_limit <= 0 ? "admin-text-danger" : ""}>{c.chat_limit}</span>
                        )}
                      </td>
                      <td>
                        {c.infographic_limit === null ? (
                          <span className="admin-text-muted">безлимит</span>
                        ) : (
                          <span className={c.infographic_limit <= 0 ? "admin-text-danger" : ""}>{c.infographic_limit}</span>
                        )}
                      </td>
                      <td>
                        {c.device_limit === null ? (
                          <span className="admin-text-muted">безлимит</span>
                        ) : (
                          <span className={c.device_count >= c.device_limit ? "admin-text-danger" : ""}>{c.device_count}/{c.device_limit}</span>
                        )}
                      </td>
                      <td>
                        {(() => {
                          const methods = [
                            c.has_telegram && "TG",
                            c.has_sms && "SMS",
                            c.has_totp && "OTP",
                          ].filter(Boolean);
                          return methods.length > 0
                            ? <span style={{ fontSize: 11, color: "var(--success, #4caf50)" }}>{methods.join(", ")}</span>
                            : <span className="admin-text-muted">—</span>;
                        })()}
                      </td>
                      <td>
                        <span className={`admin-status ${c.is_active ? "active" : "inactive"}`}>
                          {c.is_active ? "Активен" : "Отключён"}
                        </span>
                      </td>
                      <td className="admin-cell-date">{formatDateShort(c.created_at)}</td>
                      <td style={{ position: "relative" }}>
                        <button className="admin-kebab-btn" onClick={(e) => { e.stopPropagation(); setOpenMenuId(isMenuOpen ? null : c.id); }} title="Действия">
                          <span className="material-symbols-outlined">more_vert</span>
                        </button>
                        {isMenuOpen && (
                          <div className="admin-kebab-dropdown" onClick={(e) => e.stopPropagation()}
                            ref={(el) => {
                              if (el) {
                                const rect = el.getBoundingClientRect();
                                const spaceBelow = window.innerHeight - rect.top;
                                if (spaceBelow < rect.height + 8) {
                                  el.style.bottom = "100%";
                                  el.style.top = "auto";
                                  el.style.marginBottom = "4px";
                                }
                              }
                            }}
                          >
                            <button className="admin-kebab-item" onClick={() => { setOpenMenuId(null); openEdit(c); }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>
                              Изменить
                            </button>
                            <button className="admin-kebab-item warning" onClick={() => { setOpenMenuId(null); toggleCodeActive(c.id, c.is_active); }}>
                              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{c.is_active ? "block" : "check_circle"}</span>
                              {c.is_active ? "Отключить" : "Включить"}
                            </button>
                            {(c.has_password || c.has_telegram || c.has_sms || c.has_totp) && (
                              <div className="admin-kebab-divider" />
                            )}
                            {(c.has_telegram || c.has_sms || c.has_totp) && (
                              <button className="admin-kebab-item warning" onClick={() => { setOpenMenuId(null); reset2FA(c.id); }}>
                                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>shield</span>
                                Сбросить 2FA
                              </button>
                            )}
                            {c.has_password && (
                              <button className="admin-kebab-item warning" onClick={() => { setOpenMenuId(null); resetPassword(c.id); }}>
                                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>lock_reset</span>
                                Сбросить пароль
                              </button>
                            )}
                            {canDeleteCodes && (<>
                              <div className="admin-kebab-divider" />
                              <button className="admin-kebab-item danger" onClick={() => { setOpenMenuId(null); deleteCode(c.id); }}>
                                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                                Удалить
                              </button>
                            </>)}
                          </div>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      {editingCode && (
        <div className="admin-modal-overlay" onClick={() => setEditingCode(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Редактирование: {editingCode.code}</h3>
              <button onClick={() => setEditingCode(null)} className="admin-modal-close">&times;</button>
            </div>
            <div className="admin-modal-body">
              <div className="admin-form-group">
                <label>ФИО</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="admin-form-group">
                <label>Организация</label>
                <input value={editOrg} onChange={(e) => setEditOrg(e.target.value)} placeholder="напр. ООО «Компания»" />
              </div>
              <div className="admin-form-group">
                <label>Лимит запросов в чат</label>
                <input value={editChatLimit} onChange={(e) => setEditChatLimit(e.target.value.replace(/\D/g, ""))} placeholder="Пусто = безлимит" />
              </div>
              <div className="admin-form-group">
                <label>Лимит инфографики</label>
                <input value={editInfographicLimit} onChange={(e) => setEditInfographicLimit(e.target.value.replace(/\D/g, ""))} placeholder="Пусто = безлимит" />
              </div>
              <div className="admin-form-group">
                <label>Лимит устройств</label>
                <input value={editDeviceLimit} onChange={(e) => setEditDeviceLimit(e.target.value.replace(/\D/g, ""))} placeholder="Пусто = безлимит" />
              </div>
              {/* 2FA/Password Status */}
              {(editingCode.has_password || editingCode.has_telegram || editingCode.has_sms || editingCode.has_totp) && (
                <div style={{ marginBottom: 16, padding: "12px", background: "var(--bg-secondary, #f5f7fa)", borderRadius: 8, fontSize: 13 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Безопасность</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                    {editingCode.has_password && <span style={{ padding: "2px 8px", background: "#e3f2fd", borderRadius: 4, fontSize: 11 }}>Пароль</span>}
                    {editingCode.has_telegram && <span style={{ padding: "2px 8px", background: "#e8f5e9", borderRadius: 4, fontSize: 11 }}>Telegram</span>}
                    {editingCode.has_sms && <span style={{ padding: "2px 8px", background: "#fff3e0", borderRadius: 4, fontSize: 11 }}>SMS</span>}
                    {editingCode.has_totp && <span style={{ padding: "2px 8px", background: "#f3e5f5", borderRadius: 4, fontSize: 11 }}>Authenticator</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(editingCode.has_telegram || editingCode.has_sms || editingCode.has_totp) && (
                      <button className="admin-action-link admin-action-warning" style={{ fontSize: 12 }} onClick={() => reset2FA(editingCode.id)}>
                        Сбросить 2FA
                      </button>
                    )}
                    {editingCode.has_password && (
                      <button className="admin-action-link admin-action-warning" style={{ fontSize: 12 }} onClick={() => resetPassword(editingCode.id)}>
                        Сбросить пароль
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="admin-modal-actions">
                <button className="admin-btn-secondary" onClick={() => setEditingCode(null)}>Отмена</button>
                {canDeleteCodes && (
                  <button className="admin-btn-danger" onClick={() => { setEditingCode(null); deleteCode(editingCode.id); }}>Удалить код</button>
                )}
                <button className="admin-btn-primary" onClick={saveEdit}>Сохранить</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
