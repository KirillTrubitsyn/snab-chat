"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import DocumentViewer, { DocumentSource } from "../DocumentViewer";
import KBSearchBar from "../KBSearchBar";
import {
  DOCUMENT_CATEGORIES,
  detectCategory,
  getCategoryLabel,
  normalizeFolderPath,
} from "@/app/lib/tagging";
import { formatDateShort } from "@/app/lib/date-utils";
import type { Source, ParsedFile } from "./types";

const DOC_CATEGORIES = DOCUMENT_CATEGORIES;

export default function DocumentsTab({ adminCode }: { adminCode: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [expandedSourceId, setExpandedSourceId] = useState<number | null>(null);
  const [sourceTagInput, setSourceTagInput] = useState("");
  const [docCategoryFilter, setDocCategoryFilter] = useState<string>("all");
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<number>>(new Set());
  const [viewingSource, setViewingSource] = useState<DocumentSource | null>(null);
  const [bulkSelectMode, setBulkSelectMode] = useState(false);

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [parsedFileCategories, setParsedFileCategories] = useState<string[]>([]);
  const [uploadStage, setUploadStage] = useState<"idle" | "parsing" | "review" | "ingesting" | "done">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const headers = { "x-admin-code": encodeURIComponent(adminCode) };

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const res = await fetch("/api/sources");
      const data = await res.json();
      if (data.sources) setSources(data.sources);
    } catch { /* ignore */ }
    setSourcesLoading(false);
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);

  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener("scroll", close, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", close, true);
  }, [openMenuId]);

  const deleteSource = async (sourceId: number) => {
    if (!confirm("Удалить этот документ из базы знаний?")) return;
    try {
      await fetch(`/api/sources?id=${sourceId}`, { method: "DELETE", headers });
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
    } catch { /* ignore */ }
  };

  const deleteSelectedSources = async () => {
    if (selectedSourceIds.size === 0) return;
    if (!confirm(`Удалить ${selectedSourceIds.size} документ(ов) из базы знаний?`)) return;
    try {
      const ids = Array.from(selectedSourceIds);
      await fetch("/api/sources", {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      setSources((prev) => prev.filter((s) => !selectedSourceIds.has(s.id)));
      setSelectedSourceIds(new Set());
      setBulkSelectMode(false);
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

  const recategorizeAll = async () => {
    const updates: { id: number; folderPath: string }[] = [];
    for (const s of sources) {
      const detected = detectCategory(s.tags || [], s.filename);
      if (detected !== normalizeFolderPath(s.folder_path)) {
        updates.push({ id: s.id, folderPath: detected });
      }
    }
    if (updates.length === 0) return;
    setSources((prev) =>
      prev.map((s) => {
        const u = updates.find((x) => x.id === s.id);
        return u ? { ...s, folder_path: u.folderPath } : s;
      })
    );
    let updated = 0;
    for (const u of updates) {
      try {
        await fetch(`/api/sources?id=${u.id}`, {
          method: "PATCH",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ folder_path: u.folderPath }),
        });
        updated++;
      } catch { /* ignore */ }
    }
    alert(`Категории обновлены: ${updated} документов`);
  };

  const startRename = (doc: Source) => {
    setRenamingId(doc.id);
    setRenameValue(doc.filename);
    setOpenMenuId(null);
  };

  const saveRename = async (sourceId: number) => {
    const newName = renameValue.trim();
    if (!newName) { setRenamingId(null); return; }
    setSources((prev) => prev.map((s) => (s.id === sourceId ? { ...s, filename: newName } : s)));
    setRenamingId(null);
    try {
      await fetch(`/api/sources?id=${sourceId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: newName }),
      });
    } catch { /* ignore */ }
  };

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

        // For large files, upload to Storage first to bypass Vercel 4.5MB body limit
        if (file.size > LARGE_FILE_THRESHOLD) {
          const storagePath = await uploadLargeFile(file);
          if (storagePath) {
            formData.append("storagePath", storagePath);
            formData.append("filename", file.name);
            formData.append("mimeType", file.type);
          } else {
            // Fallback: try direct upload anyway
            formData.append("file", file);
          }
        } else {
          formData.append("file", file);
        }

        const res = await fetch("/api/parse", {
          method: "POST",
          headers: { "x-admin-code": encodeURIComponent(adminCode) },
          body: formData,
        });
        if (res.ok) parsed.push(await res.json());
      } catch { /* ignore */ }
    }
    setParsedFiles(parsed);
    setParsedFileCategories(parsed.map((pf) => detectCategory(pf.tags, pf.filename)));
    setUploadStage(parsed.length > 0 ? "review" : "idle");
  };

  const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024; // 4 MB

  const uploadLargeFile = async (file: File): Promise<string | null> => {
    try {
      const res = await fetch("/api/upload-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-code": encodeURIComponent(adminCode),
        },
        body: JSON.stringify({ filename: file.name, mimeType: file.type }),
      });
      if (!res.ok) return null;
      const { uploadUrl, storagePath, token } = await res.json();
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": file.type,
          "x-upsert": "false",
        },
        body: file,
      });
      return putRes.ok ? storagePath : null;
    } catch {
      return null;
    }
  };

  const ingestFiles = async () => {
    setUploadStage("ingesting");
    setUploadProgress(0);
    for (let i = 0; i < parsedFiles.length; i++) {
      const pf = parsedFiles[i];
      const file = uploadFiles.find((f) => f.name === pf.filename);
      const formData = new FormData();

      // Reuse storagePath from parse step if available, otherwise upload
      if (pf.storagePath) {
        formData.append("storagePath", pf.storagePath);
      } else if (file && file.size > LARGE_FILE_THRESHOLD) {
        const storagePath = await uploadLargeFile(file);
        if (storagePath) {
          formData.append("storagePath", storagePath);
        }
      } else if (file) {
        formData.append("file", file);
      }

      formData.append("filename", pf.filename);
      formData.append("mimeType", pf.mimeType);
      formData.append("markdown", pf.markdown);
      formData.append("tags", JSON.stringify(pf.tags));
      // Pass images only for small files; large files re-extract from Storage
      if (!pf.storagePath && pf.images && pf.images.length > 0) {
        formData.append("images", JSON.stringify(pf.images));
      }
      formData.append("folderPath", parsedFileCategories[i] || "standards");
      try {
        const ingestRes = await fetch("/api/ingest", {
          method: "POST",
          headers: { "x-admin-code": encodeURIComponent(adminCode) },
          body: formData,
        });
        if (!ingestRes.ok) {
          const errData = await ingestRes.json().catch(() => ({}));
          console.error(`[ingest] Failed for ${pf.filename}:`, ingestRes.status, errData);
          alert(`Ошибка индексации "${pf.filename}": ${errData.error || ingestRes.statusText}`);
        } else {
          const result = await ingestRes.json();
          console.log(`[ingest] OK: ${result.filename} — ${result.chunksInserted} чанков, ${result.imagesUploaded} изображений`);
        }
      } catch (err) {
        console.error(`[ingest] Network error for ${pf.filename}:`, err);
        alert(`Сетевая ошибка при индексации "${pf.filename}"`);
      }
      setUploadProgress(((i + 1) / parsedFiles.length) * 100);
    }
    setUploadStage("done");
    loadSources();
    setTimeout(() => {
      setShowUpload(false); setUploadStage("idle");
      setUploadFiles([]); setParsedFiles([]);
    }, 1500);
  };

  const updateParsedFileTags = (index: number, tags: string[]) => {
    setParsedFiles((prev) => prev.map((f, i) => (i === index ? { ...f, tags } : f)));
  };

  const filteredSources = docCategoryFilter === "all"
    ? sources
    : sources.filter((s) => normalizeFolderPath(s.folder_path) === docCategoryFilter);

  const categoryCounts = DOC_CATEGORIES.reduce((acc, cat) => {
    acc[cat.key] = sources.filter((s) => normalizeFolderPath(s.folder_path) === cat.key).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <>
      <div onClick={() => setOpenMenuId(null)}>
        {/* Header */}
        <div className="admin-docs-header">
          <h2 className="admin-card-title" style={{ fontSize: 24 }}>Документы</h2>
          <div className="admin-card-actions">
            {!bulkSelectMode ? (
              <>
                {sources.length > 0 && (
                  <button className="admin-btn-secondary" onClick={() => setBulkSelectMode(true)}>
                    <span className="material-symbols-outlined">checklist</span>Выбрать
                  </button>
                )}
                <button className="admin-btn-secondary" onClick={recategorizeAll}>
                  <span className="material-symbols-outlined">auto_fix_high</span>Пересортировать
                </button>
                <button className="admin-btn-secondary" onClick={loadSources} disabled={sourcesLoading}>
                  <span className="material-symbols-outlined">refresh</span>Обновить
                </button>
                <button className="admin-btn-primary" onClick={() => setShowUpload(true)}>
                  <span className="material-symbols-outlined">add</span>Загрузить документ
                </button>
              </>
            ) : (
              <>
                <button className="admin-btn-secondary" onClick={() => {
                  const allSelected = filteredSources.length > 0 && filteredSources.every((s) => selectedSourceIds.has(s.id));
                  if (allSelected) setSelectedSourceIds(new Set());
                  else setSelectedSourceIds(new Set(filteredSources.map((s) => s.id)));
                }}>
                  <span className="material-symbols-outlined">
                    {filteredSources.length > 0 && filteredSources.every((s) => selectedSourceIds.has(s.id)) ? "deselect" : "select_all"}
                  </span>
                  {filteredSources.length > 0 && filteredSources.every((s) => selectedSourceIds.has(s.id)) ? "Снять всё" : "Выбрать все"}
                </button>
                <button className="admin-btn-secondary" style={{ color: selectedSourceIds.size > 0 ? "var(--admin-danger, #ef4444)" : undefined }} disabled={selectedSourceIds.size === 0} onClick={deleteSelectedSources}>
                  <span className="material-symbols-outlined">delete</span>Удалить ({selectedSourceIds.size})
                </button>
                <button className="admin-btn-secondary" onClick={() => { setSelectedSourceIds(new Set()); setBulkSelectMode(false); }}>
                  <span className="material-symbols-outlined">close</span>Отмена
                </button>
              </>
            )}
          </div>
        </div>

        {/* Category filter pills */}
        <div className="admin-doc-pills">
          <button className={`admin-doc-pill ${docCategoryFilter === "all" ? "active" : ""}`} onClick={() => setDocCategoryFilter("all")}>
            Все ({sources.length})
          </button>
          {DOC_CATEGORIES.map((cat) => (
            <button key={cat.key} className={`admin-doc-pill ${docCategoryFilter === cat.key ? "active" : ""}`} onClick={() => setDocCategoryFilter(cat.key)}>
              {cat.label} ({categoryCounts[cat.key] || 0})
            </button>
          ))}
        </div>

        {/* Card grid */}
        {sourcesLoading ? (
          <div className="admin-loading-text"><div className="admin-spinner" />Загрузка...</div>
        ) : filteredSources.length === 0 ? (
          <div className="admin-empty" style={{ padding: "80px 24px" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>description</span>
            <p>{sources.length === 0 ? "Нет загруженных документов" : "Нет документов в этой категории"}</p>
            {sources.length === 0 && <p style={{ fontSize: 12, marginTop: 4 }}>Нажмите «Загрузить документ» чтобы добавить</p>}
          </div>
        ) : (<>
          <KBSearchBar
            inviteCode={adminCode}
            mode="admin"
            onOpenDocument={(sourceId) => {
              const src = sources.find(s => String(s.id) === String(sourceId));
              if (src) setViewingSource(src);
            }}
            onDownload={(sourceId) => {
              window.open("/api/sources/download?id=" + sourceId + "&action=download&token=" + encodeURIComponent(adminCode), "_blank");
            }}
          />
          <div className="admin-doc-list-view">
            {filteredSources.map((doc) => {
              const ext = doc.mime_type?.includes("pdf") ? "pdf" : doc.mime_type?.includes("sheet") || doc.mime_type?.includes("excel") ? "xlsx" : doc.mime_type?.includes("presentationml") || doc.filename?.endsWith(".pptx") || doc.filename?.endsWith(".ppt") ? "pptx" : doc.mime_type?.includes("html") || doc.filename?.endsWith(".html") || doc.filename?.endsWith(".htm") ? "html" : "docx";
              const isMenuOpen = openMenuId === doc.id;
              return (
                <div key={doc.id} className={`admin-doc-row-wrapper${expandedSourceId === doc.id ? " expanded" : ""}`}>
                <div className="admin-doc-row" onClick={() => {
                  if (bulkSelectMode) {
                    setSelectedSourceIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(doc.id)) next.delete(doc.id); else next.add(doc.id);
                      return next;
                    });
                    return;
                  }
                  setExpandedSourceId(expandedSourceId === doc.id ? null : doc.id);
                }} style={{ cursor: "pointer" }}>
                  {bulkSelectMode && (
                    <input
                      type="checkbox"
                      checked={selectedSourceIds.has(doc.id)}
                      onChange={() => {
                        setSelectedSourceIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(doc.id)) next.delete(doc.id); else next.add(doc.id);
                          return next;
                        });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ width: 18, height: 18, flexShrink: 0, cursor: "pointer", accentColor: "var(--admin-primary, #3b82f6)" }}
                    />
                  )}
                  <div className={`doc-icon-lg ${ext}`}>
                    {ext === "pdf" ? (
                      <span className="material-symbols-outlined">picture_as_pdf</span>
                    ) : ext === "xlsx" ? (
                      <span className="material-symbols-outlined">table_chart</span>
                    ) : ext === "pptx" ? (
                      <span className="material-symbols-outlined">slideshow</span>
                    ) : ext === "html" ? (
                      <span className="material-symbols-outlined">school</span>
                    ) : (
                      <span className="material-symbols-outlined">description</span>
                    )}
                  </div>
                  <div className="admin-doc-row-info">
                    {renamingId === doc.id ? (
                      <form className="admin-doc-rename-form" onSubmit={(e) => { e.preventDefault(); saveRename(doc.id); }}>
                        <input
                          className="admin-doc-rename-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => saveRename(doc.id)}
                          onKeyDown={(e) => { if (e.key === "Escape") setRenamingId(null); }}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      </form>
                    ) : (
                      <div className="admin-doc-row-name">{doc.filename}</div>
                    )}
                    <div className="admin-doc-row-meta">
                      <span className="admin-doc-row-cat">{getCategoryLabel(doc.folder_path)}</span>
                      <span>&middot;</span>
                      <span>{formatDateShort(doc.created_at)}</span>
                      <span>&middot;</span>
                      <span className="admin-doc-row-tags-count">
                        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>label</span>
                        {doc.tags?.length || 0} тегов
                      </span>
                    </div>
                  </div>
                  <div className="admin-doc-row-actions">
                    <button className="admin-doc-action-btn" title="Просмотр" onClick={(e) => { e.stopPropagation(); setViewingSource(doc); }}>
                      <span className="material-symbols-outlined">visibility</span>
                    </button>
                    <a href={`/api/sources/download?id=${doc.id}&action=download&token=${encodeURIComponent(adminCode)}`} className="admin-doc-action-btn" title="Скачать" onClick={(e) => e.stopPropagation()}>
                      <span className="material-symbols-outlined">download</span>
                    </a>
                    <div style={{ position: "relative" }}>
                      <button className="admin-doc-action-btn" onClick={(e) => { e.stopPropagation(); setOpenMenuId(isMenuOpen ? null : doc.id); }} title="Действия">
                        <span className="material-symbols-outlined">more_vert</span>
                      </button>
                      {isMenuOpen && (
                        <div
                          className="admin-doc-card-dropdown"
                          ref={(el) => {
                            if (el && el.parentElement) {
                              const btn = el.parentElement.querySelector(".admin-doc-action-btn");
                              if (btn) {
                                const btnRect = btn.getBoundingClientRect();
                                const dropH = el.offsetHeight;
                                const spaceBelow = window.innerHeight - btnRect.bottom;
                                if (spaceBelow < dropH + 8) {
                                  el.style.top = (btnRect.top - dropH - 4) + "px";
                                } else {
                                  el.style.top = (btnRect.bottom + 4) + "px";
                                }
                                el.style.right = (window.innerWidth - btnRect.right) + "px";
                              }
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="admin-doc-dropdown-label">Переместить в:</div>
                          {DOC_CATEGORIES.map((cat) => (
                            <button key={cat.key} className={`admin-doc-dropdown-item ${(doc.folder_path || "other") === cat.key ? "active" : ""}`} onClick={() => changeSourceCategory(doc.id, cat.key)}>
                              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{cat.icon}</span>
                              {cat.label}
                            </button>
                          ))}
                          <div className="admin-doc-dropdown-divider" />
                          <button className="admin-doc-dropdown-item" onClick={() => startRename(doc)}>
                            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>edit</span>Переименовать
                          </button>
                          <button className="admin-doc-dropdown-item danger" onClick={() => { setOpenMenuId(null); deleteSource(doc.id); }}>
                            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>delete</span>Удалить
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {expandedSourceId === doc.id && (
                  <div className="admin-doc-tags-panel" onClick={(e) => e.stopPropagation()}>
                    <div className="admin-doc-tags-list">
                      {(doc.tags || []).length === 0 && <span className="admin-doc-tags-empty">Нет тегов</span>}
                      {(doc.tags || []).map((tag) => (
                        <span key={tag} className="admin-tag">
                          {tag}
                          <button onClick={() => updateSourceTags(doc.id, doc.tags.filter((t) => t !== tag))} className="admin-tag-remove">&times;</button>
                        </span>
                      ))}
                    </div>
                    <form className="admin-doc-tag-add-form" onSubmit={(e) => {
                      e.preventDefault();
                      const val = sourceTagInput.trim();
                      if (val && !(doc.tags || []).includes(val)) updateSourceTags(doc.id, [...(doc.tags || []), val]);
                      setSourceTagInput("");
                    }}>
                      <input className="admin-doc-tag-input" placeholder="Добавить тег..." value={expandedSourceId === doc.id ? sourceTagInput : ""} onChange={(e) => setSourceTagInput(e.target.value)} autoFocus />
                      <button type="submit" className="admin-doc-tag-add-btn">
                        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add</span>
                      </button>
                    </form>
                  </div>
                )}
                </div>
              );
            })}
          </div>
        </>)}

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
                    <input ref={fileInputRef} type="file" multiple accept=".docx,.pdf,.xlsx,.xls,.pptx,.html,.htm" style={{ display: "none" }} onChange={(e) => handleFilesSelected(e.target.files)} />
                    <div className="admin-upload-area" onClick={() => fileInputRef.current?.click()}>
                      <span className="material-symbols-outlined" style={{ fontSize: 40, opacity: 0.4, marginBottom: 8 }}>upload_file</span>
                      <p>Нажмите для выбора файлов</p>
                      <p className="hint">DOCX, PDF, Excel</p>
                    </div>
                  </div>
                )}
                {uploadStage === "parsing" && (
                  <div className="admin-loading-text"><div className="admin-spinner" />Парсинг файлов...</div>
                )}
                {uploadStage === "review" && (
                  <div>
                    <p style={{ marginBottom: 16, fontWeight: 500 }}>Готово к загрузке: {parsedFiles.length} файлов</p>
                    {parsedFiles.map((pf, i) => (
                      <div key={i} className="admin-card" style={{ marginBottom: 12 }}>
                        <div style={{ fontWeight: 500, marginBottom: 4 }}>{pf.filename}</div>
                        <div style={{ fontSize: 12, color: "#64748B", marginBottom: 8 }}>{pf.totalChunks} чанков</div>
                        <div style={{ marginBottom: 8 }}>
                          <label style={{ fontSize: 12, fontWeight: 500, color: "#64748B", display: "block", marginBottom: 4 }}>Категория</label>
                          <select className="admin-category-select" value={parsedFileCategories[i] || "standards"} onChange={(e) => {
                            setParsedFileCategories((prev) => { const next = [...prev]; next[i] = e.target.value; return next; });
                          }}>
                            {DOC_CATEGORIES.map((cat) => (<option key={cat.key} value={cat.key}>{cat.label}</option>))}
                          </select>
                        </div>
                        <div className="admin-doc-tags">
                          {pf.tags.map((tag) => (
                            <span key={tag} className="admin-tag">
                              {tag}
                              <button onClick={() => updateParsedFileTags(i, pf.tags.filter((t) => t !== tag))} className="admin-tag-remove">&times;</button>
                            </span>
                          ))}
                          <form className="admin-doc-tag-add-form" onSubmit={(e) => {
                            e.preventDefault();
                            const input = e.currentTarget.querySelector("input") as HTMLInputElement;
                            const val = input.value.trim().toLowerCase();
                            if (val && !pf.tags.includes(val)) updateParsedFileTags(i, [...pf.tags, val]);
                            input.value = "";
                          }}>
                            <input className="admin-doc-tag-input" placeholder="+ добавить тег" onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
                            <button type="submit" className="admin-doc-tag-add-btn">
                              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
                            </button>
                          </form>
                        </div>
                      </div>
                    ))}
                    <button className="admin-btn-primary" onClick={ingestFiles} style={{ marginTop: 16, width: "100%" }}>Загрузить в базу знаний</button>
                  </div>
                )}
                {uploadStage === "ingesting" && (
                  <div>
                    <div className="admin-loading-text"><div className="admin-spinner" />Индексация...</div>
                    <div className="admin-progress-bar"><div className="admin-progress-fill" style={{ width: `${uploadProgress}%` }} /></div>
                  </div>
                )}
                {uploadStage === "done" && (
                  <div className="admin-loading-text admin-success-text">
                    <span className="material-symbols-outlined">check_circle</span>Готово!
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {viewingSource && <DocumentViewer source={viewingSource} onClose={() => setViewingSource(null)} authCode={adminCode} />}
    </>
  );
}
