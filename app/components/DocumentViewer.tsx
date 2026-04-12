"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeHtml } from "@/app/lib/sanitize";
import { apiUrl, getAuthHeaders } from "@/app/lib/api";

export interface DocumentSource {
  id: number;
  filename: string;
  mime_type: string;
  storage_path: string | null;
}

export interface ExcelSheet {
  name: string;
  rows: string[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  colWidths: number[];
}

function ExcelViewer({ sheets }: { sheets: ExcelSheet[] }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = sheets[activeSheet];
  if (!sheet) return null;

  const mergeMap = new Map<string, { rowSpan: number; colSpan: number } | "hidden">();
  for (const m of sheet.merges) {
    const rowSpan = m.e.r - m.s.r + 1;
    const colSpan = m.e.c - m.s.c + 1;
    mergeMap.set(`${m.s.r},${m.s.c}`, { rowSpan, colSpan });
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r !== m.s.r || c !== m.s.c) {
          mergeMap.set(`${r},${c}`, "hidden");
        }
      }
    }
  }

  return (
    <div className="excel-viewer">
      {sheets.length > 1 && (
        <div className="excel-sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={i}
              className={`excel-sheet-tab ${i === activeSheet ? "active" : ""}`}
              onClick={() => setActiveSheet(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="excel-table-wrapper">
        <table className="excel-table">
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  const key = `${ri},${ci}`;
                  const merge = mergeMap.get(key);
                  if (merge === "hidden") return null;
                  const span = merge || undefined;
                  const isEmpty = cell.trim() === "";
                  return (
                    <td
                      key={ci}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      className={isEmpty ? "excel-cell-empty" : undefined}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface PptxSlide {
  number: number;
  paragraphs: string[];
  images: { base64: string; mimeType: string }[];
}

function PptxViewer({ slides }: { slides: PptxSlide[] }) {
  const [activeSlide, setActiveSlide] = useState(0);

  return (
    <div className="pptx-viewer">
      <div className="pptx-slide-nav">
        {slides.map((s, i) => (
          <button
            key={i}
            className={`pptx-slide-thumb ${i === activeSlide ? "active" : ""}`}
            onClick={() => setActiveSlide(i)}
          >
            {s.number}
          </button>
        ))}
      </div>
      <div className="pptx-slide-content">
        {slides[activeSlide] && (
          <>
            <div className="pptx-slide-header">
              Слайд {slides[activeSlide].number}
              <span className="pptx-slide-counter">
                {activeSlide + 1} / {slides.length}
              </span>
            </div>
            <div className="pptx-slide-body">
              {slides[activeSlide].paragraphs.map((p, i) => (
                <p key={i} className={i === 0 ? "pptx-slide-title" : undefined}>{p}</p>
              ))}
              {slides[activeSlide].images.length > 0 && (
                <div className="pptx-slide-images">
                  {slides[activeSlide].images.map((img, i) => (
                    <img
                      key={i}
                      src={`data:${img.mimeType};base64,${img.base64}`}
                      alt={`Слайд ${slides[activeSlide].number}, изображение ${i + 1}`}
                      className="pptx-slide-img"
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="pptx-slide-arrows">
              <button
                disabled={activeSlide === 0}
                onClick={() => setActiveSlide(activeSlide - 1)}
              >
                &larr; Назад
              </button>
              <button
                disabled={activeSlide === slides.length - 1}
                onClick={() => setActiveSlide(activeSlide + 1)}
              >
                Далее &rarr;
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function DocumentViewer({
  source,
  onClose,
  authCode,
}: {
  source: DocumentSource;
  onClose: () => void;
  authCode?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [excelSheets, setExcelSheets] = useState<ExcelSheet[] | null>(null);
  const [pptxSlides, setPptxSlides] = useState<PptxSlide[] | null>(null);
  const [loading, setLoading] = useState(true);
  // Resolved source: original file if this is a denormalized document
  const [resolved, setResolved] = useState<DocumentSource | null>(null);

  // The effective source for display (original if resolved, otherwise the input source)
  const eff = resolved || source;
  const isPdf = eff.mime_type?.includes("pdf");
  const isExcel =
    eff.mime_type?.includes("sheet") ||
    eff.mime_type?.includes("excel") ||
    eff.filename?.endsWith(".xlsx") ||
    eff.filename?.endsWith(".xls");
  const isDocx =
    eff.mime_type?.includes("wordprocessingml") ||
    eff.filename?.endsWith(".docx") ||
    eff.filename?.endsWith(".doc");
  const isPptx =
    eff.mime_type?.includes("presentationml") ||
    eff.filename?.endsWith(".pptx") ||
    eff.filename?.endsWith(".ppt");
  const hasOriginal = !!eff.storage_path;
  const isDenormalized = source.mime_type === "application/x-denormalized";
  const tokenParam = authCode ? `&token=${encodeURIComponent(authCode)}` : "";
  const authHeaders: HeadersInit = authCode
    ? { "x-invite-code": encodeURIComponent(authCode), ...getAuthHeaders() }
    : getAuthHeaders();

  // Step 1: resolve denormalized source to original
  useEffect(() => {
    if (!isDenormalized) {
      setResolved(null);
      return;
    }
    fetch(apiUrl(`/api/sources/resolve?id=${source.id}`), { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => {
        if (d.original) {
          setResolved(d.original);
        }
      })
      .catch(() => {});
  }, [source.id, isDenormalized]);

  // Step 2: load content based on effective source
  useEffect(() => {
    // Wait for resolution if denormalized
    if (isDenormalized && !resolved) {
      // Still resolving; give it a moment, then fall through
      const timer = setTimeout(() => {
        // If still no resolved source after timeout, load denormalized content
        loadContent(source);
      }, 1500);
      return () => clearTimeout(timer);
    }
    loadContent(eff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff.id, resolved]);

  function loadContent(src: DocumentSource) {
    const srcIsPdf = src.mime_type?.includes("pdf");
    const srcIsExcel =
      src.mime_type?.includes("sheet") ||
      src.mime_type?.includes("excel") ||
      src.filename?.endsWith(".xlsx") ||
      src.filename?.endsWith(".xls");
    const srcIsDocx =
      src.mime_type?.includes("wordprocessingml") ||
      src.filename?.endsWith(".docx") ||
      src.filename?.endsWith(".doc");
    const srcIsPptx =
      src.mime_type?.includes("presentationml") ||
      src.filename?.endsWith(".pptx") ||
      src.filename?.endsWith(".ppt");
    const srcHasOriginal = !!src.storage_path;

    if (srcIsPdf && srcHasOriginal) {
      setLoading(false);
      return;
    }

    if (srcIsPptx && srcHasOriginal) {
      fetch(apiUrl(`/api/sources/pptx-slides?id=${src.id}`), { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.slides && d.slides.length > 0) {
            setPptxSlides(d.slides);
            setLoading(false);
          } else {
            fetchContent(src.id);
          }
        })
        .catch(() => fetchContent(src.id));
      return;
    }

    if (srcIsExcel && srcHasOriginal) {
      fetch(apiUrl(`/api/sources/excel-data?id=${src.id}`), { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.sheets && d.sheets.length > 0) {
            setExcelSheets(d.sheets);
            setLoading(false);
          } else {
            fetchContent(src.id);
          }
        })
        .catch(() => fetchContent(src.id));
      return;
    }

    if (srcIsExcel && !srcHasOriginal) {
      // No original Excel file; show content from chunks
      fetchContent(src.id);
      return;
    }

    if (srcIsDocx && srcHasOriginal) {
      fetch(apiUrl(`/api/sources/docx-html?id=${src.id}`), { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.html) {
            setDocxHtml(d.html);
            setLoading(false);
          } else {
            fetchContent(src.id);
          }
        })
        .catch(() => fetchContent(src.id));
      return;
    }

    // Default: show content from chunks
    fetchContent(src.id);
  }

  function fetchContent(id: number) {
    fetch(apiUrl(`/api/sources/content?id=${id}`), { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
      .catch(() => setContent("Не удалось загрузить содержимое"))
      .finally(() => setLoading(false));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="document-viewer-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="document-viewer-header">
          <div className="document-viewer-title">{source.filename}</div>
          <div className="document-viewer-actions">
            <button
              className="btn-primary"
              style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}
              onClick={() =>
                window.open(
                  apiUrl(`/api/sources/download?id=${eff.id}&action=download${tokenParam}`),
                  "_blank"
                )
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {hasOriginal ? `Скачать (${eff.filename.split('.').pop()?.toUpperCase()})` : "Скачать (.md)"}
            </button>
            <button className="btn-secondary" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
        <div className="document-viewer-body">
          {loading ? (
            <div className="document-viewer-loading">Загрузка...</div>
          ) : isPdf && hasOriginal ? (
            <iframe
              src={apiUrl(`/api/sources/download?id=${eff.id}&action=view${tokenParam}`)}
              className="document-viewer-iframe"
              title={source.filename}
            />
          ) : pptxSlides ? (
            <PptxViewer slides={pptxSlides} />
          ) : excelSheets ? (
            <ExcelViewer sheets={excelSheets} />
          ) : docxHtml ? (
            <div
              className="document-viewer-content docx-preview"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(docxHtml) }}
            />
          ) : (
            <div className="document-viewer-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content || ""}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
