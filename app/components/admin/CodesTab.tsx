"use client";

import { useState, useCallback, useEffect } from "react";
import { apiUrl } from "@/app/lib/api";
import { formatDateShort } from "@/app/lib/date-utils";
import type { InviteCode } from "./types";

export default function CodesTab({ adminCode }: { adminCode: string }) {
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

  // Edit modal
  const [editingCode, setEditingCode] = useState<InviteCode | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editChatLimit, setEditChatLimit] = useState("");
  const [editInfographicLimit, setEditInfographicLimit] = useState("");
  const [editDeviceLimit, setEditDeviceLimit] = useState("");

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

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
      await fetch(apiUrl(`/api/admin/invite-codes?id=${id}`), { method: "DELETE", headers });
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

  const filteredCodes = codes.filter((c) => {
    if (searchName && !c.name.toLowerCase().includes(searchName.toLowerCase()) && !c.code.toLowerCase().includes(searchName.toLowerCase())) return false;
    return true;
  });

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
                <input placeholder="Поиск по имени или коду..." value={searchName} onChange={(e) => setSearchName(e.target.value)} />
              </div>
              <button className="admin-btn-secondary" onClick={loadCodes} disabled={codesLoading}>
                <span className="material-symbols-outlined">refresh</span>
                Обновить
              </button>
            </div>
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
                    <th>Код</th><th>Имя</th><th>Организация</th><th>Чат</th>
                    <th>Инфографика</th><th>Устройства</th><th>Статус</th>
                    <th>Создан</th><th style={{ textAlign: "right" }}>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCodes.map((c) => (
                    <tr key={c.id} className={!c.is_active ? "admin-row-inactive" : ""}>
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
                        <span className={`admin-status ${c.is_active ? "active" : "inactive"}`}>
                          {c.is_active ? "Активен" : "Отключён"}
                        </span>
                      </td>
                      <td className="admin-cell-date">{formatDateShort(c.created_at)}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="admin-actions">
                          <button className="admin-action-link" onClick={() => openEdit(c)}>Изменить</button>
                          {c.is_active && (
                            <button className="admin-action-link admin-action-warning" onClick={() => toggleCodeActive(c.id, c.is_active)}>
                              Отключить
                            </button>
                          )}
                          <button className="admin-action-link admin-action-danger" onClick={() => deleteCode(c.id)}>Удалить</button>
                        </div>
                      </td>
                    </tr>
                  ))}
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
              <div className="admin-modal-actions">
                <button className="admin-btn-secondary" onClick={() => setEditingCode(null)}>Отмена</button>
                <button className="admin-btn-danger" onClick={() => { setEditingCode(null); deleteCode(editingCode.id); }}>Удалить код</button>
                <button className="admin-btn-primary" onClick={saveEdit}>Сохранить</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
