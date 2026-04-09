/**
 * Registry of operational business directives from procurement leadership.
 *
 * These are verbal or informal directives that are NOT yet in the document
 * knowledge base but must be communicated to users when relevant.
 *
 * Pattern mirrors sgk-registry.ts: hardcoded data + prompt generation function.
 * Directives are conditionally injected into the system prompt based on
 * keyword and intent matching — so they don't bloat the prompt for unrelated queries.
 */

import type { QueryIntent } from "./intent-classifier.js";

/* ── Types ── */

export interface BusinessDirective {
  /** Unique identifier */
  id: string;
  /** Who issued the directive */
  source: string;
  /** When (approximate) */
  date: string;
  /** The rule text shown to the model */
  text: string;
  /** Keywords that trigger inclusion (lowercase, partial match) */
  triggerKeywords: string[];
  /** Intent types that trigger inclusion */
  triggerIntents: QueryIntent[];
}

/* ── Registry ── */

export const BUSINESS_DIRECTIVES: BusinessDirective[] = [
  {
    id: "czk-coefficient-gt-1",
    source: "Директор по закупкам Козлов И.Е.",
    date: "2026-04",
    text: "Закупки работ и услуг с коэффициентом к смете более 1 рассматриваются на ЦЗК (Центральная закупочная комиссия). Если коэффициент к смете превышает 1 (т.е. стоимость закупки выше сметной), такая закупка работ или услуг обязательно выносится на рассмотрение ЦЗК. Правило касается закупок работ и услуг (не МТР).",
    triggerKeywords: ["коэффициент", "смет", "цзк", "центральн", "превышен", "полномочи", "закупочн", "комисси", "коллегиальн", "зко", "директив", "козлов", "распоряжен"],
    triggerIntents: ["pricing", "authority"],
  },
];

/* ── Matching logic ── */

export function getMatchingDirectives(
  query: string,
  intent: QueryIntent,
): BusinessDirective[] {
  const lower = query.toLowerCase();
  return BUSINESS_DIRECTIVES.filter((d) => {
    const intentMatch = d.triggerIntents.includes(intent);
    const keywordMatch = d.triggerKeywords.some((kw) => lower.includes(kw));
    return intentMatch || keywordMatch;
  });
}

/* ── Prompt block generation ── */

export function generateDirectivesPromptBlock(
  directives: BusinessDirective[],
): string {
  if (directives.length === 0) return "";

  let block = `\n=== ОПЕРАТИВНЫЕ ДИРЕКТИВЫ РУКОВОДСТВА ===\n\n`;
  block += `Следующие правила введены руководством Дирекции по закупкам и ОБЯЗАТЕЛЬНЫ к применению. `;
  block += `При ответе на вопросы, затронутые этими директивами, ВКЛЮЧИ соответствующее правило в ответ. `;
  block += `Явно указывай источник: «Согласно распоряжению [источник]:»\n\n`;

  for (const d of directives) {
    block += `• [${d.source}, ${d.date}]: ${d.text}\n`;
  }

  return block;
}
