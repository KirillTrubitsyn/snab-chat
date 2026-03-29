"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeHtml } from "@/app/lib/sanitize";
import ExcelViewer from "./ExcelViewer";
import type { Source, ExcelSheet } from "./types";

export default function ChatDocumentViewer({
  source,
  onClose,
  inviteCode,
}: {
  source: Source;
  onClose: () => void;
  inviteCode?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [excelSheets, setExcelSheets] = useState<ExcelSheet[] | null>(null);
  const [pptxEmbedUrl, setPptxEmbedUrl] = useState<string | null>(null);
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
  const isPptx =
    source.mime_type?.includes("presentationml") ||
    source.filename?.endsWith(".pptx") ||
    source.filename?.endsWith(".ppt");
  const hasOriginal = !!source.storage_path;
  const authHeaders: HeadersInit = inviteCode
    ? { "x-invite-code": encodeURIComponent(inviteCode) }
    : {};

  useEffect(() => {
    if (isPdf && hasOriginal) {
      setLoading(false);
      return;
    }
    if (isPptx && hasOriginal) {
      fetch(`/api/sources/signed-url?id=${source.id}`, { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.signedUrl) {
            const officeUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(d.signedUrl)}`;
            setPptxEmbedUrl(officeUrl);
            setLoading(false);
          } else {
            fetch(`/api/sources/content?id=${source.id}`, { headers: authHeaders })
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
          }
        })
        .catch(() => {
          fetch(`/api/sources/content?id=${source.id}`, { headers: authHeaders })
            .then((r) => r.json())
            .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
            .catch(() => setContent("Не удалось загрузить содержимое"))
            .finally(() => setLoading(false));
        });
      return;
    }
    if (isExcel) {
      fetch(`/api/sources/excel-data?id=${source.id}`, { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.sheets && d.sheets.length > 0) {
            setExcelSheets(d.sheets);
            setLoading(false);
          } else {
            fetch(`/api/sources/content?id=${source.id}`, { headers: authHeaders })
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
      fetch(`/api/sources/docx-html?id=${source.id}`, { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.html) {
            setDocxHtml(d.html);
            setLoading(false);
          } else {
            fetch(`/api/sources/content?id=${source.id}`, { headers: authHeaders })
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
          }
        })
        .catch(() => {
          fetch(`/api/sources/content?id=${source.id}`, { headers: authHeaders })
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
        });
      return;
    }
    fetch(`/api/sources/content?id=${source.id}`, { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => setContent(d.markdown || ""))
      .catch(() => setContent("Не удалось загрузить содержимое"))
      .finally(() => setLoading(false));
  }, [source.id, isPdf, isPptx, isExcel, isDocx, hasOriginal, inviteCode]);

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
                  `/api/sources/download?id=${source.id}&action=download${inviteCode ? `&token=${encodeURIComponent(inviteCode)}` : ""}`,
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
              src={`/api/sources/download?id=${source.id}&action=view${inviteCode ? `&token=${encodeURIComponent(inviteCode)}` : ""}`}
              className="document-viewer-iframe"
              title={source.filename}
            />
          ) : pptxEmbedUrl ? (
            <iframe
              src={pptxEmbedUrl}
              className="document-viewer-iframe"
              title={source.filename}
              allowFullScreen
            />
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
