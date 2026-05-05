/**
 * Hardcoded registry of canonical procurement lead times.
 *
 * Replies built purely from RAG drift on this topic — semantically nearby
 * chunks ("сроки заседаний ЗК", "сроки рассмотрения заявок") win over the
 * authoritative norm in the Procurement Standard. The user observed this
 * regression on 04.05.2026 ("Замечание №1"). To stop the drift we inject the
 * canonical norm into the system prompt whenever the query touches procurement
 * timing for a known regime.
 *
 * This pattern mirrors directives-registry.ts and standards-registry.ts.
 */

import type { QueryIntent, FzType } from "./intent-classifier.js";

/* ── Types ── */

export interface LeadTimeEntry {
  /** Procurement regime this norm applies to */
  fzType: FzType;
  /** Subsidiary or organisational scope, if narrower than the regime */
  scope?: string;
  /** Source document name and clause */
  citation: string;
  /** The norm text shown to the model */
  text: string;
}

/* ── Registry ── */

export const LEAD_TIME_REGISTRY: LeadTimeEntry[] = [
  {
    fzType: "non-223",
    scope: 'ООО «СГК», СибЭР, СибЭМ',
    citation:
      'Стандарт закупки товаров, работ, услуг для нужд ООО «СГК» (вне 223-ФЗ), п. 2.1.1.Б',
    text:
      'Инициатор закупки при формировании потребности и заявки на закупку учитывает нормативные сроки поставки (отражённые в системе SAP ERP), а также в обязательном порядке (если планируется закупка работ / услуг и/или заказных товаров) прикрепляет к заявке технические задания. Заявки должны быть поданы НЕ ПОЗДНЕЕ ЧЕМ ЗА 60 (ШЕСТЬДЕСЯТ) РАБОЧИХ ДНЕЙ ДО ДАТЫ ЗАКЛЮЧЕНИЯ ДОГОВОРА; при этом установленная дата необходимого начала работ не должна быть ранее даты заключения договора.',
  },
];

/* ── Trigger detection ── */

const LEAD_TIME_KEYWORDS: RegExp[] = [
  /врем[яёе]\s+(?:отведённ|отведенн|на\s+проведени)/i,
  /срок(?:и|ов)?\s+(?:на\s+)?проведени[яе]\s+закупк/i,
  /срок(?:и|ов)?\s+подач[ие]\s+заявк/i,
  /за\s+сколько\s+(?:дней|раб(?:очих)?)\s+(?:до|подава)/i,
  /когда\s+подавать?\s+заявк/i,
  /срок(?:и|ов)?\s+до\s+(?:даты\s+)?заключени/i,
  /сколько\s+(?:дней|времени)\s+(?:на|до|надо)\s+(?:подачу|подать)/i,
];

/**
 * Detect whether the query is about procurement lead time.
 * Pure keyword/regex; no LLM call — used both for prompt injection and
 * downstream retrieval boost.
 */
export function isLeadTimeQuery(query: string): boolean {
  const q = query.toLowerCase();
  return LEAD_TIME_KEYWORDS.some((rx) => rx.test(q));
}

/* ── Prompt block generation ── */

export function shouldInjectLeadTimeRegistry(
  query: string,
  _intent: QueryIntent,
): boolean {
  return isLeadTimeQuery(query);
}

export function generateLeadTimePromptBlock(fzType: FzType): string {
  const matching = LEAD_TIME_REGISTRY.filter((e) => {
    if (fzType === "unknown" || fzType === "both") return true;
    return e.fzType === fzType || e.fzType === "both";
  });
  if (matching.length === 0) return "";

  let block = `\n=== СРОКИ ПОДАЧИ ЗАЯВКИ НА ЗАКУПКУ (КАНОНИЧЕСКАЯ НОРМА) ===\n\n`;
  block += `Если пользователь спрашивает о сроках, отведённых на проведение закупки, нормативном сроке подачи заявки или времени до заключения договора — приоритет имеет следующая норма из Стандарта закупки. Не подменяй её регламентом заседаний ЗК, сроками рассмотрения заявок или этапами переторжки — это смежные, но другие понятия.\n\n`;
  for (const e of matching) {
    const scopeLabel = e.scope ? ` (${e.scope})` : "";
    block += `• Режим ${e.fzType}${scopeLabel} — ${e.citation}:\n  ${e.text}\n\n`;
  }
  block += `Цитируй пункт стандарта дословно. Если режим в запросе не определён, приведи нормы по обоим режимам.\n`;
  return block;
}
