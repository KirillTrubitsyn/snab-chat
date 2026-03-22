"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/* ── Types ── */

interface InviteCode {
  id: string;
  code: string;
  name: string;
  uses_remaining: number | null;
  is_active: boolean;
  created_at: string;
  conversation_count: number;
}

interface ActivityItem {
  id: string;
  title: string;
  invite_code_id: string | null;
  invite_code_label: string;
  message_count: number;
  created_at: string;
  updated_at: string;
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
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminPanel({ adminCode, userName, onLogout }: AdminPanelProps) {
  const [tab, setTab] = useState<"codes" | "activity" | "documents">("codes");

  // Invite codes state
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newUses, setNewUses] = useState("");
  const [creating, setCreating] = useState(false);

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

  const headers = { "x-admin-code": adminCode };

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
          uses_remaining: newUses ? parseInt(newUses) : null,
        }),
      });
      if (res.ok) {
        setNewCode("");
        setNewName("");
        setNewUses("");
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

  /* ── Document actions ── */

  const deleteSource = async (sourceId: number) => {
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
          headers: { "x-admin-code": adminCode },
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
          headers: { "x-admin-code": adminCode },
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

  /* ── Render ── */

  return (
    <div className="admin-container">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header-left">
          <h1 className="admin-title">СнабЧат — Администрирование</h1>
          <span className="admin-user-name">{userName}</span>
        </div>
        <div className="admin-header-right">
          <a href="/" className="admin-chat-link">К чату</a>
          <button onClick={onLogout} className="admin-logout-btn">Выйти</button>
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

        {/* ── Tab: Invite Codes ── */}
        {tab === "codes" && (
          <div>
            {/* Create form */}
            <div className="admin-card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 12 }}>Создать новый код</h3>
              <div className="admin-form-row">
                <input
                  placeholder="Код (напр. ИВАНОВ-2024)"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                  className="admin-input"
                />
                <input
                  placeholder="ФИО получателя"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="admin-input"
                  style={{ flex: 2 }}
                />
                <input
                  placeholder="Лимит (пусто = безлимит)"
                  value={newUses}
                  onChange={(e) => setNewUses(e.target.value.replace(/\D/g, ""))}
                  className="admin-input"
                  style={{ width: 160 }}
                />
                <button
                  onClick={createCode}
                  disabled={creating || !newCode.trim() || !newName.trim()}
                  className="admin-btn-primary"
                >
                  {creating ? "..." : "Создать"}
                </button>
              </div>
            </div>

            {/* Codes list */}
            {codesLoading ? (
              <div className="admin-loading-text">Загрузка...</div>
            ) : codes.length === 0 ? (
              <div className="admin-empty">Нет инвайт-кодов</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Код</th>
                    <th>ФИО</th>
                    <th>Лимит</th>
                    <th>Диалоги</th>
                    <th>Статус</th>
                    <th>Создан</th>
                    <th>Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map((c) => (
                    <tr key={c.id}>
                      <td><code className="admin-code-badge">{c.code}</code></td>
                      <td>{c.name}</td>
                      <td>{c.uses_remaining === null ? "безлимит" : c.uses_remaining}</td>
                      <td>{c.conversation_count}</td>
                      <td>
                        <span className={`admin-status ${c.is_active ? "active" : "inactive"}`}>
                          {c.is_active ? "Активен" : "Отключён"}
                        </span>
                      </td>
                      <td style={{ fontSize: 12 }}>{formatDate(c.created_at)}</td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="admin-btn-sm"
                            onClick={() => toggleCodeActive(c.id, c.is_active)}
                          >
                            {c.is_active ? "Отключить" : "Включить"}
                          </button>
                          <button
                            className="admin-btn-sm admin-btn-danger"
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
            )}
          </div>
        )}

        {/* ── Tab: Activity ── */}
        {tab === "activity" && (
          <div>
            {activityLoading ? (
              <div className="admin-loading-text">Загрузка...</div>
            ) : activity.length === 0 ? (
              <div className="admin-empty">Нет активности</div>
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Диалог</th>
                    <th>Пользователь</th>
                    <th>Сообщений</th>
                    <th>Создан</th>
                    <th>Обновлён</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.title}
                      </td>
                      <td>{a.invite_code_label}</td>
                      <td>{a.message_count}</td>
                      <td style={{ fontSize: 12 }}>{formatDate(a.created_at)}</td>
                      <td style={{ fontSize: 12 }}>{formatDate(a.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Tab: Documents ── */}
        {tab === "documents" && (
          <div>
            <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
              <button
                className="admin-btn-primary"
                onClick={() => setShowUpload(true)}
              >
                Загрузить документы
              </button>
              <span style={{ alignSelf: "center", color: "var(--text-muted)", fontSize: 13 }}>
                {sources.length} документов
              </span>
            </div>

            {sourcesLoading ? (
              <div className="admin-loading-text">Загрузка...</div>
            ) : sources.length === 0 ? (
              <div className="admin-empty">Нет загруженных документов</div>
            ) : (
              <div className="admin-docs-list">
                {sources.map((doc) => {
                  const isExpanded = expandedSourceId === doc.id;
                  return (
                    <div key={doc.id} className="admin-doc-item">
                      <div
                        className="admin-doc-header"
                        onClick={() => {
                          setExpandedSourceId(isExpanded ? null : doc.id);
                          setSourceTagInput("");
                        }}
                      >
                        <div className={`doc-icon ${doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : "docx"}`}>
                          {doc.mime_type?.includes("pdf") ? "P" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "X" : "W"}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {doc.filename}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {doc.tags?.length || 0} тегов | {formatDate(doc.created_at)}
                          </div>
                        </div>
                        <button
                          className="admin-btn-sm admin-btn-danger"
                          onClick={(e) => { e.stopPropagation(); deleteSource(doc.id); }}
                        >
                          Удалить
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="admin-doc-details">
                          <div style={{ fontSize: 12, marginBottom: 4, fontWeight: 500 }}>Теги:</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                            {(doc.tags || []).map((tag) => (
                              <span key={tag} className="tag" style={{ fontSize: 12 }}>
                                {tag}
                                <button
                                  onClick={() => updateSourceTags(doc.id, doc.tags.filter((t) => t !== tag))}
                                  style={{ marginLeft: 4, fontSize: 13, color: "var(--text-muted)" }}
                                >
                                  x
                                </button>
                              </span>
                            ))}
                            <form
                              style={{ display: "inline-flex", gap: 4 }}
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
                                placeholder="+ тег"
                                className="admin-input"
                                style={{ width: 100, fontSize: 12, padding: "2px 6px" }}
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

            {/* Upload Modal */}
            {showUpload && (
              <div className="admin-modal-overlay" onClick={() => { if (uploadStage === "idle" || uploadStage === "done") { setShowUpload(false); setUploadStage("idle"); } }}>
                <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="admin-modal-header">
                    <h3>Загрузка документов</h3>
                    <button onClick={() => { setShowUpload(false); setUploadStage("idle"); setParsedFiles([]); setUploadFiles([]); }} className="admin-modal-close">x</button>
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
                        <button className="admin-btn-primary" onClick={() => fileInputRef.current?.click()}>
                          Выбрать файлы (DOCX, PDF, Excel)
                        </button>
                      </div>
                    )}
                    {uploadStage === "parsing" && (
                      <div className="admin-loading-text">Парсинг файлов...</div>
                    )}
                    {uploadStage === "review" && (
                      <div>
                        <p style={{ marginBottom: 12 }}>Готово к загрузке: {parsedFiles.length} файлов</p>
                        {parsedFiles.map((pf, i) => (
                          <div key={i} className="admin-card" style={{ marginBottom: 8 }}>
                            <div style={{ fontWeight: 500, marginBottom: 4 }}>{pf.filename}</div>
                            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                              {pf.totalChunks} чанков
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                              {pf.tags.map((tag) => (
                                <span key={tag} className="tag" style={{ fontSize: 11 }}>
                                  {tag}
                                  <button
                                    onClick={() => updateParsedFileTags(i, pf.tags.filter((t) => t !== tag))}
                                    style={{ marginLeft: 3, fontSize: 12 }}
                                  >
                                    x
                                  </button>
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                        <button className="admin-btn-primary" onClick={ingestFiles} style={{ marginTop: 12 }}>
                          Загрузить в базу знаний
                        </button>
                      </div>
                    )}
                    {uploadStage === "ingesting" && (
                      <div>
                        <div className="admin-loading-text">Индексация...</div>
                        <div className="admin-progress-bar">
                          <div className="admin-progress-fill" style={{ width: `${uploadProgress}%` }} />
                        </div>
                      </div>
                    )}
                    {uploadStage === "done" && (
                      <div className="admin-loading-text" style={{ color: "var(--success)" }}>
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
    </div>
  );
}
