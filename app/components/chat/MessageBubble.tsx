"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "./types";
import { InfographicIcon } from "./icons";

function TableWrapper({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const checkOverflow = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      setOverflows(el.scrollWidth > el.clientWidth + 2);
    }
  }, []);

  useEffect(() => {
    checkOverflow();
    window.addEventListener("resize", checkOverflow);
    return () => window.removeEventListener("resize", checkOverflow);
  }, [checkOverflow]);

  return (
    <>
      <div className={`table-container${overflows ? " table-overflows" : ""}`} ref={containerRef}>
        <table {...props}>{children}</table>
        {overflows && !fullscreen && (
          <button
            className="table-fullscreen-btn"
            onClick={() => setFullscreen(true)}
            title="Развернуть таблицу на весь экран"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
            Развернуть
          </button>
        )}
      </div>
      {fullscreen && (
        <div className="table-fullscreen-overlay" onClick={() => setFullscreen(false)}>
          <div className="table-fullscreen-content" onClick={(e) => e.stopPropagation()}>
            <button className="table-fullscreen-close" onClick={() => setFullscreen(false)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
              Свернуть
            </button>
            <div className="table-fullscreen-scroll">
              <table {...props}>{children}</table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface ChunkImage {
  url: string;
  source: string;
  chunk: number;
}

interface MessageBubbleProps {
  message: {
    id: string;
    role: string;
    content: string;
    sources?: string[];
    attachments?: string[];
    chunkImages?: ChunkImage[];
    metadata?: { type?: string; image_base64?: string; topic?: string; style?: string } | null;
  };
  allSources: Source[];
  onViewSource: (source: Source) => void;
  onCreateInfographic?: (content: string) => void;
  onExportDocx?: (content: string) => void;
  onExportExcel?: (content: string) => void;
  onFollowUpClick?: (text: string) => void;
}

function findSource(name: string, allSources: Source[]): Source | undefined {
  if (!name) return undefined;
  const n = name.trim();
  let src = allSources.find((doc) => doc.filename === n);
  if (src) return src;
  const lower = n.toLowerCase();
  src = allSources.find((doc) => doc.filename.toLowerCase() === lower);
  if (src) return src;
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normName = normalize(n);
  src = allSources.find((doc) => normalize(doc.filename) === normName);
  if (src) return src;
  src = allSources.find((doc) => normalize(doc.filename).includes(normName) || normName.includes(normalize(doc.filename)));
  if (src) return src;
  const nameNoExt = normName.replace(/\.\w+$/, "");
  src = allSources.find((doc) => normalize(doc.filename).replace(/\.\w+$/, "") === nameNoExt);
  if (src) return src;
  const codeMatch = n.match(/[А-ЯA-Z][\w-]*(?:В\d|У\d|Б\d)[\w-]*/i);
  if (codeMatch) {
    const code = codeMatch[0].toLowerCase();
    src = allSources.find((doc) => doc.filename.toLowerCase().includes(code));
  }
  return src;
}

// Company abbreviation → filename search terms mapping
const COMPANY_ABBR: Record<string, string[]> = {
  "кэ": ["кузбассэнерго"],
  "нтск": ["нтск"],
  "етгк": ["етгк"],
  "сгк-а": ["сгк-алтай", "сгк_алтай"],
  "сгк-н": ["сгк-новосибирск", "сгк_новосибирск"],
  "гк": ["сгк", "с-гк"],
};
// Document type prefix → filename keyword
const DOC_TYPE_PREFIX: Record<string, string> = {
  "с": "стандарт",
  "пл": "положение",
};

/** Normalize all dash-like characters (en-dash, em-dash, Unicode hyphen, minus) to ASCII hyphen */
function normalizeDashes(text: string): string {
  return text.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-");
}

/**
 * Normalize Latin homoglyphs to Cyrillic equivalents.
 * LLMs (Gemini) often output Latin C/K/B/A/E/H/M/O/P/T/X instead of
 * their visually identical Cyrillic counterparts in document codes like
 * С-КЭ-В5-01. This breaks regex patterns that expect [А-Яа-я].
 */
const LATIN_TO_CYRILLIC: Record<string, string> = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М",
  O: "О", P: "Р", T: "Т", X: "Х",
  a: "а", c: "с", e: "е", o: "о", p: "р", x: "х",
};
function normalizeCyrillicHomoglyphs(text: string): string {
  return text.replace(/[ABCEHKMOPTXaceopx]/g, (ch) => LATIN_TO_CYRILLIC[ch] ?? ch);
}

/** Check if offset is already inside a markdown link — avoid double-linkifying */
function isInsideLink(text: string, offset: number): boolean {
  const before = text.substring(Math.max(0, offset - 300), offset);
  const lastOpen = before.lastIndexOf("[");
  const lastClose = before.lastIndexOf("]");
  if (lastOpen > lastClose) return true; // inside [...]
  const justBefore = text.substring(Math.max(0, offset - 10), offset);
  if (justBefore.includes("](")) return true; // inside (url) part
  return false;
}

/**
 * Generate human-readable name variants from a source filename for text matching.
 * Produces multiple variants to catch how the LLM might reference a document.
 */
function generateNameVariants(filename: string): string[] {
  const variants = new Set<string>();
  // Strip extension
  const base = filename.replace(/\.\w+$/, "");
  // Replace underscores with spaces
  const readable = base.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (readable.length >= 12) variants.add(readable);

  // Without "compressed", "ред N", trailing numbers
  const cleaned = readable
    .replace(/\s*compressed$/i, "")
    .replace(/\s*ред\s*[\d.]+$/i, "")
    .trim();
  if (cleaned.length >= 12) variants.add(cleaned);

  // Strip leading prefixes like "Приложение 1 к ", "Приказ КЭ-229 от ... "
  const withoutPrefix = cleaned
    .replace(/^Приложение\s+\d+\s+к\s+/i, "")
    .replace(/^Приказ\s+[\wА-Яа-я-]+\s+от\s+[\d.]+\s+/i, "")
    .replace(/^Прил\s+\d+[\w.]*\s+к\s+Стандарту\s+[\wА-Яа-я-]+\s+/i, "")
    .trim();
  if (withoutPrefix !== cleaned && withoutPrefix.length >= 12) variants.add(withoutPrefix);

  return [...variants];
}

/**
 * Dynamically resolve a cipher code (e.g. С-КЭ-В5-01) to a source.
 * First checks if the code appears directly in any source filename.
 * If not, decomposes the code into doc-type + company and searches by keywords.
 */
function resolveCodeToSource(code: string, allSources: Source[]): Source | undefined {
  const codeLower = code.toLowerCase();
  // Direct match: code appears in a source filename
  let src = allSources.find((s) => s.filename.toLowerCase().includes(codeLower));
  if (src) return src;

  // Decompose: "С-КЭ-В5-01" → prefix="с", company="кэ"
  const parts = codeLower.split("-");
  if (parts.length < 3) return undefined;
  const prefix = parts[0]; // "с" or "пл"
  // Company = everything between prefix and the version part (В5, Б5, etc.)
  const versionIdx = parts.findIndex((p) => /^[вб]\d/.test(p));
  if (versionIdx <= 1) return undefined;
  const companyParts = parts.slice(1, versionIdx);
  const companyKey = companyParts.join("-"); // "кэ", "нтск", "сгк-а", etc.

  const docTypeKeyword = DOC_TYPE_PREFIX[prefix];
  const companyTerms = COMPANY_ABBR[companyKey];
  if (!docTypeKeyword || !companyTerms) return undefined;

  // Search allSources for filename containing BOTH doc type and company
  src = allSources.find((s) => {
    const fn = s.filename.toLowerCase();
    if (!fn.includes(docTypeKeyword)) return false;
    return companyTerms.some((term) => fn.includes(term));
  });
  // Prefer .docx over .pdf
  if (src) {
    const betterSrc = allSources.find((s) => {
      const fn = s.filename.toLowerCase();
      return fn.endsWith(".docx") && fn.includes(docTypeKeyword) && companyTerms.some((term) => fn.includes(term));
    });
    if (betterSrc) return betterSrc;
  }
  return src;
}

function linkifyContent(text: string, allSources: Source[]): string {
  if (allSources.length === 0) return text;

  // Normalize dashes so all cipher codes use ASCII hyphen
  let result = normalizeDashes(text);

  // ── Phase 1: Find ALL cipher codes in the text with a generic regex ──
  // Matches patterns like: С-ЕТГК-В5-01, Пл-КЭ-В5-01, С-ГК-В5-03, С-СГК-А-В5-01
  // Accept BOTH Cyrillic and Latin homoglyphs (С/C, К/K, В/B, etc.) because
  // Gemini often outputs Latin lookalikes that are visually identical
  const CYR_OR_LAT = "[А-Яа-яABCEHKMOPTXaceopx]";
  const cipherRegex = new RegExp(
    `${CYR_OR_LAT}{1,3}-${CYR_OR_LAT}[\\wА-Яа-яABCEHKMOPTXaceopx-]{0,14}-[ВвБбBb]\\d+-\\d{1,3}`,
    "g"
  );
  const codeMap = new Map<string, number>(); // normalized code → sourceId

  let m;
  while ((m = cipherRegex.exec(result)) !== null) {
    const code = m[0];
    // Normalize Latin homoglyphs to Cyrillic before resolving
    const codeNorm = normalizeCyrillicHomoglyphs(code);
    const codeLower = codeNorm.toLowerCase();
    if (codeMap.has(codeLower)) continue;
    const src = resolveCodeToSource(codeNorm, allSources);
    if (src) codeMap.set(codeLower, src.id);
  }

  // Replace codes with links (longest first)
  // Build a regex that matches both the Cyrillic-normalized form AND the
  // original text (which may contain Latin homoglyphs)
  const sortedCodes = [...codeMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [codeLower, sourceId] of sortedCodes) {
    // Build a char-by-char regex that matches either Cyrillic or Latin variant
    const CYRILLIC_TO_LATIN: Record<string, string> = {
      "а": "a", "в": "b", "с": "c", "е": "e", "н": "h", "к": "k", "м": "m",
      "о": "o", "р": "p", "т": "t", "х": "x",
    };
    let pattern = "";
    for (const ch of codeLower) {
      const escaped = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const latinAlt = CYRILLIC_TO_LATIN[ch];
      if (latinAlt) {
        // Match either Cyrillic or its Latin lookalike (case-insensitive via flag)
        pattern += `[${escaped}${latinAlt}${latinAlt.toUpperCase()}${ch.toUpperCase()}]`;
      } else {
        pattern += escaped;
      }
    }
    const regex = new RegExp(pattern, "gi");
    result = result.replace(regex, (match, offset) => {
      if (isInsideLink(result, offset)) return match;
      return `[${match}](source:${sourceId})`;
    });
  }

  // ── Phase 2: Human-readable document name matching ──
  const namePatterns: { name: string; sourceId: number }[] = [];
  for (const src of allSources) {
    for (const variant of generateNameVariants(src.filename)) {
      namePatterns.push({ name: variant, sourceId: src.id });
    }
  }
  namePatterns.sort((a, b) => b.name.length - a.name.length);

  for (const { name, sourceId } of namePatterns) {
    if (name.length < 12) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameRegex = new RegExp(escaped, "gi");
    result = result.replace(nameRegex, (match, offset) => {
      if (isInsideLink(result, offset)) return match;
      if (offset > 0 && result[offset - 1] === "[") return match;
      return `[${match}](source:${sourceId})`;
    });
  }

  return result;
}

function SourcesAccordion({
  sources,
  allSources,
  onSourceClick,
}: {
  sources: string[];
  allSources: Source[];
  onSourceClick: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="message-sources-accordion">
      <button
        className="message-sources-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "rotate(0deg)", flexShrink: 0 }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span>Источники</span>
        <span className="message-sources-count">{sources.length}</span>
      </button>
      {open && (
        <div className="message-sources-list">
          {sources.map((s, i) => {
            const src = findSource(s, allSources);
            return (
              <button
                key={i}
                className={`message-source-tag source-clickable${!src ? " source-unlinked" : ""}`}
                onClick={() => onSourceClick(s)}
                title={src ? "Открыть документ" : "Документ не найден в базе"}
              >
                {s}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({
  message,
  allSources,
  onViewSource,
  onCreateInfographic,
  onExportDocx,
  onExportExcel,
  onFollowUpClick,
}: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="message message-user">
        {message.attachments && message.attachments.length > 0 && (
          <div className="message-attachments">
            {message.attachments.map((name, i) => (
              <span key={i} className="message-attachment-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="message-content">{message.content}</div>
      </div>
    );
  }

  if (message.metadata?.type === "infographic" && message.metadata.image_base64) {
    const handleDownloadInfographic = () => {
      const link = document.createElement("a");
      link.href = message.metadata!.image_base64!;
      link.download = `infographic-${Date.now()}.png`;
      link.click();
    };

    return (
      <div className="message message-ai">
        <div className="message-infographic-card">
          <div className="message-infographic-label">
            <InfographicIcon size={14} />
            Инфографика{message.metadata.topic ? `: ${message.metadata.topic}` : ""}
          </div>
          <img
            src={message.metadata.image_base64}
            alt={message.metadata.topic || "Инфографика"}
            className="message-infographic-image"
          />
          {message.content && (
            <div className="message-infographic-desc">{message.content}</div>
          )}
          <button className="message-infographic-download" onClick={handleDownloadInfographic}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Скачать PNG
          </button>
        </div>
      </div>
    );
  }

  const handleSourceClick = (sourceName: string) => {
    const src = findSource(sourceName, allSources);
    if (src) onViewSource(src);
  };

  // Split follow-up questions from main content
  const followUpMarker = "💡 **Вам также может быть полезно:**";
  const followUpIdx = message.content.indexOf(followUpMarker);
  const hasFollowUp = followUpIdx !== -1 && onFollowUpClick;

  let mainContent = message.content;
  let followUpQuestions: string[] = [];

  if (hasFollowUp) {
    mainContent = message.content.slice(0, followUpIdx).trimEnd();
    const followUpBlock = message.content.slice(followUpIdx + followUpMarker.length);
    followUpQuestions = followUpBlock
      .split("\n")
      .map((line) => line.replace(/^[\s]*[-•*]\s*/, "").trim())
      .filter((line) => line.length > 0 && line.endsWith("?"));
  }

  // Ensure blank lines before markdown headings (## / ###) so ReactMarkdown parses them correctly
  const linkedContent = linkifyContent(mainContent, allSources);
  const processedContent = linkedContent.replace(/([^\n])\n(#{1,4}\s)/g, "$1\n\n$2");
  const [expandedImg, setExpandedImg] = useState<string | null>(null);

  return (
    <div className="message message-ai">
      <div className="message-content">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: ({ children, ...props }) => (
              <TableWrapper {...props}>{children}</TableWrapper>
            ),
            a: ({ children, href }) => {
              if (href?.startsWith("source:")) {
                const id = parseInt(href.replace("source:", ""), 10);
                const src = allSources.find((s) => s.id === id);
                if (src) {
                  return (
                    <button
                      className="source-link-btn"
                      onClick={() => onViewSource(src)}
                      title={`Открыть: ${src.filename}`}
                    >
                      {children}
                    </button>
                  );
                }
              }
              const linkText = String(children);
              const src = findSource(linkText, allSources);
              if (src) {
                return (
                  <button
                    className="source-link-btn"
                    onClick={() => onViewSource(src)}
                    title={`Открыть: ${src.filename}`}
                  >
                    {children}
                  </button>
                );
              }
              return <span>{children}</span>;
            },
          }}
        >
          {processedContent}
        </ReactMarkdown>
        {hasFollowUp && followUpQuestions.length > 0 && (
          <div className="followup-section">
            <div className="followup-label">💡 Вам также может быть полезно:</div>
            <div className="followup-chips">
              {followUpQuestions.map((q, i) => (
                <button key={i} className="followup-chip" onClick={() => onFollowUpClick!(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {message.chunkImages && message.chunkImages.length > 0 && (
        <div className="message-screenshots">
          <div className="message-screenshots-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            Скриншоты из инструкций
          </div>
          <div className="message-screenshots-grid">
            {message.chunkImages.map((img, i) => (
              <div key={i} className="message-screenshot-item" onClick={() => setExpandedImg(img.url)}>
                <img src={img.url} alt={`Скриншот ${i + 1}`} loading="lazy" />
                <div className="message-screenshot-caption">Скриншот {i + 1}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {expandedImg && (
        <div className="message-screenshot-overlay" onClick={() => setExpandedImg(null)}>
          <div className="message-screenshot-overlay-content" onClick={(e) => e.stopPropagation()}>
            <button className="message-screenshot-close" onClick={() => setExpandedImg(null)}>&times;</button>
            <img src={expandedImg} alt="Скриншот" />
          </div>
        </div>
      )}
      {message.sources && message.sources.length > 0 && (
        <SourcesAccordion
          sources={message.sources}
          allSources={allSources}
          onSourceClick={handleSourceClick}
        />
      )}
      {(onCreateInfographic || onExportDocx || onExportExcel) && (
        <div className="message-infographic-row">
          {onCreateInfographic && (
            <button
              className="message-infographic-btn"
              onClick={() => onCreateInfographic(message.content)}
              title="Создать инфографику на основе этого ответа"
            >
              <InfographicIcon size={14} />
              Создать инфографику
            </button>
          )}
          {onExportDocx && (
            <button
              className="message-infographic-btn message-export-btn"
              onClick={() => onExportDocx(message.content)}
              title="Скачать ответ в формате DOCX"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <polyline points="9 15 12 18 15 15" />
              </svg>
              Скачать .docx
            </button>
          )}
          {onExportExcel && (
            <button
              className="message-infographic-btn message-export-btn"
              onClick={() => onExportExcel(message.content)}
              title="Скачать таблицы в формате Excel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="3" y1="15" x2="21" y2="15" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              Скачать .xlsx
            </button>
          )}
        </div>
      )}
    </div>
  );
}
