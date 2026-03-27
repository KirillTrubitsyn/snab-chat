/* ── Chat shared types ── */

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  hasSummary: boolean;
}

export interface Source {
  id: number;
  filename: string;
  mime_type: string;
  tags: string[];
  storage_path: string | null;
  folder_path: string | null;
  created_at: string;
}

export interface ChatFile {
  id: string;
  file: File;
  filename: string;
  markdown: string;
  parsing: boolean;
  error?: string;
}

export interface ChatPhoto {
  id: string;
  file: File;
  preview: string;
  markdown: string;
  parsing: boolean;
  error?: string;
}

export interface ExcelSheet {
  name: string;
  rows: string[][];
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  colWidths: number[];
}

/* ── SpeechRecognition types ── */

export interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
export interface SpeechRecognitionResultList { length: number; [index: number]: SpeechRecognitionResult; }
export interface SpeechRecognitionResult { isFinal: boolean; [index: number]: { transcript: string }; }
export interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}
