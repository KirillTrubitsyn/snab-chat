h"use client";

import { useState, useRef, useCallback, useEffect } from "react";

/* ââ Ð¢Ð¸Ð¿Ñ ââ */

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
}

interface KBSearchBarProps {
  /** ÐÐ°Ð³Ð¾Ð»Ð¾Ð²Ð¾Ðº Ð¸Ð½Ð²Ð°Ð¹Ñ-ÐºÐ¾Ð´Ð° (Ð´Ð»Ñ Ð°ÑÑÐµÐ½ÑÐ¸ÑÐ¸ÐºÐ°ÑÐ¸Ð¸ Ð·Ð°Ð¿ÑÐ¾ÑÐ¾Ð²) */
  inviteCode?: string;
  /** ÐÐ³ÑÐ°Ð½Ð¸ÑÐµÐ½Ð¸Ðµ Ð¿Ð¾ Ð¿Ð°Ð¿ÐºÐµ (null = Ð²ÑÐµ) */
  folder?: string | null;
  /** ÐÑÐ·ÑÐ²Ð°ÐµÑÑÑ Ð¿ÑÐ¸ ÐºÐ»Ð¸ÐºÐµ Ð½Ð° Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ â Ð¾ÑÐºÑÑÑÐ¸Ðµ Ð¿ÑÐµÐ²ÑÑ */
  onOpenDocument?: (sourceId: string, filename: string) => void;
  /** ÐÑÐ·ÑÐ²Ð°ÐµÑÑÑ Ð¿ÑÐ¸ ÐºÐ»Ð¸ÐºÐµ Â«Ð¡ÐºÐ°ÑÐ°ÑÑÂ» */
  onDownload?: (sourceId: string, filename: string) => void;
  /** ÐÐ¾Ð¿Ð¾Ð»Ð½Ð¸ÑÐµÐ»ÑÐ½ÑÐ¹ CSS-ÐºÐ»Ð°ÑÑ Ð´Ð»Ñ ÐºÐ¾Ð½ÑÐµÐ¹Ð½ÐµÑÐ° */
  className?: string;
  /** Ð ÐµÐ¶Ð¸Ð¼: admin (ÑÐ°ÑÑÐ¸ÑÐµÐ½Ð½Ð°Ñ Ð¸Ð½ÑÐ¾ÑÐ¼Ð°ÑÐ¸Ñ) Ð¸Ð»Ð¸ chat (ÐºÐ¾Ð¼Ð¿Ð°ÐºÑÐ½ÑÐ¹) */
  mode?: "admin" | "chat";
}

/* ââ ÐÐºÐ¾Ð½ÐºÐ¸ (Material Symbols outline, 20px) ââ */

const ICON = {
  search: "search",
  close: "close",
  folder: "folder",
  description: "description",
  visibility: "visibility",
  download: "download",
  tag: "label",
  bolt: "bolt",
  text: "text_fields",
  join: "join",
} as const;

/* ââ ÐÑÐ¿Ð¾Ð¼Ð¾Ð³Ð°ÑÐµÐ»ÑÐ½ÑÐµ ÑÑÐ½ÐºÑÐ¸Ð¸ ââ */

/** ÐÐ¾Ð´ÑÐ²ÐµÑÐºÐ° ÑÐ¾Ð²Ð¿Ð°Ð²ÑÐ¸Ñ ÑÐ»Ð¾Ð² Ð² ÑÐµÐºÑÑÐµ */
function highlightMatches(text: string, query: string): string {
  if (!query.trim()) return text;
  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  const regex = new RegExp(`(${words.join("|")})`, "gi");
  return text.replace(regex, "<mark>$1</mark>");
}

/** Ð¤Ð¾ÑÐ¼Ð°ÑÐ¸ÑÐ¾Ð²Ð°Ð½Ð¸Ðµ Ð´Ð°ÑÑ */
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

/** ÐÐºÐ¾Ð½ÐºÐ° ÑÐ¸Ð¿Ð° ÑÐ¾Ð²Ð¿Ð°Ð´ÐµÐ½Ð¸Ñ */
function matchTypeLabel(type: "fts" | "semantic" | "both"): {
  icon: string;
  label: string;
  color: string;
} {
  switch (type) {
    case "both":
      return { icon: ICON.join, label: "ÐÐ¾Ð»Ð½Ð¾Ðµ ÑÐ¾Ð²Ð¿Ð°Ð´ÐµÐ½Ð¸Ðµ", color: "#4caf50" };
    case "semantic":
      return { icon: ICON.bolt, label: "ÐÐ¾ ÑÐ¼ÑÑÐ»Ñ", color: "#2196f3" };
    case "fts":
      return { icon: ICON.text, label: "ÐÐ¾ ÑÐµÐºÑÑÑ", color: "#ff9800" };
  }
}

/** ÐÐ±ÑÐµÐ·ÐºÐ° ÑÐµÐºÑÑÐ° */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "â¦";
}

/* ââ ÐÐ¾Ð¼Ð¿Ð¾Ð½ÐµÐ½Ñ ââ */

export default function KBSearchBar({
  inviteCode,
  folder = null,
  onOpenDocument,
  onDownload,
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

  /* ââ ÐÐ¾Ð¸ÑÐº ââ */

  const doSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setResults([]);
        setSearched(false);
        return;
      }

      // ÐÑÐ¼ÐµÐ½ÑÐµÐ¼ Ð¿ÑÐµÐ´ÑÐ´ÑÑÐ¸Ð¹ Ð·Ð°Ð¿ÑÐ¾Ñ
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/kb-search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            
          },
          body: JSON.stringify({ query: q.trim(), limit: 20, folder }),
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`ÐÑÐ¸Ð±ÐºÐ° ${res.status}`);
        }

        const data = await res.json();
        setResults(data.results ?? []);
        setSearched(true);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError("ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð²ÑÐ¿Ð¾Ð»Ð½Ð¸ÑÑ Ð¿Ð¾Ð¸ÑÐº");
        console.error("KB search error:", err);
      } finally {
        setLoading(false);
      }
    },
    [inviteCode, folder]
  );

  /* Debounce Ð²Ð²Ð¾Ð´Ð°: 400ms */
  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => doSearch(value), 400);
  };

  /* Enter â Ð½ÐµÐ¼ÐµÐ´Ð»ÐµÐ½Ð½ÑÐ¹ Ð¿Ð¾Ð¸ÑÐº */
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

  /* Cleanup */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  /* ââ Ð ÐµÐ½Ð´ÐµÑ ââ */

  const isCompact = mode === "chat";

  return (
    <div className={`kb-search ${className}`}>
      {/* ââ Ð¡ÑÑÐ¾ÐºÐ° Ð¿Ð¾Ð¸ÑÐºÐ° ââ */}
      <div className="kb-search__input-wrap">
        <span className="material-symbols-outlined kb-search__icon">
          {ICON.search}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="kb-search__input"
          placeholder="ÐÐ¾Ð¸ÑÐº Ð¿Ð¾ Ð±Ð°Ð·Ðµ Ð·Ð½Ð°Ð½Ð¸Ð¹â¦"
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
            title="ÐÑÐ¸ÑÑÐ¸ÑÑ"
            type="button"
          >
            <span className="material-symbols-outlined">{ICON.close}</span>
          </button>
        )}
        {loading && <div className="kb-search__spinner" />}
      </div>

      {/* ââ Ð ÐµÐ·ÑÐ»ÑÑÐ°ÑÑ ââ */}
      {searched && (
        <div className="kb-search__results">
          {error && <div className="kb-search__error">{error}</div>}

          {!error && results.length === 0 && (
            <div className="kb-search__empty">
              ÐÐ¸ÑÐµÐ³Ð¾ Ð½Ðµ Ð½Ð°Ð¹Ð´ÐµÐ½Ð¾ Ð¿Ð¾ Ð·Ð°Ð¿ÑÐ¾ÑÑ Â«{query}Â»
            </div>
          )}

          {results.length > 0 && (
            <>
              <div className="kb-search__count">
                ÐÐ°Ð¹Ð´ÐµÐ½Ð¾: {results.length} Ð´Ð¾ÐºÑÐ¼ÐµÐ½Ñ
                {results.length % 10 === 1 && results.length % 100 !== 11
                  ? ""
                  : results.length % 10 >= 2 &&
                      results.length % 10 <= 4 &&
                      (results.length % 100 < 10 || results.length % 100 >= 20)
                    ? "Ð°"
                    : "Ð¾Ð²"}
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
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ââ Ð¡ÑÐ¸Ð»Ð¸ (inline, ÑÑÐ¾Ð±Ñ ÐºÐ¾Ð¼Ð¿Ð¾Ð½ÐµÐ½Ñ Ð±ÑÐ» self-contained) ââ */}
      <style>{styles}</style>
    </div>
  );
}

/* ââ ÐÐ°ÑÑÐ¾ÑÐºÐ° ÑÐµÐ·ÑÐ»ÑÑÐ°ÑÐ° ââ */

function SearchResultCard({
  result,
  query,
  compact,
  onOpen,
  onDownload,
}: {
  result: KBSearchResult;
  query: string;
  compact: boolean;
  onOpen?: (sourceId: string, filename: string) => void;
  onDownload?: (sourceId: string, filename: string) => void;
}) {
  const mt = matchTypeLabel(result.match_type);

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
        </div>
        {/* ÐÐµÐ¹Ð´Ð¶ ÑÐ¸Ð¿Ð° ÑÐ¾Ð²Ð¿Ð°Ð´ÐµÐ½Ð¸Ñ */}
        <span className="kb-card__badge" style={{ background: mt.color }}>
          <span
            className="material-symbols-outlined"
            style={{ fontSize: 14 }}
          >
            {mt.icon}
          </span>
          {!compact && mt.label}
        </span>
      </div>

      {/* ÐÑÐµÐ²ÑÑ ÑÑÐ°Ð³Ð¼ÐµÐ½ÑÐ° */}
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

      {/* Мета-информация */}
      {!compact && (
        <div className="kb-card__meta">
          {result.chunk_count > 0 && (
            <span className="kb-card__meta-item">
              Ð¡Ð¾Ð²Ð¿Ð°Ð´ÐµÐ½Ð¸Ð¹: {result.chunk_count}
            </span>
          )}
          <span className="kb-card__meta-item">
            {formatDate(result.created_at)}
          </span>
          {result.similarity > 0 && (
            <span className="kb-card__meta-item">
              Ð ÐµÐ»ÐµÐ²Ð°Ð½ÑÐ½Ð¾ÑÑÑ: {Math.round(result.similarity * 100)}%
            </span>
          )}
        </div>
      )}

      {/* Теги (только admin) */}
      {!compact && result.tags.length > 0 && (
        <div className="kb-card__tags">
          {result.tags
            .filter((t) => t !== "Ð´ÐµÐ½Ð¾ÑÐ¼Ð°Ð»Ð¸Ð·Ð¾Ð²Ð°Ð½Ð¾")
            .slice(0, 5)
            .map((tag) => (
              <span key={tag} className="kb-card__tag">
                {tag}
              </span>
            ))}
        </div>
      )}

      {/* ÐÐµÐ¹ÑÑÐ²Ð¸Ñ */}
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
            ÐÑÐ¾ÑÐ¼Ð¾ÑÑ
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
            Ð¡ÐºÐ°ÑÐ°ÑÑ
          </button>
        )}
      </div>
    </div>
  );
}

/* ââ CSS ââ */

const styles = `
/* ââ ÐÐ¾Ð½ÑÐµÐ¹Ð½ÐµÑ ââ */
.kb-search {
  width: 100%;
  position: relative;
}

/* ââ Ð¡ÑÑÐ¾ÐºÐ° Ð¿Ð¾Ð¸ÑÐºÐ° ââ */
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

/* ââ Ð¡Ð¿Ð¸Ð½Ð½ÐµÑ ââ */
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

/* ââ Ð ÐµÐ·ÑÐ»ÑÑÐ°ÑÑ ââ */
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

/* ââ ÐÐ°ÑÑÐ¾ÑÐºÐ° Ð´Ð¾ÐºÑÐ¼ÐµÐ½ÑÐ° ââ */
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

/* ÐÐ°Ð³Ð¾Ð»Ð¾Ð²Ð¾Ðº */
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

/* Ð¤ÑÐ°Ð³Ð¼ÐµÐ½Ñ */
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

/* ÐÐµÑÐ° */
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

/* Ð¢ÐµÐ³Ð¸ */
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

/* ÐÐµÐ¹ÑÑÐ²Ð¸Ñ */
.kb-card__actions {
  display: flex;
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

/* ââ ÐÐ´Ð°Ð¿ÑÐ¸Ð² ââ */
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
}
`;
