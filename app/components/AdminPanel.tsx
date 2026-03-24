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
  device_limit: number | null;
  is_active: boolean;
  created_at: string;
  conversation_count: number;
  device_count: number;
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

interface NontargetItem {
  id: string;
  user_question: string;
  assistant_response: string;
  user_name: string;
  organization: string | null;
  created_at: string;
}

interface UserMessageItem {
  id: string;
  user_name: string;
  organization: string | null;
  content: string;
  created_at: string;
}

interface AdminPanelProps {
  adminCode: string;
  userName: string;
  onLogout: () => void;
}

/* ── Helpers ── */

/* ── Document Categories (client-side) ── */

const DOC_CATEGORIES = [
  { key: "standards", label: "Стандарты и Положения", icon: "verified" },
  { key: "forms", label: "Формы документов", icon: "article" },
  { key: "npa", label: "НПА", icon: "gavel" },
  { key: "schemas", label: "Схемы и Алгоритмы", icon: "schema" },
  { key: "other", label: "Прочее", icon: "folder" },
];

const CATEGORY_KEYWORDS: Record<string, string> = {
  "стандарт": "standards", "положение": "standards", "регламент": "standards",
  "методика": "standards", "инструкция": "standards", "руководство": "standards",
  "порядок": "standards", "правила": "standards",
  "форма": "forms", "шаблон": "forms", "бланк": "forms", "образец": "forms",
  "заявка": "forms", "анкета": "forms",
  "приказ": "npa", "закон": "npa", "постановление": "npa", "распоряжение": "npa",
  "указ": "npa", "федеральный": "npa", "кодекс": "npa",
  "схема": "schemas", "алгоритм": "schemas", "диаграмма": "schemas",
  "блок-схема": "schemas", "маршрут": "schemas",
};

function detectCategoryClient(tags: string[], filename?: string): string {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) return category;
    }
  }
  if (filename) {
    const lower = filename.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) return category;
    }
  }
  return "other";
}

function getCategoryLabel(key: string | null): string {
  return DOC_CATEGORIES.find((c) => c.key === key)?.label || "Прочее";
}

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

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export default function AdminPanel({ adminCode, userName, onLogout }: AdminPanelProps) {
  const [tab, setTab] = useState<"codes" | "activity" | "documents" | "nontarget" | "messages">("activity");

  // Invite codes state
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [newChatLimit, setNewChatLimit] = useState("");
  const [newInfographicLimit, setNewInfographicLimit] = useState("");
  const [newDeviceLimit, setNewDeviceLimit] = useState("2");
  const [creating, setCreating] = useState(false);

  // Edit modal state
  const [editingCode, setEditingCode] = useState<InviteCode | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrg, setEditOrg] = useState("");
  const [editChatLimit, setEditChatLimit] = useState("");
  const [editInfographicLimit, setEditInfographicLimit] = useState("");
  const [editDeviceLimit, setEditDeviceLimit] = useState("");

  // Activity state
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Documents state
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [sourceTagInput, setSourceTagInput] = useState("");
  const [docCategoryFilter, setDocCategoryFilter] = useState<string>("all");
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [parsedFileCategories, setParsedFileCategories] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<"idle" | "parsing" | "review" | "ingesting" | "done">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Nontarget queries state
  const [nontargetQueries, setNontargetQueries] = useState<NontargetItem[]>([]);
  const [nontargetLoading, setNontargetLoading] = useState(false);

  // User messages state
  const [userMessages, setUserMessages] = useState<UserMessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

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

  const loadNontarget = useCallback(async () => {
    setNontargetLoading(true);
    try {
      const res = await fetch("/api/admin/activity?type=nontarget", { headers });
      const data = await res.json();
      if (data.nontarget) setNontargetQueries(data.nontarget);
    } catch { /* ignore */ }
    setNontargetLoading(false);
  }, [adminCode]);

  const loadUserMessages = useCallback(async () => {
    setMessagesLoading(true);
    try {
      const res = await fetch("/api/admin/activity?type=messages", { headers });
      const data = await res.json();
      if (data.messages) setUserMessages(data.messages);
    } catch { /* ignore */ }
    setMessagesLoading(false);
  }, [adminCode]);

  useEffect(() => {
    if (tab === "codes") loadCodes();
    else if (tab === "activity") loadActivity();
    else if (tab === "documents") loadSources();
    else if (tab === "nontarget") loadNontarget();
    else if (tab === "messages") loadUserMessages();
  }, [tab, loadCodes, loadActivity, loadSources, loadNontarget, loadUserMessages]);

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
          device_limit: newDeviceLimit ? parseInt(newDeviceLimit) : null,
        }),
      });
      if (res.ok) {
        setNewCode("");
        setNewName("");
        setNewOrg("");
        setNewChatLimit("");
        setNewInfographicLimit("");
        setNewDeviceLimit("2");
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
          device_limit: editDeviceLimit ? parseInt(editDeviceLimit) : null,
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
    setEditDeviceLimit(c.device_limit !== null ? String(c.device_limit) : "");
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

  const changeSourceCategory = async (sourceId: number, folderPath: string) => {
    setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, folder_path: folderPath } : s)));
    setOpenMenuId(null);
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: folderPath }),
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
    // Auto-detect categories from tags
    setParsedFileCategories(parsed.map((pf) => detectCategoryClient(pf.tags, pf.filename)));
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
      formData.append("folderPath", parsedFileCategories[i] || "other");

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

  // Filter sources by category
  const filteredSources = docCategoryFilter === "all"
    ? sources
    : sources.filter((s) => (s.folder_path || "other") === docCategoryFilter);

  // Count per category
  const categoryCounts = DOC_CATEGORIES.reduce((acc, cat) => {
    acc[cat.key] = sources.filter((s) => (s.folder_path || "other") === cat.key).length;
    return acc;
  }, {} as Record<string, number>);

  /* ── Nav items config ── */
  const navItems = [
    { key: "activity" as const, label: "Активность", icon: "monitoring" },
    { key: "codes" as const, label: "Инвайт-коды", icon: "key" },
    { key: "documents" as const, label: "Документы", icon: "description" },
    { key: "nontarget" as const, label: "Нецелевые запросы", icon: "block" },
    { key: "messages" as const, label: "Сообщения", icon: "forum" },
  ];

  /* ── Render ── */

  return (
    <div className="admin-layout">
      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-logo">
          <div>
            <div className="admin-logo-title">СнабЧат</div>
            <div className="admin-logo-subtitle">Admin Panel</div>
          </div>
        </div>
        <nav className="admin-sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={`admin-sidebar-nav-item ${tab === item.key ? "active" : ""}`}
              onClick={() => setTab(item.key)}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <button className="admin-sidebar-nav-item">
            <span className="material-symbols-outlined">settings</span>
            <span>Настройки</span>
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="admin-main">
        {/* Top bar */}
        <header className="admin-topbar">
          <div className="admin-topbar-spacer" />
          <a href="/" className="admin-topbar-link">
            <span className="material-symbols-outlined">chat</span>
            К чату
          </a>
          <div className="admin-topbar-divider" />
          <div className="admin-topbar-user">
            <div className="admin-topbar-user-info">
              <span className="admin-topbar-user-name">{userName}</span>
              <span className="admin-topbar-user-role">Администратор</span>
            </div>
            <div className="admin-topbar-avatar">{getInitials(userName)}</div>
          </div>
          <div className="admin-topbar-divider" />
          <button onClick={onLogout} className="admin-topbar-logout">
            <span className="material-symbols-outlined">logout</span>
            Выйти
          </button>
        </header>

        {/* Workspace */}
        <div className="admin-workspace">
          <div className="admin-content">

            {/* ── Tab: Invite Codes ── */}
            {tab === "codes" && (
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
                    <div className="admin-form-field" style={{ width: 140 }}>
                      <label>Лимит устройств</label>
                      <input
                        placeholder="безлимит"
                        value={newDeviceLimit}
                        onChange={(e) => setNewDeviceLimit(e.target.value.replace(/\D/g, ""))}
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

                {/* Codes table */}
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Инвайт-коды</h3>
                      <span className="admin-card-badge">{filteredCodes.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      <div className="admin-form-field admin-search-field">
                        <input
                          placeholder="Поиск по имени или коду..."
                          value={searchName}
                          onChange={(e) => setSearchName(e.target.value)}
                        />
                      </div>
                      <button className="admin-btn-secondary" onClick={loadCodes} disabled={codesLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                        Обновить
                      </button>
                    </div>
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
                            <th>Устройства</th>
                            <th>Статус</th>
                            <th>Создан</th>
                            <th style={{ textAlign: "right" }}>Действия</th>
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
                                {c.device_limit === null ? (
                                  <span className="admin-text-muted">безлимит</span>
                                ) : (
                                  <span className={c.device_count >= c.device_limit ? "admin-text-danger" : ""}>
                                    {c.device_count}/{c.device_limit}
                                  </span>
                                )}
                              </td>
                              <td>
                                <span className={`admin-status ${c.is_active ? "active" : "inactive"}`}>
                                  {c.is_active ? "Активен" : "Отключён"}
                                </span>
                              </td>
                              <td className="admin-cell-date">{formatDate(c.created_at)}</td>
                              <td style={{ textAlign: "right" }}>
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
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Запросы пользователей</h3>
                      <span className="admin-card-badge">{activity.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      <button className="admin-btn-secondary" onClick={cleanupOrphanedConversations}>
                        <span className="material-symbols-outlined">delete_sweep</span>
                        Очистить старые
                      </button>
                      <button className="admin-btn-secondary" onClick={loadActivity} disabled={activityLoading}>
                        <span className="material-symbols-outlined">refresh</span>
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
                            <th style={{ textAlign: "right" }}>Время</th>
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
                              <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(a.created_at)}</td>
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
              <div onClick={() => setOpenMenuId(null)}>
                {/* Header */}
                <div className="admin-docs-header">
                  <h2 className="admin-card-title" style={{ fontSize: 24 }}>Документы</h2>
                  <div className="admin-card-actions">
                    <button className="admin-btn-secondary" onClick={loadSources} disabled={sourcesLoading}>
                      <span className="material-symbols-outlined">refresh</span>
                      Обновить
                    </button>
                    <button className="admin-btn-primary" onClick={() => setShowUpload(true)}>
                      <span className="material-symbols-outlined">add</span>
                      Загрузить документ
                    </button>
                  </div>
                </div>

                {/* Category filter pills */}
                <div className="admin-doc-pills">
                  <button
                    className={`admin-doc-pill ${docCategoryFilter === "all" ? "active" : ""}`}
                    onClick={() => setDocCategoryFilter("all")}
                  >
                    Все ({sources.length})
                  </button>
                  {DOC_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      className={`admin-doc-pill ${docCategoryFilter === cat.key ? "active" : ""}`}
                      onClick={() => setDocCategoryFilter(cat.key)}
                    >
                      {cat.label} ({categoryCounts[cat.key] || 0})
                    </button>
                  ))}
                </div>

                {/* Card grid */}
                {sourcesLoading ? (
                  <div className="admin-loading-text">
                    <div className="admin-spinner" />
                    Загрузка...
                  </div>
                ) : filteredSources.length === 0 ? (
                  <div className="admin-empty" style={{ padding: "80px 24px" }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>description</span>
                    <p>{sources.length === 0 ? "Нет загруженных документов" : "Нет документов в этой категории"}</p>
                    {sources.length === 0 && (
                      <p style={{ fontSize: 12, marginTop: 4 }}>Нажмите «Загрузить документ» чтобы добавить</p>
                    )}
                  </div>
                ) : (
                  <div className="admin-doc-grid">
                    {filteredSources.map((doc) => {
                      const ext = doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : "docx";
                      const isMenuOpen = openMenuId === doc.id;
                      return (
                        <div key={doc.id} className="admin-doc-card">
                          <div className="admin-doc-card-top">
                            <div className={`doc-icon-lg ${ext}`}>
                              {ext === "pdf" ? (
                                <span className="material-symbols-outlined">picture_as_pdf</span>
                              ) : ext === "xlsx" ? (
                                <span className="material-symbols-outlined">table_chart</span>
                              ) : (
                                <span className="material-symbols-outlined">description</span>
                              )}
                            </div>
                            <button
                              className="admin-doc-card-menu-btn"
                              onClick={(e) => { e.stopPropagation(); setOpenMenuId(isMenuOpen ? null : doc.id); }}
                            >
                              <span className="material-symbols-outlined">more_vert</span>
                            </button>
                            {isMenuOpen && (
                              <div className="admin-doc-card-dropdown" onClick={(e) => e.stopPropagation()}>
                                <div className="admin-doc-dropdown-label">Переместить в:</div>
                                {DOC_CATEGORIES.map((cat) => (
                                  <button
                                    key={cat.key}
                                    className={`admin-doc-dropdown-item ${(doc.folder_path || "other") === cat.key ? "active" : ""}`}
                                    onClick={() => changeSourceCategory(doc.id, cat.key)}
                                  >
                                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{cat.icon}</span>
                                    {cat.label}
                                  </button>
                                ))}
                                <div className="admin-doc-dropdown-divider" />
                                <button
                                  className="admin-doc-dropdown-item danger"
                                  onClick={() => { setOpenMenuId(null); deleteSource(doc.id); }}
                                >
                                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>
                                  Удалить
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="admin-doc-card-name" title={doc.filename}>{doc.filename}</div>
                          <div className="admin-doc-card-meta">
                            <span className="admin-doc-card-cat">{getCategoryLabel(doc.folder_path)}</span>
                            <span>&middot;</span>
                            <span>{formatDate(doc.created_at)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

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
                              <span className="material-symbols-outlined" style={{ fontSize: 40, opacity: 0.4, marginBottom: 8 }}>upload_file</span>
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
                              <div key={i} className="admin-card" style={{ marginBottom: 12 }}>
                                <div style={{ fontWeight: 500, marginBottom: 4 }}>{pf.filename}</div>
                                <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>
                                  {pf.totalChunks} чанков
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                  <label style={{ fontSize: 12, fontWeight: 500, color: "#64748B", display: "block", marginBottom: 4 }}>
                                    Категория
                                  </label>
                                  <select
                                    className="admin-category-select"
                                    value={parsedFileCategories[i] || "other"}
                                    onChange={(e) => {
                                      setParsedFileCategories((prev) => {
                                        const next = [...prev];
                                        next[i] = e.target.value;
                                        return next;
                                      });
                                    }}
                                  >
                                    {DOC_CATEGORIES.map((cat) => (
                                      <option key={cat.key} value={cat.key}>{cat.label}</option>
                                    ))}
                                  </select>
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
                            <span className="material-symbols-outlined">check_circle</span>
                            Готово!
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* ── Tab: Nontarget Queries ── */}
            {tab === "nontarget" && (
              <div>
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Нецелевые запросы</h3>
                      <span className="admin-card-badge">{nontargetQueries.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      <button className="admin-btn-secondary" onClick={loadNontarget} disabled={nontargetLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                        Обновить
                      </button>
                    </div>
                  </div>

                  {nontargetLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : nontargetQueries.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>block</span>
                      <p>Нет нецелевых запросов</p>
                      <p style={{ fontSize: 12, marginTop: 4 }}>Запросы без релевантных документов будут отображаться здесь</p>
                    </div>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th style={{ width: "15%" }}>ФИО</th>
                            <th style={{ width: "15%" }}>Организация</th>
                            <th style={{ width: "30%" }}>Запрос пользователя</th>
                            <th style={{ width: "30%" }}>Ответ системы</th>
                            <th style={{ width: "10%", textAlign: "right" }}>Время</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nontargetQueries.map((q) => (
                            <tr key={q.id}>
                              <td className="admin-cell-name">{q.user_name}</td>
                              <td>
                                {q.organization || <span className="admin-text-muted">—</span>}
                              </td>
                              <td className="admin-cell-title" title={q.user_question}>
                                {q.user_question}
                              </td>
                              <td className="admin-cell-title admin-text-muted" title={q.assistant_response}>
                                {q.assistant_response}
                              </td>
                              <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(q.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Tab: User Messages ── */}
            {tab === "messages" && (
              <div>
                <div className="admin-card admin-card-table">
                  <div className="admin-card-header">
                    <div className="admin-card-header-left">
                      <h3 className="admin-card-title">Сообщения пользователей</h3>
                      <span className="admin-card-badge">{userMessages.length}</span>
                    </div>
                    <div className="admin-card-actions">
                      <button className="admin-btn-secondary" onClick={loadUserMessages} disabled={messagesLoading}>
                        <span className="material-symbols-outlined">refresh</span>
                        Обновить
                      </button>
                    </div>
                  </div>

                  {messagesLoading ? (
                    <div className="admin-loading-text">
                      <div className="admin-spinner" />
                      Загрузка...
                    </div>
                  ) : userMessages.length === 0 ? (
                    <div className="admin-empty">
                      <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>forum</span>
                      <p>Нет сообщений</p>
                    </div>
                  ) : (
                    <div className="admin-table-wrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th style={{ width: "15%" }}>ФИО</th>
                            <th style={{ width: "15%" }}>Организация</th>
                            <th style={{ width: "55%" }}>Сообщение</th>
                            <th style={{ width: "15%", textAlign: "right" }}>Время</th>
                          </tr>
                        </thead>
                        <tbody>
                          {userMessages.map((m) => (
                            <tr key={m.id}>
                              <td className="admin-cell-name">{m.user_name}</td>
                              <td>
                                {m.organization || <span className="admin-text-muted">—</span>}
                              </td>
                              <td className="admin-cell-message">{m.content}</td>
                              <td className="admin-cell-date" style={{ textAlign: "right" }}>{formatDateTime(m.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
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
              <div className="admin-form-group">
                <label>Лимит устройств</label>
                <input
                  value={editDeviceLimit}
                  onChange={(e) => setEditDeviceLimit(e.target.value.replace(/\D/g, ""))}
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
