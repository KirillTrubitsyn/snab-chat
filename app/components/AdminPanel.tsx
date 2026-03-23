"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/* ── Types ── */

interface InviteCode {
  id: string;
  code: string;
  name: string;
  organization: string | null;
  uses_remaining: number | null;
  chat_limit: number | null;
  infographic_limit: number | null;
  is_active: boolean;
  created_at: string;
  conversation_count: number;
}

interface ActivityItem {
  id: string;
  type: "chat" | "infographic";
  user_name: string;
  organization: string | null;
  content: string;
  created_at: string;
}

interface Source {
  id: number;
  filename: string;
  mime_type: string;
  tags: string[];
  storage_path: string | null;
  folder_path: string | null;
  created_at: string;
}

interface ParsedFile {
  filename: string;
  mimeType: string;
  markdown: string;
  tags: string[];
  chunks: { index: number; preview: string; length: number }[];
  totalChunks: number;
}

interface AdminPanelProps {
  adminCode: string;
  userName: string;
  onLogout: () => void;
}

/* ── Helpers ── */

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminPanel({ adminCode, userName, onLogout }: AdminPanelProps) {
  const [tab, setTab] = useState<"codes" | "activity" | "documents">("activity");

  // Invite codes state
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newChatLimit, setNewChatLimit] = useState("");
  const [newInfographicLimit, setNewInfographicLimit] = useState("");
  const [creating, setCreating] = useState(false);

  // Edit modal state
  const [editingCode, setEditingCode] = useState<InviteCode | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editChatLimit, setEditChatLimit] = useState("");
  const [editInfographicLimit, setEditInfographicLimit] = useState("");

  // Activity state
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Documents state
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [sourceTagInput, setSourceTagInput] = useState("");

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<"idle" | "parsing" | "review" | "ingesting" | "done">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search/filter state
  const [searchName, setSearchName] = useState("");

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  /* ── Load data ── */

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    try {
      const res = await fetch("/api/admin/invite-codes", { headers });
      const data = await res.json();
      if (data.codes) setCodes(data.codes);
    } catch { /* ignore */ }
    setCodesLoading(false);
  }, [adminCode]);

  const loadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      const res = await fetch("/api/admin/activity", { headers });
      const data = await res.json();
      if (data.activity) setActivity(data.activity);
    } catch { /* ignore */ }
    setActivityLoading(false);
  }, [adminCode]);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const res = await fetch("/api/sources");
      const data = await res.json();
      if (data.sources) setSources(data.sources);
    } catch { /* ignore */ }
    setSourcesLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "codes") loadCodes();
    else if (tab === "activity") loadActivity();
    else if (tab === "documents") loadSources();
  }, [tab, loadCodes, loadActivity, loadSources]);

  /* ── Invite code actions ── */

  const createCode = async () => {
    if (!newCode.trim() || !newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/invite-codes", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          code: newCode.trim(),
          name: newName.trim(),
          organization: newOrg.trim() || null,
          chat_limit: newChatLimit ? parseInt(newChatLimit) : null,
          infographic_limit: newInfographicLimit ? parseInt(newInfographicLimit) : null,
        }),
      });
      if (res.ok) {
        setNewCode("");
        setNewName("");
        setNewOrg("");
        setNewChatLimit("");
        setNewInfographicLimit("");
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
      await fetch(`/api/admin/invite-codes?id=${id}`, {
        method: "DELETE",
        headers,
      });
      loadCodes();
    } catch { /* ignore */ }
  };

  const toggleCodeActive = async (id: string, currentActive: boolean) => {
    try {
      await fetch(`/api/admin/invite-codes?id=${id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !currentActive }),
      });
      loadCodes();
    } catch { /* ignore */ }
  };

  const saveEdit = async () => {
    if (!editingCode) return;
    try {
      await fetch(`/api/admin/invite-codes?id=${editingCode.id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          organization: editOrg.trim() || null,
          chat_limit: editChatLimit ? parseInt(editChatLimit) : null,
          infographic_limit: editInfographicLimit ? parseInt(editInfographicLimit) : null,
        }),
      });
      setEditingCode(null);
      loadCodes();
    } catch { /* ignore */ }
  };

  const openEdit = (c: InviteCode) => {
    setEditingCode(c);
    setEditName(c.name);
    setEditOrg(c.organization || "");
    setEditChatLimit(c.chat_limit !== null ? String(c.chat_limit) : "");
    setEditInfographicLimit(c.infographic_limit !== null ? String(c.infographic_limit) : "");
  };

  const cleanupOrphanedConversations = async () => {
    if (!confirm("Удалить все диалоги без привязки к инвайт-коду?")) return;
    try {
      const res = await fetch("/api/admin/activity", {
        method: "DELETE",
        headers,
      });
      const data = await res.json();
      alert(`Удалено диалогов: ${data.deleted || 0}`);
      loadActivity();
    } catch { /* ignore */ }
  };

  /* ── Document actions ── */

  const deleteSource = async (sourceId: number) => {
    if (!confirm("Удалить этот документ из базы знаний?")) return;
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "DELETE",
        headers,
      });
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
    } catch { /* ignore */ }
  };

  const updateSourceTags = async (sourceId: number, tags: string[]) => {
    setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, tags } : s)));
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
    } catch { /* ignore */ }
  };

  /* ── Upload flow ── */

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    setUploadFiles(fileArray);
    setUploadStage("parsing");
    setParsedFiles([]);

    const parsed: ParsedFile[] = [];
    for (const file of fileArray) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/parse", {
          method: "POST",
          headers: { "x-admin-code": encodeURIComponent(adminCode) },
          body: formData,
        });
        if (res.ok) {
          const data = await res.json();
          parsed.push(data);
        }
      } catch { /* ignore */ }
    }

    setParsedFiles(parsed);
    setUploadStage(parsed.length > 0 ? "review" : "idle");
  };

  const ingestFiles = async () => {
    setUploadStage("ingesting");
    setUploadProgress(0);

    for (let i = 0; i < parsedFiles.length; i++) {
      const pf = parsedFiles[i];
      const file = uploadFiles.find((f) => f.name === pf.filename);

      const formData = new FormData();
      if (file) formData.append("file", file);
      formData.append("filename", pf.filename);
      formData.append("mimeType", pf.mimeType);
      formData.append("markdown", pf.markdown);
      formData.append("tags", JSON.stringify(pf.tags));

      try {
        await fetch("/api/ingest", {
          method: "POST",
          headers: { "x-admin-code": encodeURIComponent(adminCode) },
          body: formData,
        });
      } catch { /* ignore */ }

      setUploadProgress(((i + 1) / parsedFiles.length) * 100);
    }

    setUploadStage("done");
    loadSources();
    setTimeout(() => {
      setShowUpload(false);
      setUploadStage("idle");
      setUploadFiles([]);
      setParsedFiles([]);
    }, 1500);
  };

  const updateParsedFileTags = (index: number, tags: string[]) => {
    setParsedFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, tags } : f))
    );
  };

  // Filter codes
  const filteredCodes = codes.filter((c) => {
    if (searchName && !c.name.toLowerCase().includes(searchName.toLowerCase()) && !c.code.toLowerCase().includes(searchName.toLowerCase())) return false;
    return true;
  });

  // Stat values
  const totalUsers = codes.length;
  const activeUsers = codes.filter((c) => c.is_active).length;
  const totalDocs = sources.length;
  const totalRequests = activity.length;

  /* ── Render ── */

  return (
    <div className="admin-container">
      {/* Accent stripe */}
      <div className="admin-header-stripe" />

      {/* Header */}
      <header className="admin-header">
        <div className="admin-header-left">
          <h1 className="admin-title">
            <span className="admin-title-accent">СнабЧат</span> Admin Panel
          </h1>
          <p className="admin-subtitle">Управление инвайт-кодами и база знаний</p>
        </div>
        <div className="admin-header-right">
          <span className="admin-user-name">{userName}</span>
          <a href="/" className="admin-header-link">К чату</a>
          <button onClick={onLogout} className="admin-header-link">Выйти</button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="admin-tabs">
        <button
          className={`admin-tab ${tab === "codes" ? "active" : ""}`}
          onClick={() => setTab("codes")}
        >
          Инвайт-коды
        </button>
        <button
          className={`admin-tab ${tab === "activity" ? "active" : ""}`}
          onClick={() => setTab("activity")}
        >
          Активность
        </button>
        <button
          className={`admin-tab ${tab === "documents" ? "active" : ""}`}
          onClick={() => setTab("documents")}
        >
          Документы
        </button>
      </nav>

      {/* Content */}
      <div className="admin-content">
        {/* Stat cards */}
        <div className="admin-stats">
          <div className="admin-stat-card">
            <div className="admin-stat-icon blue">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <div className="admin-stat-info">
              <span className="admin-stat-value">{totalUsers}</span>
              <span className="admin-stat-label">Инвайт-кодов</span>
            </div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-icon green">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <div className="admin-stat-info">
              <span className="admin-stat-value">{activeUsers}</span>
              <span className="admin-stat-label">Активных</span>
            </div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-icon purple">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </div>
            <div className="admin-stat-info">
              <span className="admin-stat-value">{totalDocs}</span>
              <span className="admin-stat-label">Документов</span>
            </div>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-icon amber">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div className="admin-stat-info">
              <span className="admin-stat-value">{totalRequests}</span>
              <span className="admin-stat-label">Запросов</span>
            </div>
          </div>
        </div>

        {/* ── Tab: Invite Codes ── */}
        {tab === "codes" && (
          <div>
            {/* Create form card */}
            <div className="admin-card">
              <h3 className="admin-card-title">Создать инвайт-код</h3>
              <div className="admin-form-row">
                <div className="admin-form-field">
                  <label>Код *</label>
                  <input
                    placeholder="напр. ИВАНОВ-2024"
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                  />
                </div>
                <div className="admin-form-field" style={{ flex: 2 }}>
                  <label>ФИО получателя *</label>
                  <input
                    placeholder="Иванов Иван Иванович"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
                <div className="admin-form-field" style={{ flex: 1.5 }}>
                  <label>Организация</label>
                  <input
                    placeholder="напр. ООО «Компания»"
                    value={newOrg}
                    onChange={(e) => setNewOrg(e.target.value)}
                  />
                </div>
                <div className="admin-form-field" style={{ width: 140 }}>
                  <label>Лимит чата</label>
                  <input
                    placeholder="безлимит"
                    value={newChatLimit}
                    onChange={(e) => setNewChatLimit(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <div className="admin-form-field" style={{ width: 160 }}>
                  <label>Лимит инфографики</label>
                  <input
                    placeholder="безлимит"
                    value={newInfographicLimit}
                    onChange={(e) => setNewInfographicLimit(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <div className="admin-form-field admin-form-field-btn">
                  <button
                    onClick={createCode}
                    disabled={creating || !newCode.trim() || !newName.trim()}
                    className="admin-btn-primary"
                  >
                    {creating ? "Создание..." : "Создать"}
                  </button>
                </div>
              </div>
              <p className="admin-hint">Пусто = без лимита</p>
            </div>

            {/* Filters */}
            <div className="admin-card admin-filters">
              <div className="admin-form-field">
                <label>Поиск</label>
                <input
                  placeholder="Поиск по имени или коду..."
                  value={searchName}
                  onChange={(e) => setSearchName(e.target.value)}
                />
              </div>
            </div>

            {/* Codes table */}
            <div className="admin-card admin-card-table">
              <div className="admin-table-header">
                <h3 className="admin-card-title">
                  Инвайт-коды ({filteredCodes.length})
                </h3>
                <button className="admin-btn-secondary" onClick={loadCodes} disabled={codesLoading}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
                  Обновить
                </button>
              </div>

              {codesLoading ? (
                <div className="admin-loading-text">
                  <div className="admin-spinner" />
                  Загрузка...
                </div>
              ) : filteredCodes.length === 0 ? (
                <div className="admin-empty">
                  {codes.length === 0 ? "Нет инвайт-кодов" : "Ничего не найдено"}
                </div>
              ) : (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Код</th>
                        <th>Имя</th>
                        <th>Организация</th>
                        <th>Чат</th>
                        <th>Инфографика</th>
                        <th>Статус</th>
                        <th>Создан</th>
                        <th>Действия</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCodes.map((c) => (
                        <tr key={c.id} className={!c.is_active ? "admin-row-inactive" : ""}>
                          <td>
                            <span className="admin-code-badge">{c.code}</span>
                          </td>
                          <td className="admin-cell-name">{c.name}</td>
                          <td className="admin-cell-name">
                            {c.organization || <span className="admin-text-muted">—</span>}
                          </td>
                          <td>
                            {c.chat_limit === null ? (
                              <span className="admin-text-muted">безлимит</span>
                            ) : (
                              <span className={c.chat_limit <= 0 ? "admin-text-danger" : ""}>
                                {c.chat_limit}
                              </span>
                            )}
                          </td>
                          <td>
                            {c.infographic_limit === null ? (
                              <span className="admin-text-muted">безлимит</span>
                            ) : (
                              <span className={c.infographic_limit <= 0 ? "admin-text-danger" : ""}>
                                {c.infographic_limit}
                              </span>
                            )}
                          </td>
                          <td>
                            <span className={`admin-status ${c.is_active ? "active" : "inactive"}`}>
                              {c.is_active ? "Активен" : "Отключён"}
                            </span>
                          </td>
                          <td className="admin-cell-date">{formatDate(c.created_at)}</td>
                          <td>
                            <div className="admin-actions">
                              <button className="admin-action-link" onClick={() => openEdit(c)}>
                                Изменить
                              </button>
                              <button
                                className="admin-action-link admin-action-warning"
                                onClick={() => toggleCodeActive(c.id, c.is_active)}
                              >
                                {c.is_active ? "Отключить" : "Включить"}
                              </button>
                              <button
                                className="admin-action-link admin-action-danger"
                                onClick={() => deleteCode(c.id)}
                              >
                                Удалить
                              </button>
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
        )}

        {/* ── Tab: Activity ── */}
        {tab === "activity" && (
          <div>
            <div className="admin-card admin-card-table">
              <div className="admin-table-header">
                <h3 className="admin-card-title">
                  Запросы пользователей ({activity.length})
                </h3>
                <div className="admin-table-header-actions">
                  <button className="admin-btn-secondary" onClick={cleanupOrphanedConversations}>
                    Очистить старые диалоги
                  </button>
                  <button className="admin-btn-secondary" onClick={loadActivity} disabled={activityLoading}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
                    Обновить
                  </button>
                </div>
              </div>

              {activityLoading ? (
                <div className="admin-loading-text">
                  <div className="admin-spinner" />
                  Загрузка...
                </div>
              ) : activity.length === 0 ? (
                <div className="admin-empty">Нет активности</div>
              ) : (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>ФИО</th>
                        <th>Организация</th>
                        <th>Тип</th>
                        <th>Запрос</th>
                        <th>Время</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.map((a) => (
                        <tr key={a.id}>
                          <td className="admin-cell-name">{a.user_name}</td>
                          <td className="admin-cell-name">
                            {a.organization || <span className="admin-text-muted">—</span>}
                          </td>
                          <td>
                            <span className={`admin-status ${a.type === "chat" ? "active" : "infographic"}`}>
                              {a.type === "chat" ? "Чат" : "Инфографика"}
                            </span>
                          </td>
                          <td className="admin-cell-title" title={a.content}>
                            {a.content}
                          </td>
                          <td className="admin-cell-date">{formatDateTime(a.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Tab: Documents ── */}
        {tab === "documents" && (
          <div>
            <div className="admin-card admin-card-table">
              <div className="admin-table-header">
                <h3 className="admin-card-title">
                  База знаний ({sources.length} документов)
                </h3>
                <div className="admin-table-header-actions">
                  <button className="admin-btn-primary" onClick={() => setShowUpload(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Загрузить
                  </button>
                  <button className="admin-btn-secondary" onClick={loadSources} disabled={sourcesLoading}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
                    Обновить
                  </button>
                </div>
              </div>

              {sourcesLoading ? (
                <div className="admin-loading-text">
                  <div className="admin-spinner" />
                  Загрузка...
                </div>
              ) : sources.length === 0 ? (
                <div className="admin-empty">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 12 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <p>Нет загруженных документов</p>
                  <p style={{ fontSize: 12, marginTop: 4 }}>Нажмите «Загрузить» чтобы добавить документы в базу знаний</p>
                </div>
              ) : (
                <div className="admin-docs-list">
                  {sources.map((doc) => {
                    const isExpanded = expandedSourceId === doc.id;
                    const ext = doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : "docx";
                    return (
                      <div key={doc.id} className={`admin-doc-item ${isExpanded ? "expanded" : ""}`}>
                        <div
                          className="admin-doc-header"
                          onClick={() => {
                            setExpandedSourceId(isExpanded ? null : doc.id);
                            setSourceTagInput("");
                          }}
                        >
                          <div className={`doc-icon ${ext}`}>
                            {ext === "pdf" ? "PDF" : ext === "xlsx" ? "XLS" : "DOC"}
                          </div>
                          <div className="admin-doc-info">
                            <div className="admin-doc-name">{doc.filename}</div>
                            <div className="admin-doc-meta">
                              {doc.tags?.length || 0} тегов &middot; {formatDate(doc.created_at)}
                            </div>
                          </div>
                          <button
                            className="admin-action-link admin-action-danger"
                            onClick={(e) => { e.stopPropagation(); deleteSource(doc.id); }}
                          >
                            Удалить
                          </button>
                        </div>
                        {isExpanded && (
                          <div className="admin-doc-details">
                            <div className="admin-doc-tags-label">Теги:</div>
                            <div className="admin-doc-tags">
                              {(doc.tags || []).map((tag) => (
                                <span key={tag} className="admin-tag">
                                  {tag}
                                  <button
                                    onClick={() => updateSourceTags(doc.id, doc.tags.filter((t) => t !== tag))}
                                    className="admin-tag-remove"
                                  >
                                    &times;
                                  </button>
                                </span>
                              ))}
                              <form
                                className="admin-tag-form"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const t = sourceTagInput.trim();
                                  if (t && !(doc.tags || []).includes(t)) {
                                    updateSourceTags(doc.id, [...(doc.tags || []), t]);
                                    setSourceTagInput("");
                                  }
                                }}
                              >
                                <input
                                  value={sourceTagInput}
                                  onChange={(e) => setSourceTagInput(e.target.value)}
                                  placeholder="+ добавить тег"
                                  className="admin-tag-input"
                                />
                              </form>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Upload Modal */}
            {showUpload && (
              <div className="admin-modal-overlay" onClick={() => { if (uploadStage === "idle" || uploadStage === "done") { setShowUpload(false); setUploadStage("idle"); } }}>
                <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="admin-modal-header">
                    <h3>Загрузка документов</h3>
                    <button onClick={() => { setShowUpload(false); setUploadStage("idle"); setParsedFiles([]); setUploadFiles([]); }} className="admin-modal-close">&times;</button>
                  </div>
                  <div className="admin-modal-body">
                    {uploadStage === "idle" && (
                      <div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          accept=".docx,.pdf,.xlsx,.xls"
                          style={{ display: "none" }}
                          onChange={(e) => handleFilesSelected(e.target.files)}
                        />
                        <div className="admin-upload-area" onClick={() => fileInputRef.current?.click()}>
                          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: 8 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                          <p>Нажмите для выбора файлов</p>
                          <p className="hint">DOCX, PDF, Excel</p>
                        </div>
                      </div>
                    )}
                    {uploadStage === "parsing" && (
                      <div className="admin-loading-text">
                        <div className="admin-spinner" />
                        Парсинг файлов...
                      </div>
                    )}
                    {uploadStage === "review" && (
                      <div>
                        <p style={{ marginBottom: 16, fontWeight: 500 }}>Готово к загрузке: {parsedFiles.length} файлов</p>
                        {parsedFiles.map((pf, i) => (
                          <div key={i} className="admin-card" style={{ marginBottom: 8 }}>
                            <div style={{ fontWeight: 500, marginBottom: 4 }}>{pf.filename}</div>
                            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                              {pf.totalChunks} чанков
                            </div>
                            <div className="admin-doc-tags">
                              {pf.tags.map((tag) => (
                                <span key={tag} className="admin-tag">
                                  {tag}
                                  <button
                                    onClick={() => updateParsedFileTags(i, pf.tags.filter((t) => t !== tag))}
                                    className="admin-tag-remove"
                                  >
                                    &times;
                                  </button>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                        <button className="admin-btn-primary" onClick={ingestFiles} style={{ marginTop: 16, width: "100%" }}>
                          Загрузить в базу знаний
                        </button>
                      </div>
                    )}
                    {uploadStage === "ingesting" && (
                      <div>
                        <div className="admin-loading-text">
                          <div className="admin-spinner" />
                          Индексация...
                        </div>
                        <div className="admin-progress-bar">
                          <div className="admin-progress-fill" style={{ width: `${uploadProgress}%` }} />
                        </div>
                      </div>
                    )}
                    {uploadStage === "done" && (
                      <div className="admin-loading-text admin-success-text">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        Готово!
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
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
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="admin-form-group">
                <label>Организация</label>
                <input
                  value={editOrg}
                  onChange={(e) => setEditOrg(e.target.value)}
                  placeholder="напр. ООО «Компания»"
                />
              </div>
              <div className="admin-form-group">
                <label>Лимит запросов в чат</label>
                <input
                  value={editChatLimit}
                  onChange={(e) => setEditChatLimit(e.target.value.replace(/\D/g, ""))}
                  placeholder="Пусто = безлимит"
                />
              </div>
              <div className="admin-form-group">
                <label>Лимит инфографики</label>
                <input
                  value={editInfographicLimit}
                  onChange={(e) => setEditInfographicLimit(e.target.value.replace(/\D/g, ""))}
                  placeholder="Пусто = безлимит"
                />
              </div>
              <div className="admin-modal-actions">
                <button className="admin-btn-secondary" onClick={() => setEditingCode(null)}>Отмена</button>
                <button className="admin-btn-primary" onClick={saveEdit}>Сохранить</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
