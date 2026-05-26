/**
 * Filename generation policy for exported answers / spreadsheets.
 *
 * Format: "<YYYY-MM-DD> <up-to-6-topic-words>.<ext>"
 *
 * Date prefix sorts files chronologically in the user's file manager.
 * "СнабЧат" / "snabchat" branding is deliberately omitted from the
 * filename — the user already knows where the file came from, and the
 * brand prefix is clutter when many files land in one folder.
 *
 * Pure utility — no I/O, no model deps, easy to test in vitest.
 */

const DOCX_STOP_WORDS = new Set<string>([
  "что", "как", "это", "тот", "так", "там", "тем", "его", "её", "их",
  "для", "или", "при", "над", "под", "без", "про", "под", "над", "что",
  "какой", "какая", "какие", "чем", "кто", "где", "когда", "почему",
  "есть", "быть", "был", "была", "были", "будет", "может", "можно",
  "нужно", "надо", "ещё", "еще", "уже", "так", "очень", "более",
  "скажи", "расскажи", "объясни", "опиши", "подскажи", "покажи",
  "пожалуйста", "какое",
]);

const XLSX_STOP_WORDS = new Set<string>([
  ...DOCX_STOP_WORDS,
  // XLSX additionally drops words that describe the OUTPUT FORMAT
  // (the user always asks "сделай ТАБЛИЦУ" — that word is useless
  // in the filename) so the topic words get the slots.
  "составь", "создай", "сделай", "таблицу", "таблица", "excel", "xlsx",
]);

/** Internal: pull the most informative N words from a question. */
function topicWords(question: string, stop: Set<string>, n: number): string[] {
  return question
    .replace(/[^\wа-яА-ЯёЁ\s-]/g, "")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, n);
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function capitaliseFirst(words: string[]): string[] {
  if (words.length === 0) return words;
  const first = words[0];
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)];
}

/**
 * Six topic-word slots give ~50–80 chars of meaningful content — enough
 * to tell apart "Положение о закупках НТСК" from "Положение о закупках
 * ЕТГК" without making the filename hostile to file managers.
 */
const TOPIC_WORD_SLOTS = 6;

export function generateDocxFilename(question: string): string {
  const date = isoDate();
  const words = capitaliseFirst(topicWords(question, DOCX_STOP_WORDS, TOPIC_WORD_SLOTS));
  if (words.length === 0) return `${date} ответ.docx`;
  return `${date} ${words.join(" ")}.docx`;
}

export function generateXlsxFilename(question: string): string {
  const date = isoDate();
  const words = capitaliseFirst(topicWords(question, XLSX_STOP_WORDS, TOPIC_WORD_SLOTS));
  if (words.length === 0) return `${date} таблица.xlsx`;
  return `${date} ${words.join(" ")}.xlsx`;
}

/**
 * ASCII fallback for the Content-Disposition `filename=` attribute.
 * Used by older browsers that cannot decode RFC 5987 `filename*=UTF-8''…`.
 * Date-prefixed, brand-free, ASCII-only.
 */
export function asciiFilename(ext: "docx" | "xlsx"): string {
  const noun = ext === "docx" ? "document" : "spreadsheet";
  return `${isoDate()}-${noun}.${ext}`;
}
