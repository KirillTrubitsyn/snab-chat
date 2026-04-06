"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeHtml } from "@/app/lib/sanitize";
import { apiUrl } from "@/app/lib/api";
import ExcelViewer from "./ExcelViewer";
import type { Source, ExcelSheet } from "./types";

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
  const [pptxSlides, setPptxSlides] = useState<PptxSlide[] | null>(null);
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
      fetch(apiUrl(`/api/sources/pptx-slides?id=${source.id}`), { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.slides && d.slides.length > 0) {
            setPptxSlides(d.slides);
            setLoading(false);
          } else {
            fetch(apiUrl(`/api/sources/content?id=${source.id}`), { headers: authHeaders })
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
          }
        })
        .catch(() => {
          fetch(apiUrl(`/api/sources/content?id=${source.id}`), { headers: authHeaders })
            .then((r) => r.json())
            .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
            .catch(() => setContent("Не удалось загрузить содержимое"))
            .finally(() => setLoading(false));
        });
      return;
    }
    if (isExcel) {
      fetch(apiUrl(`/api/sources/excel-data?id=${source.id}`), { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.sheets && d.sheets.length > 0) {
            setExcelSheets(d.sheets);
            setLoading(false);
          } else {
            fetch(apiUrl(`/api/sources/content?id=${source.id}`), { headers: authHeaders })
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
      fetch(apiUrl(`/api/sources/docx-html?id=${source.id}`), { headers: authHeaders })
        .then((r) => r.json())
        .then((d) => {
          if (d.html) {
            setDocxHtml(d.html);
            setLoading(false);
          } else {
            fetch(apiUrl(`/api/sources/content?id=${source.id}`), { headers: authHeaders })
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
          }
        })
        .catch(() => {
          fetch(apiUrl(`/api/sources/content?id=${source.id}`), { headers: authHeaders })
              .then((r) => r.json())
              .then((d) => setContent(d.markdown || "Не удалось загрузить содержимое"))
              .catch(() => setContent("Не удалось загрузить содержимое"))
              .finally(() => setLoading(false));
        });
      return;
    }
    fetch(apiUrl(`/api/sources/content?id=${source.id}`), { headers: authHeaders })
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
              onClick={() => {
                const isMd = source.filename.endsWith(".md") || source.mime_type === "application/x-denormalized";
                const endpoint = !hasOriginal && isMd ? "download-docx" : "download";
                window.open(
                  apiUrl(`/api/sources/${endpoint}?id=${source.id}&action=download${inviteCode ? `&token=${encodeURIComponent(inviteCode)}` : ""}`),
                  "_blank"
                );
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {hasOriginal ? `Скачать (${source.filename.split('.').pop()?.toUpperCase()})` : "Скачать (.docx)"}
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
              src={apiUrl(`/api/sources/download?id=${source.id}&action=view${inviteCode ? `&token=${encodeURIComponent(inviteCode)}` : ""}`)}
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
