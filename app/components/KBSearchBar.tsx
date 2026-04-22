"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
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
  parent_group_key: string | null;
  sibling_chunks: SiblingChunk[];
  original_filename: string | null;
  original_file_url: string | null;
}

interface KBSearchBarProps {
  inviteCode?: string;
  folder?: string | null;
  onOpenDocument?: (sourceId: string, filename: string) => void;
  onDownload?: (sourceId: string, filename: string) => void;
  onDownloadOriginal?: (originalFileUrl: string, originalFilename: string) => void;
  className?: string;
  mode?: "admin" | "chat";
}

/* ── Названия категорий (folder_path → human label) ── */

const CATEGORY_LABELS: Record<string, string> = {
  npa: "НПА",
  standards: "Стандарты и Положения",
  forms: "Формы и Шаблоны",
  schemas: "Схемы процессов",
  instructions: "Инструкции и Методики",
  pricing: "Ценообразование",
  references: "Справочники и Реестры",
  "contractor-cards": "Карточки контрагентов",
  contracts: "Договоры",
};

function categoryLabel(folder: string | null): string | null {
  if (!folder) return null;
  return CATEGORY_LABELS[folder] ?? folder;
}

/* ── Определение расширения по filename / mime_type ── */

type FileExt = "pdf" | "docx" | "xlsx" | "pptx" | "html" | "md" | "file";

function detectExt(filename: string, mime: string | null): FileExt {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || mime?.includes("x-denormalized")) return "md";
  if (lower.endsWith(".pdf") || mime?.includes("pdf")) return "pdf";
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mime?.includes("sheet") ||
    mime?.includes("excel")
  )
    return "xlsx";
  if (
    lower.endsWith(".pptx") ||
    lower.endsWith(".ppt") ||
    mime?.includes("presentationml")
  )
    return "pptx";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || mime?.includes("html"))
    return "html";
  if (lower.endsWith(".docx") || lower.endsWith(".doc") || mime?.includes("word"))
    return "docx";
  return "file";
}

/* ── Утилиты ── */

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

function pluralizeDocs(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "документ";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "документа";
  return "документов";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

/**
 * Вырезает кусок вокруг первого вхождения любого из words, чтобы
 * совпадение оказалось видимым в усечённом превью. Если совпадений нет —
 * возвращает обычный truncate с начала.
 */
function truncateAroundMatch(text: string, words: string[], maxLen: number): string {
  if (text.length <= maxLen) return text;
  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i !== -1 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
  }
  if (firstIdx === -1) return truncate(text, maxLen);

  const half = Math.floor(maxLen / 2);
  const start = Math.max(0, firstIdx - half);
  const end = Math.min(text.length, start + maxLen);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

function matchTypeMeta(type: "fts" | "semantic" | "both"): {
  label: string;
  cls: string;
} {
  switch (type) {
    case "both":
      return { label: "Точное совпадение", cls: "kbs-badge--both" };
    case "semantic":
      return { label: "По смыслу", cls: "kbs-badge--semantic" };
    case "fts":
      return { label: "По тексту", cls: "kbs-badge--fts" };
  }
}

/* ── Иконки (inline SVG, lucide-style) ── */

const Icon = {
  search: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  ),
  close: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
  folder: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  ),
  paperclip: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.83l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  ),
  view: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  download: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  ),
  expand: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  context: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M7 14h10" />
      <path d="M7 10h6" />
      <path d="M7 18h13" />
    </svg>
  ),
  empty: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6" />
    </svg>
  ),
  alert: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  ),
};

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
        setError(null);
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
        setError("Не удалось выполнить поиск. Попробуйте ещё раз.");
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
    abortRef.current?.abort();
    inputRef.current?.focus();
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  /* Список слов запроса — для умного усечения превью */
  const queryWords = useMemo(
    () =>
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= 2),
    [query]
  );

  /* ── Рендер ── */

  const isCompact = mode === "chat";

  return (
    <div className={`kbs ${isCompact ? "kbs--compact" : ""} ${className}`}>
      {/* Поле поиска */}
      <div className={`kbs__field ${loading ? "is-loading" : ""}`}>
        <span className="kbs__field-icon" aria-hidden="true">
          {Icon.search}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="kbs__input"
          placeholder="Поиск по базе знаний…"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoComplete="off"
          spellCheck={false}
          aria-label="Поиск по базе знаний"
        />
        {loading && <span className="kbs__spinner" aria-hidden="true" />}
        {query && !loading && (
          <button
            type="button"
            className="kbs__clear"
            onClick={clearSearch}
            title="Очистить (Esc)"
            aria-label="Очистить поиск"
          >
            {Icon.close}
          </button>
        )}
      </div>

      {/* Результаты */}
      {searched && (
        <div className="kbs__results">
          {error && (
            <div className="kbs__state kbs__state--error" role="alert">
              <span className="kbs__state-icon">{Icon.alert}</span>
              <div className="kbs__state-text">{error}</div>
            </div>
          )}

          {!error && results.length === 0 && (
            <div className="kbs__state kbs__state--empty">
              <span className="kbs__state-icon">{Icon.empty}</span>
              <div className="kbs__state-text">
                <div className="kbs__state-title">Ничего не найдено</div>
                <div className="kbs__state-hint">
                  По запросу «{query}» совпадений нет. Попробуйте другие слова или
                  уточните формулировку.
                </div>
              </div>
            </div>
          )}

          {!error && results.length > 0 && (
            <>
              <div className="kbs__count">
                Найдено <strong>{results.length}</strong> {pluralizeDocs(results.length)}
              </div>

              <div className="kbs__list">
                {results.map((r) => (
                  <SearchResultCard
                    key={r.source_id}
                    result={r}
                    queryWords={queryWords}
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
    </div>
  );
}

/* ── Карточка результата ── */

function SearchResultCard({
  result,
  query,
  queryWords,
  compact,
  onOpen,
  onDownload,
  onDownloadOriginal,
}: {
  result: KBSearchResult;
  query: string;
  queryWords: string[];
  compact: boolean;
  onOpen?: (sourceId: string, filename: string) => void;
  onDownload?: (sourceId: string, filename: string) => void;
  onDownloadOriginal?: (originalFileUrl: string, originalFilename: string) => void;
}) {
  const [showSiblings, setShowSiblings] = useState(false);
  const ext = detectExt(result.filename, result.mime_type);
  const mt = matchTypeMeta(result.match_type);
  const hasSiblings = result.sibling_chunks && result.sibling_chunks.length > 1;
  const hasOriginal = !!(result.original_file_url && result.original_filename);
  const cat = categoryLabel(result.folder_path);

  const previewLen = compact ? 220 : 360;
  const preview = result.best_chunk
    ? truncateAroundMatch(result.best_chunk, queryWords, previewLen)
    : null;

  return (
    <article className="kbs-card">
      <header className="kbs-card__header">
        <div className={`kbs-card__ext kbs-card__ext--${ext}`}>{ext.toUpperCase()}</div>

        <div className="kbs-card__title-wrap">
          <h4
            className="kbs-card__title"
            dangerouslySetInnerHTML={{ __html: highlightMatches(result.filename, query) }}
          />
          <div className="kbs-card__meta-row">
            {cat && (
              <span className="kbs-card__meta-item">
                <span className="kbs-card__meta-icon">{Icon.folder}</span>
                {cat}
              </span>
            )}
            <span className="kbs-card__meta-item">{formatDate(result.created_at)}</span>
            {result.chunk_count > 0 && (
              <span className="kbs-card__meta-item">
                {result.chunk_count}{" "}
                {result.chunk_count === 1 ? "совпадение" : "совпадений"}
              </span>
            )}
            {result.similarity > 0 && (
              <span className="kbs-card__meta-item">
                {Math.round(result.similarity * 100)}%
              </span>
            )}
          </div>
          {hasOriginal && result.original_filename !== result.filename && (
            <div className="kbs-card__original">
              <span className="kbs-card__meta-icon">{Icon.paperclip}</span>
              Оригинал: {result.original_filename}
            </div>
          )}
        </div>

        <span className={`kbs-badge ${mt.cls}`} title={mt.label}>
          {mt.label}
        </span>
      </header>

      {preview && (
        <div
          className="kbs-card__snippet"
          dangerouslySetInnerHTML={{ __html: highlightMatches(preview, query) }}
        />
      )}

      {hasSiblings && (
        <button
          type="button"
          className={`kbs-card__siblings-toggle ${showSiblings ? "is-open" : ""}`}
          onClick={() => setShowSiblings(!showSiblings)}
        >
          <span className="kbs-card__meta-icon">{Icon.context}</span>
          {showSiblings
            ? "Скрыть контекст"
            : `Контекст: ${result.sibling_chunks.length} фрагментов`}
          <span className="kbs-card__chevron">{Icon.expand}</span>
        </button>
      )}

      {showSiblings && hasSiblings && (
        <div className="kbs-card__siblings">
          {result.sibling_chunks.map((s) => {
            const isActive = s.content === result.best_chunk;
            return (
              <div
                key={s.chunk_index}
                className={`kbs-sibling ${isActive ? "is-active" : ""}`}
              >
                <span className="kbs-sibling__index">{s.chunk_index + 1}</span>
                <div
                  className="kbs-sibling__text"
                  dangerouslySetInnerHTML={{ __html: highlightMatches(s.content, query) }}
                />
              </div>
            );
          })}
        </div>
      )}

      {!compact && result.tags.length > 0 && (
        <div className="kbs-card__tags">
          {result.tags
            .filter((t) => t !== "денормализовано")
            .slice(0, 6)
            .map((tag) => (
              <span key={tag} className="kbs-card__tag">
                {tag}
              </span>
            ))}
        </div>
      )}

      {(onOpen || onDownload || (hasOriginal && onDownloadOriginal)) && (
        <div className="kbs-card__actions">
          {onOpen && (
            <button
              type="button"
              className="kbs-btn kbs-btn--primary"
              onClick={() => onOpen(result.source_id, result.filename)}
            >
              <span className="kbs-btn__icon">{Icon.view}</span>
              Открыть
            </button>
          )}
          {onDownload && (
            <button
              type="button"
              className="kbs-btn"
              onClick={() => onDownload(result.source_id, result.filename)}
            >
              <span className="kbs-btn__icon">{Icon.download}</span>
              Скачать
            </button>
          )}
          {hasOriginal && onDownloadOriginal && (
            <button
              type="button"
              className="kbs-btn"
              onClick={() =>
                onDownloadOriginal(
                  result.original_file_url!,
                  result.original_filename!
                )
              }
            >
              <span className="kbs-btn__icon">{Icon.paperclip}</span>
              Оригинал
            </button>
          )}
        </div>
      )}
    </article>
  );
}
