"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

export default function DocumentViewer({
  source,
  onClose,
}: {
  source: DocumentSource;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [excelSheets, setExcelSheets] = useState<ExcelSheet[] | null>(null);
  const [loading, setLoading] = useState(true);
  const isPdf = source.mime_type?.includes("pdf");
  const isExcel =
    source.mime_type?.includes("sheet") ||
    source.mime_type?.includes("excel") ||
    source.filename?.endsWith(".xlsx") ||
    source.filename?.endsWith(".xls");
  const isDocx =
    source.mime_type?.includes("wordprocessingml") ||
    source.filename?.endsWith(".docx") ||
    source.filename?.endsWith(".doc");
  const hasOriginal = !!source.storage_path;

  useEffect(() => {
    if (isPdf && hasOriginal) {
      setLoading(false);
      return;
    }
    if (isExcel) {
      fetch(`/api/sources/excel-data?id=${source.id}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.sheets && d.sheets.length > 0) {
            setExcelSheets(d.sheets);
            setLoading(false);
          } else {
            fetch(`/api/sources/content?id=${source.id}`)
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
          }
        })
        .catch(() => {
          setContent("Не удалось загрузить содержимое");
          setLoading(false);
        });
      return;
    }
    if (isDocx && hasOriginal) {
      fetch(`/api/sources/docx-html?id=${source.id}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.html) {
            setDocxHtml(d.html);
            setLoading(false);
          } else {
            fetch(`/api/sources/content?id=${source.id}`)
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
          }
        })
        .catch(() => {
          fetch(`/api/sources/content?id=${source.id}`)
            .then((r) => r.json())
            .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
            .catch(() => setContent("Не удалось загрузить содержимое"))
            .finally(() => setLoading(false));
        });
      return;
    }
    fetch(`/api/sources/content?id=${source.id}`)
      .then((r) => r.json())
      .then((d) => setContent(d.markdown || ""))
      .catch(() => setContent("Не удалось загрузить содержимое"))
      .finally(() => setLoading(false));
  }, [source.id, isPdf, isExcel, isDocx, hasOriginal]);

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
                  `/api/sources/download?id=${source.id}&action=download`,
                  "_blank"
                )
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {hasOriginal ? `Скачать (${source.filename.split('.').pop()?.toUpperCase()})` : "Скачать (.md)"}
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
              src={`/api/sources/download?id=${source.id}&action=view`}
              className="document-viewer-iframe"
              title={source.filename}
            />
          ) : excelSheets ? (
            <ExcelViewer sheets={excelSheets} />
          ) : docxHtml ? (
            <div
              className="document-viewer-content docx-preview"
              dangerouslySetInnerHTML={{ __html: docxHtml }}
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
