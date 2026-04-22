"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { apiUrl, getAuthHeaders } from "@/app/lib/api";

/* ── Типы ── */

export interface SiblingChunk {
  content: string;
  chunk_index: number;
}

export interface KBSearchResult {
  source_id: string;
  filename: string;
  folder_path: string | null;
  mime_type: string | null;
  tags: string[];
  content_preview: string | null;
  created_at: string;
  best_chunk: string | null;
  similarity: number;
  chunk_count: number;
  match_type: "fts" | "semantic" | "both";
  /** Ключ группы (Parent-Child) */
  parent_group_key: string | null;
  /** Все чанки из parent-группы */
  sibling_chunks: SiblingChunk[];
  /** Имя оригинального файла */
  original_filename: string | null;
  /** URL для скачивания оригинала */
  original_file_url: string | null;
}

interface KBSearchBarProps {
  inviteCode?: string;
  folder?: string | null;
  onOpenDocument?: (sourceId: string, filename: string) => void;
  onDownload?: (sourceId: string, filename: string) => void;
  /** Вызывается при клике «Скачать оригинал» */
  onDownloadOriginal?: (originalFileUrl: string, originalFilename: string) => void;
  className?: string;
  mode?: "admin" | "chat";
}

/* ── Иконки (Material Symbols outline, 20px) ── */

const ICON = {
  search: "search",
  close: "close",
  folder: "folder",
  description: "description",
  visibility: "visibility",
  download: "download",
  source: "attach_file",
  tag: "label",
  bolt: "bolt",
  text: "text_fields",
  join: "join",
  expand: "expand_more",
  collapse: "expand_less",
  context: "account_tree",
} as const;

/* ── Вспомогательные функции ── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function highlightMatches(text: string, query: string): string {
  const escaped = escapeHtml(text);
  if (!query.trim()) return escaped;
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return escaped;
  const regex = new RegExp(`(${words.join("|")})`, "gi");
  return escaped.replace(regex, "<mark>$1</mark>");
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function matchTypeLabel(type: "fts" | "semantic" | "both"): {
  icon: string;
  label: string;
  color: string;
} {
  switch (type) {
    case "both":
      return { icon: ICON.join, label: "Полное совпадение", color: "#4caf50" };
    case "semantic":
      return { icon: ICON.bolt, label: "По смыслу", color: "#2196f3" };
    case "fts":
      return { icon: ICON.text, label: "По тексту", color: "#ff9800" };
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

/* ── Компонент ── */

export default function KBSearchBar({
  inviteCode,
  folder = null,
  onOpenDocument,
  onDownload,
  onDownloadOriginal,
  className = "",
  mode = "chat",
}: KBSearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KBSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ── Поиск ── */

  const doSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        setSearched(false);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(apiUrl("/api/kb-search"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            query: q.trim(),
            limit: 20,
            folder,
            include_siblings: true,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Ошибка ${res.status}`);
        }

        const data = await res.json();
        setResults(data.results ?? []);
        setSearched(true);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError("Не удалось выполнить поиск");
        console.error("KB search error:", err);
      } finally {
        setLoading(false);
      }
    },
    [inviteCode, folder]
  );

  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => doSearch(value), 400);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      doSearch(query);
    }
    if (e.key === "Escape") {
      clearSearch();
    }
  };

  const clearSearch = () => {
    setQuery("");
    setResults([]);
    setSearched(false);
    setError(null);
    inputRef.current?.focus();
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  /* ── Рендер ── */

  const isCompact = mode === "chat";

  return (
    <div className={`kb-search ${className}`}>
      {/* ── Строка поиска ── */}
      <div className="kb-search__input-wrap">
        <span className="material-symbols-outlined kb-search__icon">
          {ICON.search}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="kb-search__input"
          placeholder="Поиск по базе знаний…"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button
            className="kb-search__clear"
            onClick={clearSearch}
            title="Очистить"
            type="button"
          >
            <span className="material-symbols-outlined">{ICON.close}</span>
          </button>
        )}
        {loading && <div className="kb-search__spinner" />}
      </div>

      {/* ── Результаты ── */}
      {searched && (
        <div className="kb-search__results">
          {error && <div className="kb-search__error">{error}</div>}

          {!error && results.length === 0 && (
            <div className="kb-search__empty">
              Ничего не найдено по запросу «{query}»
            </div>
          )}

          {results.length > 0 && (
            <>
              <div className="kb-search__count">
                Найдено: {results.length} документ
                {results.length % 10 === 1 && results.length % 100 !== 11
                  ? ""
                  : results.length % 10 >= 2 &&
                      results.length % 10 <= 4 &&
                      (results.length % 100 < 10 || results.length % 100 >= 20)
                    ? "а"
                    : "ов"}
              </div>

              <div className="kb-search__list">
                {results.map((r) => (
                  <SearchResultCard
                    key={r.source_id}
                    result={r}
                    query={query}
                    compact={isCompact}
                    onOpen={onOpenDocument}
                    onDownload={onDownload}
                    onDownloadOriginal={onDownloadOriginal}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <style>{styles}</style>
    </div>
  );
}

/* ── Карточка результата ── */

function SearchResultCard({
  result,
  query,
  compact,
  onOpen,
  onDownload,
  onDownloadOriginal,
}: {
  result: KBSearchResult;
  query: string;
  compact: boolean;
  onOpen?: (sourceId: string, filename: string) => void;
  onDownload?: (sourceId: string, filename: string) => void;
  onDownloadOriginal?: (originalFileUrl: string, originalFilename: string) => void;
}) {
  const [showSiblings, setShowSiblings] = useState(false);
  const mt = matchTypeLabel(result.match_type);
  const hasSiblings = result.sibling_chunks && result.sibling_chunks.length > 1;
  const hasOriginal = result.original_file_url && result.original_filename;

  return (
    <div className="kb-card">
      {/* Заголовок */}
      <div className="kb-card__header">
        <span className="material-symbols-outlined kb-card__file-icon">
          {ICON.description}
        </span>
        <div className="kb-card__title-wrap">
          <div
            className="kb-card__filename"
            dangerouslySetInnerHTML={{
              __html: highlightMatches(result.filename, query),
            }}
          />
          {result.folder_path && (
            <div className="kb-card__folder">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {ICON.folder}
              </span>
              {result.folder_path}
            </div>
          )}
          {/* Имя оригинального файла, если отличается */}
          {hasOriginal && result.original_filename !== result.filename && (
            <div className="kb-card__original-name">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                {ICON.source}
              </span>
              Оригинал: {result.original_filename}
            </div>
          )}
        </div>
        {/* Бейдж типа совпадения */}
        <span className="kb-card__badge" style={{ background: mt.color }}>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
            {mt.icon}
          </span>
          {!compact && mt.label}
        </span>
      </div>

      {/* Превью лучшего фрагмента */}
      {result.best_chunk && (
        <div
          className="kb-card__chunk"
          dangerouslySetInnerHTML={{
            __html: highlightMatches(
              truncate(result.best_chunk, compact ? 150 : 300),
              query
            ),
          }}
        />
      )}

      {/* Кнопка раскрытия контекста (Parent-Child siblings) */}
      {hasSiblings && (
        <button
          className="kb-card__siblings-toggle"
          onClick={() => setShowSiblings(!showSiblings)}
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
            {showSiblings ? ICON.collapse : ICON.expand}
          </span>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
            {ICON.context}
          </span>
          {showSiblings
            ? "Скрыть контекст"
            : `Показать контекст (${result.sibling_chunks.length} фрагментов)`}
        </button>
      )}

      {/* Раскрытый контекст: все sibling-чанки */}
      {showSiblings && hasSiblings && (
        <div className="kb-card__siblings">
          {result.sibling_chunks.map((s, i) => (
            <div
              key={i}
              className={`kb-card__sibling ${
                s.content === result.best_chunk ? "kb-card__sibling--active" : ""
              }`}
            >
              <span className="kb-card__sibling-index">{s.chunk_index + 1}</span>
              <div
                dangerouslySetInnerHTML={{
                  __html: highlightMatches(s.content, query),
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Мета-информация */}
      {!compact && (
        <div className="kb-card__meta">
          {result.chunk_count > 0 && (
            <span className="kb-card__meta-item">
              Совпадений: {result.chunk_count}
            </span>
          )}
          <span className="kb-card__meta-item">
            {formatDate(result.created_at)}
          </span>
          {result.similarity > 0 && (
            <span className="kb-card__meta-item">
              Релевантность: {Math.round(result.similarity * 100)}%
            </span>
          )}
        </div>
      )}

      {/* Теги (только admin) */}
      {!compact && result.tags.length > 0 && (
        <div className="kb-card__tags">
          {result.tags
            .filter((t) => t !== "денормализовано")
            .slice(0, 5)
            .map((tag) => (
              <span key={tag} className="kb-card__tag">
                {tag}
              </span>
            ))}
        </div>
      )}

      {/* Действия */}
      <div className="kb-card__actions">
        {onOpen && (
          <button
            className="kb-card__btn kb-card__btn--preview"
            onClick={() => onOpen(result.source_id, result.filename)}
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              {ICON.visibility}
            </span>
            Просмотр
          </button>
        )}
        {onDownload && (
          <button
            className="kb-card__btn kb-card__btn--download"
            onClick={() => onDownload(result.source_id, result.filename)}
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              {ICON.download}
            </span>
            Скачать
          </button>
        )}
        {/* Кнопка скачивания оригинального файла */}
        {hasOriginal && onDownloadOriginal && (
          <button
            className="kb-card__btn kb-card__btn--original"
            onClick={() =>
              onDownloadOriginal(
                result.original_file_url!,
                result.original_filename!
              )
            }
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              {ICON.source}
            </span>
            Скачать оригинал
          </button>
        )}
      </div>
    </div>
  );
}

/* ── CSS ── */

const styles = `
/* ── Контейнер ── */
.kb-search {
  width: 100%;
  position: relative;
}

/* ── Строка поиска ── */
.kb-search__input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface, #f5f5f5);
  border: 1.5px solid var(--border, #e0e0e0);
  border-radius: 12px;
  padding: 8px 14px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.kb-search__input-wrap:focus-within {
  border-color: var(--primary, #1976d2);
  box-shadow: 0 0 0 3px rgba(25, 118, 210, 0.12);
}
.kb-search__icon {
  font-size: 20px;
  color: var(--text-secondary, #757575);
  flex-shrink: 0;
}
.kb-search__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  color: var(--text-primary, #212121);
  font-family: inherit;
  min-width: 0;
}
.kb-search__input::placeholder {
  color: var(--text-secondary, #9e9e9e);
}
.kb-search__clear {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  border-radius: 50%;
  color: var(--text-secondary, #757575);
  transition: background 0.15s;
}
.kb-search__clear:hover {
  background: rgba(0, 0, 0, 0.08);
}
.kb-search__clear .material-symbols-outlined {
  font-size: 18px;
}

/* ── Спиннер ── */
.kb-search__spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border, #e0e0e0);
  border-top-color: var(--primary, #1976d2);
  border-radius: 50%;
  animation: kb-spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes kb-spin {
  to { transform: rotate(360deg); }
}

/* ── Результаты ── */
.kb-search__results {
  margin-top: 12px;
}
.kb-search__error {
  padding: 12px;
  background: #fce4ec;
  color: #c62828;
  border-radius: 8px;
  font-size: 14px;
}
.kb-search__empty {
  padding: 20px 12px;
  text-align: center;
  color: var(--text-secondary, #757575);
  font-size: 14px;
}
.kb-search__count {
  font-size: 13px;
  color: var(--text-secondary, #757575);
  margin-bottom: 8px;
  padding-left: 2px;
}
.kb-search__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Карточка документа ── */
.kb-card {
  background: var(--surface, #ffffff);
  border: 1px solid var(--border, #e0e0e0);
  border-radius: 10px;
  padding: 12px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.kb-card:hover {
  border-color: var(--primary, #1976d2);
  box-shadow: 0 2px 8px rgba(25, 118, 210, 0.08);
}

/* Заголовок */
.kb-card__header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.kb-card__file-icon {
  font-size: 22px;
  color: var(--primary, #1976d2);
  flex-shrink: 0;
  margin-top: 1px;
}
.kb-card__title-wrap {
  flex: 1;
  min-width: 0;
}
.kb-card__filename {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #212121);
  word-break: break-word;
}
.kb-card__filename mark {
  background: #fff3cd;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.kb-card__folder {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary, #757575);
  margin-top: 2px;
}
.kb-card__original-name {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary, #9e9e9e);
  margin-top: 2px;
  font-style: italic;
}
.kb-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* Фрагмент */
.kb-card__chunk {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-secondary, #616161);
  line-height: 1.5;
  padding: 8px 10px;
  background: var(--surface-dim, #f9f9f9);
  border-radius: 6px;
  border-left: 3px solid var(--primary, #1976d2);
}
.kb-card__chunk mark {
  background: #fff3cd;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

/* Кнопка раскрытия контекста */
.kb-card__siblings-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--primary, #1976d2);
  background: rgba(25, 118, 210, 0.06);
  border: 1px solid rgba(25, 118, 210, 0.15);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
  font-family: inherit;
}
.kb-card__siblings-toggle:hover {
  background: rgba(25, 118, 210, 0.12);
}

/* Раскрытый контекст (sibling-чанки) */
.kb-card__siblings {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid var(--border, #e8e8e8);
  border-radius: 8px;
  padding: 6px;
}
.kb-card__sibling {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary, #616161);
  border-radius: 4px;
  transition: background 0.1s;
}
.kb-card__sibling:hover {
  background: rgba(0, 0, 0, 0.03);
}
.kb-card__sibling--active {
  background: rgba(25, 118, 210, 0.06);
  border-left: 2px solid var(--primary, #1976d2);
}
.kb-card__sibling-index {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary, #9e9e9e);
  background: var(--surface-dim, #f0f0f0);
  border-radius: 50%;
}
.kb-card__sibling mark {
  background: #fff3cd;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

/* Мета */
.kb-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary, #9e9e9e);
}
.kb-card__meta-item {
  white-space: nowrap;
}

/* Теги */
.kb-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.kb-card__tag {
  font-size: 11px;
  padding: 2px 8px;
  background: rgba(25, 118, 210, 0.08);
  color: var(--primary, #1976d2);
  border-radius: 10px;
  white-space: nowrap;
}

/* Действия */
.kb-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.kb-card__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  font-family: inherit;
}
.kb-card__btn--preview {
  background: rgba(25, 118, 210, 0.08);
  color: var(--primary, #1976d2);
}
.kb-card__btn--preview:hover {
  background: rgba(25, 118, 210, 0.16);
}
.kb-card__btn--download {
  background: rgba(76, 175, 80, 0.08);
  color: #2e7d32;
}
.kb-card__btn--download:hover {
  background: rgba(76, 175, 80, 0.16);
}
.kb-card__btn--original {
  background: rgba(156, 39, 176, 0.08);
  color: #7b1fa2;
}
.kb-card__btn--original:hover {
  background: rgba(156, 39, 176, 0.16);
}

/* ── Адаптив ── */
@media (max-width: 480px) {
  .kb-card__actions {
    flex-direction: column;
  }
  .kb-card__btn {
    justify-content: center;
  }
  .kb-card__meta {
    flex-direction: column;
    gap: 4px;
  }
  .kb-card__siblings {
    max-height: 250px;
  }
}
`;
