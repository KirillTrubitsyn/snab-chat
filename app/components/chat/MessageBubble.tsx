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

function linkifyContent(text: string, allSources: Source[]): string {
  if (allSources.length === 0) return text;

  const codePatterns: { code: string; sourceId: number }[] = [];
  for (const src of allSources) {
    const codes = src.filename.match(/[А-ЯA-Zа-яa-z]{1,4}-[А-ЯA-Zа-яa-z/]{1,15}-[А-ЯA-Zа-яa-z0-9/]{1,6}-\d{1,3}/gi);
    if (codes) {
      for (const code of codes) {
        codePatterns.push({ code, sourceId: src.id });
      }
    }
  }

  if (codePatterns.length === 0) return text;

  codePatterns.sort((a, b) => b.code.length - a.code.length);

  const combinedPattern = codePatterns
    .map(({ code }) => code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(combinedPattern, "gi");

  return text.replace(regex, (match, offset) => {
    const before = text.substring(Math.max(0, offset - 200), offset);
    const lastOpen = before.lastIndexOf("[");
    const lastClose = before.lastIndexOf("]");
    if (lastOpen > lastClose) return match;

    const justBefore = text.substring(Math.max(0, offset - 10), offset);
    if (justBefore.includes("](")) return match;

    const matchLower = match.toLowerCase();
    const pattern = codePatterns.find((p) => p.code.toLowerCase() === matchLower);
    if (!pattern) return match;

    return `[${match}](source:${pattern.sourceId})`;
  });
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
