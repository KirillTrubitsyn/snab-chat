import { useState, useCallback } from "react";
import { apiUrl } from "@/app/lib/api";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function extractFilename(res: Response, defaultExt: string): string {
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*=UTF-8''(.+?)(?:;|$)/);
  return match
    ? decodeURIComponent(match[1])
    : `snabchat-${new Date().toISOString().slice(0, 10)}.${defaultExt}`;
}

async function exportFile(
  endpoint: string,
  defaultExt: string,
  answer: string,
  question: string,
) {
  const res = await fetch(apiUrl(endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, answer }),
  });
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  downloadBlob(blob, extractFilename(res, defaultExt));
}

export function useExport() {
  const [docxDownloading, setDocxDownloading] = useState(false);
  const [xlsxDownloading, setXlsxDownloading] = useState(false);

  const handleExportDocx = useCallback(
    async (answer: string, question: string) => {
      if (docxDownloading) return;
      setDocxDownloading(true);
      try {
        await exportFile("/api/export", "docx", answer, question);
      } catch (e) {
        console.error("DOCX export error:", e);
      } finally {
        setDocxDownloading(false);
      }
    },
    [docxDownloading],
  );

  const handleExportExcel = useCallback(
    async (answer: string, question: string) => {
      if (xlsxDownloading) return;
      setXlsxDownloading(true);
      try {
        await exportFile("/api/export-excel", "xlsx", answer, question);
      } catch (e) {
        console.error("Excel export error:", e);
      } finally {
        setXlsxDownloading(false);
      }
    },
    [xlsxDownloading],
  );

  return { handleExportDocx, handleExportExcel, docxDownloading, xlsxDownloading };
}
