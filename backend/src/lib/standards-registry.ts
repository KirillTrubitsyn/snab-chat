/**
 * Hardcoded registry of procurement standards and regulations across all SGK subsidiaries.
 *
 * Injected into the system prompt when the user asks about standards, ciphers,
 * regulations, or makes broad "all subsidiaries" queries.
 *
 * This eliminates dependence on RAG for cross-entity structural questions
 * ("What are the standard codes for all subsidiaries?",
 *  "List all procurement standards in the SGK group").
 */

import type { QueryIntent } from "./intent-classifier.js";

/* ── Types ── */

export interface StandardEntry {
  /** Cipher code, e.g. С-КЭ-В5-01 */
  code: string;
  /** Full name of the standard/regulation */
  name: string;
  /** Subsidiary entity */
  entity: string;
  /** Short entity alias */
  entityAlias: string;
  /** Document type: standard or regulation */
  docType: "стандарт" | "положение";
  /** Version / edition */
  version: string;
  /** Approval date */
  approvedDate: string;
  /** Approval order */
  approvalOrder: string;
}

/* ── Registry ── */

export const STANDARDS_REGISTRY: StandardEntry[] = [
  // ── Кузбассэнерго ──
  {
    code: "С-КЭ-В5-01",
    name: 'Стандарт «Закупки товаров, работ, услуг для нужд АО «Кузбассэнерго»',
    entity: 'АО «Кузбассэнерго»',
    entityAlias: "КЭ",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "17.10.2025",
    approvalOrder: "Приказ № КЭ/229",
  },
  {
    code: "С-КЭ-В5-02",
    name: 'Стандарт «Формирование, корректировка и утверждение Плана закупок товаров (работ, услуг)»',
    entity: 'АО «Кузбассэнерго»',
    entityAlias: "КЭ",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "17.10.2025",
    approvalOrder: "Приказ № КЭ/229",
  },
  {
    code: "Пл-КЭ-В5-01",
    name: 'Положение о закупках АО «Кузбассэнерго»',
    entity: 'АО «Кузбассэнерго»',
    entityAlias: "КЭ",
    docType: "положение",
    version: "действующая",
    approvedDate: "",
    approvalOrder: "",
  },

  // ── ЕТГК ──
  {
    code: "С-ЕТГК-В5-01",
    name: 'Стандарт «Закупки товаров, работ, услуг для нужд АО «Енисейская ТГК (ТГК-13)»',
    entity: 'АО «Енисейская ТГК (ТГК-13)»',
    entityAlias: "ЕТГК",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "06.11.2025",
    approvalOrder: "Приказ ЕТГК-279 от 06.11.2025",
  },
  {
    code: "Пл-ЕТГК-В5-01",
    name: 'Положение о закупках АО «Енисейская ТГК (ТГК-13)»',
    entity: 'АО «Енисейская ТГК (ТГК-13)»',
    entityAlias: "ЕТГК",
    docType: "положение",
    version: "действующая",
    approvedDate: "02.02.2026",
    approvalOrder: "Приказ ЕТГК-15 от 02.02.2026",
  },

  // ── НТСК ──
  {
    code: "С-НТСК-В5-01",
    name: 'Стандарт «Закупки товаров, работ, услуг для нужд АО «НТСК»',
    entity: 'АО «НТСК» (Новосибирская теплосетевая компания)',
    entityAlias: "НТСК",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "28.11.2025",
    approvalOrder: "Приказ НТСК-637 от 28.11.2025",
  },
  {
    code: "Пл-НТСК-В5-01",
    name: 'Положение о закупках АО «НТСК»',
    entity: 'АО «НТСК»',
    entityAlias: "НТСК",
    docType: "положение",
    version: "12",
    approvedDate: "",
    approvalOrder: "",
  },

  // ── СГК-Алтай ──
  {
    code: "С-СГК-А-В5-01",
    name: 'Стандарт «Закупки товаров, работ, услуг для нужд АО «СГК-Алтай»',
    entity: 'АО «СГК-Алтай»',
    entityAlias: "СГК-А",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "16.10.2025",
    approvalOrder: "Приказ № СГК/А-227",
  },
  {
    code: "Пл-СГК-А-В5-01",
    name: 'Положение о закупках АО «СГК-Алтай»',
    entity: 'АО «СГК-Алтай»',
    entityAlias: "СГК-А",
    docType: "положение",
    version: "действующая",
    approvedDate: "",
    approvalOrder: "",
  },

  // ── СГК-Новосибирск ──
  {
    code: "С-СГК-Н-В5-01",
    name: 'Стандарт «Закупки товаров, работ, услуг для нужд АО «СГК-Новосибирск»',
    entity: 'АО «СГК-Новосибирск»',
    entityAlias: "СГК-Н",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "15.10.2025",
    approvalOrder: "Протокол СД № 27/25",
  },
  {
    code: "Пл-СГК-Н-В5-01",
    name: 'Положение о закупках АО «СГК-Новосибирск»',
    entity: 'АО «СГК-Новосибирск»',
    entityAlias: "СГК-Н",
    docType: "положение",
    version: "действующая",
    approvedDate: "",
    approvalOrder: "",
  },

  // ── ООО «СГК» (вне 223-ФЗ) ──
  {
    code: "С-ГК-В5-03",
    name: 'Стандарт «Закупки ТРУ для нужд ООО «СГК» (вне 223-ФЗ)',
    entity: 'ООО «СГК»',
    entityAlias: "ГК",
    docType: "стандарт",
    version: "2.0",
    approvedDate: "",
    approvalOrder: "",
  },
];

/* ── Trigger keywords ── */

const STANDARDS_TRIGGER_KEYWORDS = [
  "стандарт", "положени", "шифр", "реестр стандарт", "перечень стандарт",
  "все стандарт", "все дочерн", "всех дочерн", "все компании", "всех компан",
  "нормативн", "регламент закуп", "кодификац", "с-кэ", "с-етгк", "с-нтск",
  "с-сгк", "пл-кэ", "пл-етгк", "пл-нтск", "пл-сгк", "в5-01", "в5-02",
];

const STANDARDS_TRIGGER_INTENTS: QueryIntent[] = [
  "regulation",
  "authority",
  "procedure",
];

/* ── Matching logic ── */

export function shouldInjectStandardsRegistry(
  query: string,
  intent: QueryIntent,
): boolean {
  const lower = query.toLowerCase();
  const keywordMatch = STANDARDS_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
  const intentMatch = STANDARDS_TRIGGER_INTENTS.includes(intent);
  // Inject when: keyword match AND (intent match OR broad query about all entities)
  const broadQuery = /все[хм]?\s+(дочерн|компан|общест|стандарт|положен)/i.test(query);
  return keywordMatch || (intentMatch && broadQuery);
}

/* ── Prompt block generation ── */

export function generateStandardsRegistryBlock(): string {
  const lines: string[] = [
    "",
    "## СПРАВОЧНИК: Реестр стандартов и положений о закупках дочерних обществ СГК",
    "",
    "Ниже приведён полный перечень стандартов и положений о закупках для ВСЕХ дочерних обществ СГК, работающих по 223-ФЗ.",
    "Используй эти данные при ответах о стандартах, шифрах, нормативных документах.",
    "ВАЖНО: Стандарты закреплены за дочерними обществами (юрлицами). Филиалы и ОСП работают по стандарту своего головного юрлица. НЕ перечисляй филиалы отдельными строками — указывай только дочерние общества.",
    "",
    "| Дочернее общество | Шифр | Тип | Наименование | Ред. | Дата утв. | Приказ |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const s of STANDARDS_REGISTRY) {
    lines.push(
      `| ${s.entity} | ${s.code} | ${s.docType} | ${s.name} | ${s.version} | ${s.approvedDate || "—"} | ${s.approvalOrder || "—"} |`
    );
  }

  lines.push("");
  lines.push("**Расшифровка шифров:** [Тип]-[Компания]-[Версия]-[Номер]. С = Стандарт, Пл = Положение. КЭ = Кузбассэнерго, ЕТГК = Енисейская ТГК, НТСК = Новосибирская теплосетевая компания, СГК-А = СГК-Алтай, СГК-Н = СГК-Новосибирск, ГК = СГК (головная).");
  lines.push("");

  return lines.join("\n");
}
