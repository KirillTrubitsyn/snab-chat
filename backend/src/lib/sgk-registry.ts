/**
 * Hardcoded registry of SGK group organizations (backend copy).
 *
 * Mirrors app/lib/sgk-registry.ts and is injected into the system prompt
 * in backend/src/routes/chat.ts so the LLM has AUTHORITATIVE organizational
 * data (parent legal entity, 223-ФЗ regime) independent of RAG retrieval.
 *
 * Eliminates hallucinations like "Новомосковская ГРЭС — филиал АО «Квадра»"
 * that arise from the model's pre-training data, and provides a deterministic
 * answer for structural questions ("по какому ФЗ работает НМГРЭС?").
 */
import type { QueryIntent } from "./intent-classifier.js";

/* ── Types ── */

export type FzRegime = "223-fz" | "non-223-fz";

export interface SgkEntity {
  /** Full official name */
  name: string;
  /** Short aliases for matching (lowercase) */
  aliases: string[];
  /** 223-FZ or non-223-FZ */
  regime: FzRegime;
  /** Parent legal entity (null if top-level) */
  parentEntity: string | null;
  /** Relationship type */
  type: "юрлицо" | "филиал" | "ОП" | "ОСП" | "дочернее";
  /** Region (subject of RF) */
  region: string | null;
  /** Business unit for grouping */
  businessUnit: string;
}

/* ── Registry ── */

export const SGK_REGISTRY: SgkEntity[] = [
  // ── ЕНИСЕЙСКАЯ ТГК (ТГК-13) — 223-ФЗ ──
  { name: 'АО «Енисейская ТГК (ТГК-13)»', aliases: ["енисейская тгк", "тгк-13", "тгк 13", "етгк"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Красноярский край", businessUnit: "Енисейская ТГК" },
  { name: "Красноярская ТЭЦ-1", aliases: ["красноярская тэц-1", "красноярская тэц 1", "кр тэц-1"], regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал", region: "Красноярский край", businessUnit: "Енисейская ТГК" },
  { name: "Красноярская ТЭЦ-2", aliases: ["красноярская тэц-2", "красноярская тэц 2", "кр тэц-2"], regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал", region: "Красноярский край", businessUnit: "Енисейская ТГК" },
  { name: "Красноярская ТЭЦ-3", aliases: ["красноярская тэц-3", "красноярская тэц 3", "кр тэц-3"], regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал", region: "Красноярский край", businessUnit: "Енисейская ТГК" },
  { name: "Красноярская ГРЭС-2", aliases: ["красноярская грэс-2", "красноярская грэс 2", "кр грэс-2"], regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал", region: "Красноярский край", businessUnit: "Енисейская ТГК" },
  { name: "Минусинская ТЭЦ", aliases: ["минусинская тэц", "минусинск тэц"], regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал", region: "Красноярский край", businessUnit: "Енисейская ТГК" },
  { name: "Канская ТЭЦ", aliases: ["канская тэц"], regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал", region: "Красноярский край", businessUnit: "Енисейская ТГК" },

  // ── АБАКАНСКАЯ ТЭЦ — 223-ФЗ ──
  { name: 'АО «Абаканская ТЭЦ»', aliases: ["абаканская тэц", "абакан тэц"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Республика Хакасия", businessUnit: "Абаканская ТЭЦ" },

  // ── КУЗБАССЭНЕРГО — 223-ФЗ ──
  { name: 'АО «Кузбассэнерго»', aliases: ["кузбассэнерго", "кэ"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Кемеровская область", businessUnit: "Кузбассэнерго" },
  { name: "Беловская ГРЭС", aliases: ["беловская грэс", "белово грэс"], regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал", region: "Кемеровская область", businessUnit: "Кузбассэнерго" },
  { name: "Томь-Усинская ГРЭС", aliases: ["томь-усинская грэс", "тугрэс", "том усинская"], regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал", region: "Кемеровская область", businessUnit: "Кузбассэнерго" },
  { name: "Приморская ГРЭС", aliases: ["приморская грэс"], regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал", region: "Приморский край", businessUnit: "Кузбассэнерго" },
  { name: "Рефтинская ГРЭС", aliases: ["рефтинская грэс", "рефт грэс"], regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "ОСП", region: "Свердловская область", businessUnit: "Кузбассэнерго" },

  // ── КЕМЕРОВСКАЯ ГЕНЕРАЦИЯ — 223-ФЗ ──
  { name: 'АО «Кемеровская генерация»', aliases: ["кемеровская генерация", "кемген"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Кемеровская область", businessUnit: "Кемеровская генерация" },

  // ── САМОСТОЯТЕЛЬНЫЕ АО — 223-ФЗ ──
  { name: 'АО «Ново-Кемеровская ТЭЦ»', aliases: ["ново-кемеровская тэц", "новокемеровская тэц", "нк тэц"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Кемеровская область", businessUnit: "Ново-Кемеровская ТЭЦ" },
  { name: 'АО «Кузнецкая ТЭЦ»', aliases: ["кузнецкая тэц"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Кемеровская область", businessUnit: "Кузнецкая ТЭЦ" },

  // ── СГК-АЛТАЙ — 223-ФЗ ──
  { name: 'АО «СГК-Алтай»', aliases: ["сгк-алтай", "сгк алтай"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Алтайский край", businessUnit: "СГК-Алтай" },
  { name: "Барнаульская ТЭЦ-2", aliases: ["барнаульская тэц-2", "барнаульская тэц 2", "бтэц-2"], regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал", region: "Алтайский край", businessUnit: "СГК-Алтай" },
  { name: "Барнаульская ТЭЦ-3", aliases: ["барнаульская тэц-3", "барнаульская тэц 3", "бтэц-3"], regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал", region: "Алтайский край", businessUnit: "СГК-Алтай" },
  { name: "Бийскэнерго", aliases: ["бийскэнерго", "бийск энерго"], regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал", region: "Алтайский край", businessUnit: "СГК-Алтай" },

  // ── СГК-НОВОСИБИРСК — 223-ФЗ ──
  { name: 'АО «СГК-Новосибирск»', aliases: ["сгк-новосибирск", "сгк новосибирск", "сибэко"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },
  { name: "Новосибирская ТЭЦ-2", aliases: ["новосибирская тэц-2", "нск тэц-2"], regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },
  { name: "Новосибирская ТЭЦ-3", aliases: ["новосибирская тэц-3", "нск тэц-3"], regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },
  { name: "Новосибирская ТЭЦ-4", aliases: ["новосибирская тэц-4", "нск тэц-4"], regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },
  { name: "Новосибирская ТЭЦ-5", aliases: ["новосибирская тэц-5", "нск тэц-5"], regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },
  { name: "Барабинская ТЭЦ", aliases: ["барабинская тэц"], regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },
  { name: 'ООО «Новосибирская теплосетевая компания»', aliases: ["новосибирская теплосетевая", "нтск"], regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "дочернее", region: "Новосибирская область", businessUnit: "СГК-Новосибирск" },

  // ── ОТДЕЛЬНЫЕ АО — 223-ФЗ ──
  { name: 'АО «Назаровская ГРЭС»', aliases: ["назаровская грэс"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Красноярский край", businessUnit: "Назаровская ГРЭС" },
  { name: 'АО «Кызылская ТЭЦ»', aliases: ["кызылская тэц", "кызыл тэц"], regime: "223-fz", parentEntity: null, type: "юрлицо", region: "Республика Тыва", businessUnit: "Кызылская ТЭЦ" },

  // ── НЕ 223-ФЗ: ООО «СГК» и филиалы ──
  { name: 'ООО «СГК»', aliases: ["ооо сгк", "сгк головной"], regime: "non-223-fz", parentEntity: null, type: "юрлицо", region: null, businessUnit: "ООО СГК" },
  { name: "Красноярский филиал ООО «СГК»", aliases: ["красноярский филиал сгк"], regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал", region: "Красноярский край", businessUnit: "ООО СГК" },
  { name: "Кузбасский филиал ООО «СГК»", aliases: ["кузбасский филиал сгк"], regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал", region: "Кемеровская область", businessUnit: "ООО СГК" },
  { name: "Алтайский филиал ООО «СГК»", aliases: ["алтайский филиал сгк"], regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал", region: "Алтайский край", businessUnit: "ООО СГК" },
  { name: "Новосибирский филиал ООО «СГК»", aliases: ["новосибирский филиал сгк"], regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал", region: "Новосибирская область", businessUnit: "ООО СГК" },

  // ── НЕ 223-ФЗ: АО «СИБЭР» и СибЭМ ──
  { name: 'АО «СИБЭР»', aliases: ["сибэр"], regime: "non-223-fz", parentEntity: null, type: "юрлицо", region: null, businessUnit: "СИБЭР" },
  { name: 'ОСП «Сибирьэнергомонтаж»', aliases: ["сибирьэнергомонтаж", "сибэм"], regime: "non-223-fz", parentEntity: 'АО «СИБЭР»', type: "ОСП", region: null, businessUnit: "СИБЭР" },

  // ── НЕ 223-ФЗ: НОВОМОСКОВСКАЯ ГРЭС (филиал АО «НАК Азот», не входит в СГК) ──
  {
    name: "Новомосковская ГРЭС",
    aliases: ["новомосковская грэс", "нмгрэс", "нм грэс"],
    regime: "non-223-fz",
    parentEntity: 'АО «НАК Азот» (ЕвроХим)',
    type: "филиал",
    region: "Тульская область",
    businessUnit: "ЕвроХим / НАК Азот",
  },
];

/* ── Lookup functions ── */

/**
 * Find entity by longest-alias match (case-insensitive).
 */
export function findEntity(query: string): SgkEntity | null {
  const lower = query.toLowerCase();
  let best: SgkEntity | null = null;
  let bestLen = 0;
  for (const entity of SGK_REGISTRY) {
    for (const alias of entity.aliases) {
      if (lower.includes(alias) && alias.length > bestLen) {
        best = entity;
        bestLen = alias.length;
      }
    }
  }
  return best;
}

/**
 * Find all entities mentioned in text (deduplicated by name).
 */
export function findAllEntities(query: string): SgkEntity[] {
  const lower = query.toLowerCase();
  const found: SgkEntity[] = [];
  const seen = new Set<string>();
  for (const entity of SGK_REGISTRY) {
    if (seen.has(entity.name)) continue;
    for (const alias of entity.aliases) {
      if (lower.includes(alias)) {
        found.push(entity);
        seen.add(entity.name);
        break;
      }
    }
  }
  return found;
}

/* ── Trigger logic ── */

const SGK_REGISTRY_KEYWORD_PATTERNS: RegExp[] = [
  /тэц|грэс|гтэс|теплосет|теплоэнерг|теплотранзит/i,
  /(?:^|\s)(?:ао|зао|пао|ооо)\s*[«"]/i,
  /енисейск|кузбасс|кемеров|абакан|барнаул|новосибирск|минусинск|канск|бийск|рубцовск|приморск|рефтинск|барабинск|томь-усинск|беловск|ново-кемеровск|кузнецк|назаровск|кызыл|новомосковск/i,
  /тгк.?13|етгк|сибэко|сибэм|сибэр|кемген|нтск|нмгрэс/i,
  /сгк.?алтай|сгк.?новосибирск|нак[\s\-]*азот|евро[\s\-]*хим/i,
  /группа?\s*(сгк|компаний)|организаци.*(группы|сгк)|структур.*(сгк|группы)|филиал|дочерн|головн/i,
  /223.?фз.*(кто|как|организац|компан|юрлиц|общество)|режим.*(закупк|организац|компан)|по какому.*(закон|режим|фз)/i,
  /перечень.*(компаний|организаций|обществ)/i,
];

/**
 * Should we inject the SGK registry block into the system prompt?
 * True when the query mentions an entity or asks about group structure/regime.
 */
export function shouldInjectSgkRegistry(query: string, intent: QueryIntent): boolean {
  const lower = query.toLowerCase();
  if (SGK_REGISTRY_KEYWORD_PATTERNS.some((p) => p.test(lower))) return true;
  if (findEntity(query) !== null) return true;
  if (intent === "entity_lookup") return true;
  return false;
}

/* ── Prompt block generation ── */

/**
 * Compact org-registry block highlighting mentioned entity (if any) and
 * the full 223-ФЗ / non-223-ФЗ mapping. Marked AUTHORITATIVE so the model
 * relies on this over its pre-training knowledge.
 */
export function generateSgkRegistryPromptBlock(query: string): string {
  const mentioned = findAllEntities(query);
  const fz223 = SGK_REGISTRY.filter((e) => e.regime === "223-fz" && e.type === "юрлицо");
  const nonFz = SGK_REGISTRY.filter((e) => e.regime === "non-223-fz" && e.type === "юрлицо");

  const lines: string[] = [
    "",
    "=== РЕЕСТР ОРГАНИЗАЦИЙ ГРУППЫ СГК (АВТОРИТЕТНЫЙ ИСТОЧНИК — ХАРДКОД) ===",
    "Этот блок сформирован из актуального «Перечня компаний Общества». Используй ТОЛЬКО эти данные для определения режима закупки (223-ФЗ / вне 223-ФЗ), родительского юрлица, филиальной принадлежности. НЕ ПОЛАГАЙСЯ на общие знания: названия типа «АО Квадра» применительно к СГК/ЕвроХим — устаревшие и НЕВЕРНЫЕ.",
    "",
  ];

  if (mentioned.length > 0) {
    lines.push("## Организации, упомянутые в запросе");
    lines.push("");
    lines.push("| Объект | Головное юрлицо | Тип связи | Режим закупок | Регион |");
    lines.push("|---|---|---|---|---|");
    for (const e of mentioned) {
      const parent = e.parentEntity ?? "— (самостоятельное юрлицо)";
      const regimeLabel = e.regime === "223-fz" ? "223-ФЗ" : "вне 223-ФЗ";
      lines.push(`| ${e.name} | ${parent} | ${e.type} | ${regimeLabel} | ${e.region ?? "—"} |`);
    }
    lines.push("");
  }

  lines.push("## Головные юрлица, работающие по 223-ФЗ");
  for (const e of fz223) lines.push(`- ${e.name}${e.region ? ` (${e.region})` : ""}`);
  lines.push("");
  lines.push("## Головные юрлица вне 223-ФЗ (основные)");
  for (const e of nonFz.slice(0, 12)) lines.push(`- ${e.name}${e.region ? ` (${e.region})` : ""}`);
  lines.push("");
  lines.push("КРИТИЧЕСКИ ВАЖНО:");
  lines.push("1. Новомосковская ГРЭС (НМГРЭС) — ФИЛИАЛ АО «НАК Азот» (входит в группу ЕвроХим, Тульская область). НМГРЭС НЕ является филиалом АО «Квадра», не входит в группу СГК и НЕ РАБОТАЕТ по 223-ФЗ. Для НМГРЭС применяется внутренняя матрица полномочий НАК Азот / приказы по НМГРЭС.");
  lines.push("2. Филиалы ООО «СГК» (Красноярский, Кузбасский, Алтайский, Новосибирский) — НЕ работают по 223-ФЗ.");
  lines.push("3. АО «Ново-Кемеровская ТЭЦ» и АО «Кузнецкая ТЭЦ» — самостоятельные юрлица по 223-ФЗ (НЕ дочерние Кемеровской генерации).");
  lines.push("4. При ответе о конкретной организации СНАЧАЛА определи режим по этому реестру, ПОТОМ отвечай с использованием документов соответствующего режима.");
  lines.push("5. Если пользователь явно противоречит этим данным — это их ошибка; вежливо укажи на расхождение, но не меняй факты.");
  lines.push("");

  return lines.join("\n");
}

/* ── Novomoskovsk authority matrix detection ── */

/**
 * Returns filename hints for the Novomoskovsk GRES authority matrix when
 * the query asks about authority / matrix / thresholds for that facility.
 *
 * Source document (known): "Приложение 1 к Приказу от 16.10.2025 № 355-од/НМГРЭС"
 * stored as "Прил_1_(к_Приказу_НМГРЭС-355_от_16.10.2025)_..." or similar.
 */
export function detectNmgresAuthorityQuery(query: string): string[] | null {
  const lower = query.toLowerCase();
  const mentionsNmgres = /нмгрэс|новомосковск/i.test(lower);
  if (!mentionsNmgres) return null;
  const asksAuthority =
    /матриц|полномочи|лимит|порог|кто (согласов|утвержда|подписыва|принимает)|цзк|зко|закупочн.+комисси|выносить|рассматрива/i.test(
      lower,
    ) ||
    /приказ.*355|355.*нмгрэс|нмгрэс.*355|№\s*355/i.test(lower) ||
    /своя матриц|собственн.+матриц|локальн.+матриц/i.test(lower);
  if (!asksAuthority) return null;
  return [
    "НМГРЭС-355",
    "НМГРЭС_355",
    "355-од",
    "355_од",
    "Приказ НМГРЭС",
    "Приложение 1 к Приказу НМГРЭС",
    "Прил_1_(к_Приказу_НМГРЭС-355",
    "Новомосковская ГРЭС матрица",
    "матрица полномочий Новомосковская",
    "матрица полномочий НМГРЭС",
  ];
}
