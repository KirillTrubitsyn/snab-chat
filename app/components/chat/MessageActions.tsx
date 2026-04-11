"use client";

import { InfographicIcon } from "./icons";

export interface MessageActionsProps {
  content: string;
  onCreateInfographic?: (content: string) => void;
  onExportDocx?: (content: string) => void;
  onExportExcel?: (content: string) => void;
}

export function MessageActions({
  content,
  onCreateInfographic,
  onExportDocx,
  onExportExcel,
}: MessageActionsProps) {
  if (!onCreateInfographic && !onExportDocx && !onExportExcel) return null;

  return (
    <div className="message-infographic-row">
      {onCreateInfographic && (
        <button
          className="message-infographic-btn"
          onClick={() => onCreateInfographic(content)}
          title="Создать инфографику на основе этого ответа"
        >
          <InfographicIcon size={14} />
          Создать инфографику
        </button>
      )}
      {onExportDocx && (
        <button
          className="message-infographic-btn message-export-btn"
          onClick={() => onExportDocx(content)}
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
          onClick={() => onExportExcel(content)}
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
  );
}

export interface FollowUpChipsProps {
  questions: string[];
  onFollowUpClick: (text: string) => void;
}

export function FollowUpChips({ questions, onFollowUpClick }: FollowUpChipsProps) {
  if (questions.length === 0) return null;

  return (
    <div className="followup-section">
      <div className="followup-label">💡 Вам также может быть полезно:</div>
      <div className="followup-chips">
        {questions.map((q, i) => (
          <button key={i} className="followup-chip" onClick={() => onFollowUpClick(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
