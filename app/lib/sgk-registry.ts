/**
 * Hardcoded registry of SGK group organizations.
 *
 * Provides:
 * - 223-FZ / non-223-FZ classification for every entity
 * - Parent legal entity → structural subdivision mapping
 * - Procurement threshold tiers
 * - Alias resolution (short names, abbreviations, ГРЭС/ТЭЦ names)
 *
 * This eliminates dependence on RAG for basic structural questions
 * ("Does НМГРЭС work under 223-FZ?", "Which entity does Минусинская ТЭЦ belong to?").
 */

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
  /** Procurement threshold (thousands of rubles, without VAT). null = no threshold (internal rules) */
  thresholdKRub: number | null;
  /** Business unit for grouping */
  businessUnit: string;
  /** Region (subject of RF) */
  region: string | null;
}

/* ── Registry ── */

export const SGK_REGISTRY: SgkEntity[] = [
  // ═══════════════════════════════════════════════════════════
  // ЕНИСЕЙСКАЯ ТГК (ТГК-13) — 223-ФЗ — Красноярский край
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Енисейская ТГК (ТГК-13)»',
    aliases: ["енисейская тгк", "тгк-13", "тгк 13", "етгк"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Красноярская ТЭЦ-1",
    aliases: ["красноярская тэц-1", "красноярская тэц 1", "кр тэц-1"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Красноярская ТЭЦ-2",
    aliases: ["красноярская тэц-2", "красноярская тэц 2", "кр тэц-2"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Красноярская ТЭЦ-3",
    aliases: ["красноярская тэц-3", "красноярская тэц 3", "кр тэц-3"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Красноярская ГРЭС-2",
    aliases: ["красноярская грэс-2", "красноярская грэс 2", "кр грэс-2"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Минусинская ТЭЦ",
    aliases: ["минусинская тэц", "минусинск тэц"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Канская ТЭЦ",
    aliases: ["канская тэц"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Красноярская Теплосеть",
    aliases: ["красноярская теплосеть", "кр теплосеть"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: "Канская теплосеть",
    aliases: ["канская теплосеть"],
    regime: "223-fz", parentEntity: 'АО «Енисейская ТГК (ТГК-13)»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },
  {
    name: 'ООО «РТК-генерация»',
    aliases: ["ртк-генерация", "ртк генерация"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "Енисейская ТГК", region: "Красноярский край",
  },

  // ═══════════════════════════════════════════════════════════
  // АБАКАНСКАЯ ТЭЦ — 223-ФЗ — Республика Хакасия
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Абаканская ТЭЦ»',
    aliases: ["абаканская тэц", "абакан тэц"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "Абаканская ТЭЦ", region: "Республика Хакасия",
  },
  {
    name: "Южно-Сибирская теплосетевая компания",
    aliases: ["южно-сибирская теплосетевая", "юстк"],
    regime: "223-fz", parentEntity: 'АО «Абаканская ТЭЦ»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Абаканская ТЭЦ", region: "Республика Хакасия",
  },

  // ═══════════════════════════════════════════════════════════
  // КУЗБАССЭНЕРГО — 223-ФЗ — Кемеровская область
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Кузбассэнерго»',
    aliases: ["кузбассэнерго", "кэ"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Кемеровская область",
  },
  {
    name: "Беловская ГРЭС",
    aliases: ["беловская грэс", "белово грэс"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Кемеровская область",
  },
  {
    name: "ГТЭС Новокузнецкая",
    aliases: ["гтэс новокузнецкая", "новокузнецкая гтэс"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "ОП",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Кемеровская область",
  },
  {
    name: "Томь-Усинская ГРЭС",
    aliases: ["томь-усинская грэс", "тугрэс", "том усинская"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Кемеровская область",
  },
  {
    name: "Кемеровская теплосетевая компания",
    aliases: ["кемеровская теплосетевая", "кем теплосеть"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Кемеровская область",
  },
  {
    name: "Межрегиональная теплосетевая компания",
    aliases: ["межрегиональная теплосетевая", "мтск"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Кемеровская область",
  },
  {
    name: "Приморская ГРЭС",
    aliases: ["приморская грэс"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "филиал",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Приморский край",
  },
  {
    name: "Рефтинская ГРЭС",
    aliases: ["рефтинская грэс", "рефт грэс"],
    regime: "223-fz", parentEntity: 'АО «Кузбассэнерго»', type: "ОСП",
    thresholdKRub: 500, businessUnit: "Кузбассэнерго", region: "Свердловская область",
  },

  // ═══════════════════════════════════════════════════════════
  // КЕМЕРОВСКАЯ ГЕНЕРАЦИЯ — 223-ФЗ — Кемеровская область
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Кемеровская генерация»',
    aliases: ["кемеровская генерация", "кемген"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "Кемеровская генерация", region: "Кемеровская область",
  },
  {
    name: "Кемеровская ГРЭС",
    aliases: ["кемеровская грэс", "кем грэс"],
    regime: "223-fz", parentEntity: 'АО «Кемеровская генерация»', type: "ОП",
    thresholdKRub: 500, businessUnit: "Кемеровская генерация", region: "Кемеровская область",
  },
  {
    name: "Кемеровская ТЭЦ",
    aliases: ["кемеровская тэц", "кем тэц"],
    regime: "223-fz", parentEntity: 'АО «Кемеровская генерация»', type: "ОП",
    thresholdKRub: 500, businessUnit: "Кемеровская генерация", region: "Кемеровская область",
  },

  // ═══════════════════════════════════════════════════════════
  // САМОСТОЯТЕЛЬНЫЕ АО — 223-ФЗ — Кемеровская область
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Ново-Кемеровская ТЭЦ»',
    aliases: ["ново-кемеровская тэц", "новокемеровская тэц", "нк тэц"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "Ново-Кемеровская ТЭЦ", region: "Кемеровская область",
  },
  {
    name: 'АО «Кузнецкая ТЭЦ»',
    aliases: ["кузнецкая тэц"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "Кузнецкая ТЭЦ", region: "Кемеровская область",
  },

  // ═══════════════════════════════════════════════════════════
  // СГК-АЛТАЙ — 223-ФЗ — Алтайский край
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «СГК-Алтай»',
    aliases: ["сгк-алтай", "сгк алтай", "алтай"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },
  {
    name: "Барнаульская ТЭЦ-2",
    aliases: ["барнаульская тэц-2", "барнаульская тэц 2", "бтэц-2"],
    regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },
  {
    name: "Барнаульская ТЭЦ-3",
    aliases: ["барнаульская тэц-3", "барнаульская тэц 3", "бтэц-3"],
    regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },
  {
    name: "Барнаульская теплосетевая компания",
    aliases: ["барнаульская теплосетевая", "барн теплосеть"],
    regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },
  {
    name: "Рубцовский теплоэнергетический комплекс",
    aliases: ["рубцовский тэк", "рубцовск тэк"],
    regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },
  {
    name: "Бийскэнерго",
    aliases: ["бийскэнерго", "бийск энерго"],
    regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },
  {
    name: "БийскэнергоТеплоТранзит",
    aliases: ["бийскэнерготеплотранзит", "бийск теплотранзит"],
    regime: "223-fz", parentEntity: 'АО «СГК-Алтай»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Алтай", region: "Алтайский край",
  },

  // ═══════════════════════════════════════════════════════════
  // СГК-НОВОСИБИРСК (бывш. СИБЭКО) — 223-ФЗ — Новосибирская область
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «СГК-Новосибирск»',
    aliases: ["сгк-новосибирск", "сгк новосибирск", "сибэко"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: "Новосибирская ТЭЦ-2",
    aliases: ["новосибирская тэц-2", "новосибирская тэц 2", "нск тэц-2"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: "Новосибирская ТЭЦ-3",
    aliases: ["новосибирская тэц-3", "новосибирская тэц 3", "нск тэц-3"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: "Новосибирская ТЭЦ-4",
    aliases: ["новосибирская тэц-4", "новосибирская тэц 4", "нск тэц-4"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: "Новосибирская ТЭЦ-5",
    aliases: ["новосибирская тэц-5", "новосибирская тэц 5", "нск тэц-5"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: "Барабинская ТЭЦ",
    aliases: ["барабинская тэц"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "ОП",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: "Тепловые сети (СГК-Новосибирск)",
    aliases: ["тепловые сети сибэко", "тепловые сети сгк-новосибирск", "нск теплосеть"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "филиал",
    thresholdKRub: 500, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: 'ООО «Новосибирская теплосетевая компания»',
    aliases: ["новосибирская теплосетевая", "нтск"],
    regime: "223-fz", parentEntity: 'АО «СГК-Новосибирск»', type: "дочернее",
    thresholdKRub: 100, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },
  {
    name: 'ООО «Энергетик»',
    aliases: ["энергетик"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "СГК-Новосибирск", region: "Новосибирская область",
  },

  // ═══════════════════════════════════════════════════════════
  // ОТДЕЛЬНЫЕ АО — 223-ФЗ
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Назаровская ГРЭС»',
    aliases: ["назаровская грэс", "нгрэс"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 500, businessUnit: "Назаровская ГРЭС", region: "Красноярский край",
  },
  {
    name: 'ООО «КрасТЭК»',
    aliases: ["крастэк"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "КрасТЭК", region: "Красноярский край",
  },
  {
    name: 'АО «Кызылская ТЭЦ»',
    aliases: ["кызылская тэц", "кызыл тэц"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "Кызылская ТЭЦ", region: "Республика Тыва",
  },
  {
    name: 'ООО «Теплоэнергетик»',
    aliases: ["теплоэнергетик"],
    regime: "223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: 100, businessUnit: "Теплоэнергетик", region: null,
  },

  // ═══════════════════════════════════════════════════════════
  // НЕ 223-ФЗ: ООО «СГК» и филиалы
  // ═══════════════════════════════════════════════════════════
  {
    name: 'ООО «СГК»',
    aliases: ["ооо сгк", "сгк головной"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "ООО СГК", region: null,
  },
  {
    name: "Красноярский филиал ООО «СГК»",
    aliases: ["красноярский филиал сгк", "кр филиал"],
    regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал",
    thresholdKRub: null, businessUnit: "ООО СГК", region: "Красноярский край",
  },
  {
    name: "Кузбасский филиал ООО «СГК»",
    aliases: ["кузбасский филиал сгк", "кузбасс филиал"],
    regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал",
    thresholdKRub: null, businessUnit: "ООО СГК", region: "Кемеровская область",
  },
  {
    name: "Алтайский филиал ООО «СГК»",
    aliases: ["алтайский филиал сгк"],
    regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал",
    thresholdKRub: null, businessUnit: "ООО СГК", region: "Алтайский край",
  },
  {
    name: "Новосибирский филиал ООО «СГК»",
    aliases: ["новосибирский филиал сгк", "нск филиал"],
    regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "филиал",
    thresholdKRub: null, businessUnit: "ООО СГК", region: "Новосибирская область",
  },
  {
    name: 'ОСП «Рефтинское» ООО «СГК»',
    aliases: ["осп рефтинское"],
    regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "ОСП",
    thresholdKRub: null, businessUnit: "ООО СГК", region: "Свердловская область",
  },
  {
    name: 'ОСП «Приморское» ООО «СГК»',
    aliases: ["осп приморское"],
    regime: "non-223-fz", parentEntity: 'ООО «СГК»', type: "ОСП",
    thresholdKRub: null, businessUnit: "ООО СГК", region: "Приморский край",
  },

  // ═══════════════════════════════════════════════════════════
  // НЕ 223-ФЗ: СИБЭР
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «СИБЭР»',
    aliases: ["сибэр"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СИБЭР", region: null,
  },
  {
    name: 'ОСП «Сибирьэнергомонтаж»',
    aliases: ["сибирьэнергомонтаж", "сибэм"],
    regime: "non-223-fz", parentEntity: 'АО «СИБЭР»', type: "ОСП",
    thresholdKRub: null, businessUnit: "СИБЭР", region: null,
  },

  // ═══════════════════════════════════════════════════════════
  // НЕ 223-ФЗ: ПРОЧИЕ
  // ═══════════════════════════════════════════════════════════
  {
    name: 'ООО «Сибирская теплосбытовая компания»',
    aliases: ["сибирская теплосбытовая", "стк"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'АО «Сибирский инженерно-аналитический центр»',
    aliases: ["сибирский инженерно-аналитический", "сиац"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: "Новомосковская ГРЭС",
    aliases: ["новомосковская грэс", "нмгрэс", "нм грэс"],
    regime: "non-223-fz", parentEntity: 'АО «НАК Азот» (ЕвроХим)', type: "филиал",
    thresholdKRub: null, businessUnit: "ЕвроХим", region: "Тульская область",
  },
  {
    name: 'ЧОУ ДПО «Энергоцентр»',
    aliases: ["энергоцентр"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'ООО «БАМовская ТЭС-1»',
    aliases: ["бамовская тэс", "бам тэс"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: "Амурская область",
  },
  {
    name: 'ООО «Сибирский БИТ»',
    aliases: ["сибирский бит"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: "Кемеровская область",
  },
  {
    name: 'ООО «Модульные Системы Торнадо»',
    aliases: ["модульные системы торнадо", "торнадо"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'ООО «УралТЭП»',
    aliases: ["уралтэп"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'ООО «Назаровское рыбное хозяйство»',
    aliases: ["назаровское рыбное"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },

  // ═══════════════════════════════════════════════════════════
  // НЕ 223-ФЗ: СУЭК
  // ═══════════════════════════════════════════════════════════
  {
    name: 'ООО «СУЭК-Хакасия»',
    aliases: ["суэк-хакасия", "суэк хакасия"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СУЭК", region: "Республика Хакасия",
  },
  {
    name: 'АО «СУЭК-Кузбасс»',
    aliases: ["суэк-кузбасс", "суэк кузбасс"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СУЭК", region: "Кемеровская область",
  },
  {
    name: 'АО «СУЭК-Красноярск»',
    aliases: ["суэк-красноярск", "суэк красноярск"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СУЭК", region: "Красноярский край",
  },
  {
    name: 'ООО «Единая сервисная компания СУЭК»',
    aliases: ["единая сервисная суэк", "еск суэк"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СУЭК", region: null,
  },
  {
    name: 'ООО «Алтай-СУЭК»',
    aliases: ["алтай-суэк", "алтай суэк"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СУЭК", region: "Алтайский край",
  },
  {
    name: 'ООО «Хабаровск-СУЭК»',
    aliases: ["хабаровск-суэк", "хабаровск суэк"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "СУЭК", region: "Хабаровский край",
  },

  // ═══════════════════════════════════════════════════════════
  // НЕ 223-ФЗ: УГОЛЬНЫЕ РАЗРЕЗЫ
  // ═══════════════════════════════════════════════════════════
  {
    name: 'АО «Разрез Канский»',
    aliases: ["разрез канский"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Угольные разрезы", region: "Красноярский край",
  },
  {
    name: 'ООО «Восточно-Бейский разрез»',
    aliases: ["восточно-бейский разрез"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Угольные разрезы", region: "Республика Хакасия",
  },
  {
    name: 'АО «Разрез Харанорский»',
    aliases: ["разрез харанорский"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Угольные разрезы", region: "Забайкальский край",
  },
  {
    name: 'АО «Разрез Тугнуйский»',
    aliases: ["разрез тугнуйский"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Угольные разрезы", region: "Республика Бурятия",
  },
  {
    name: 'АО «Ургалуголь»',
    aliases: ["ургалуголь"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Угольные разрезы", region: "Хабаровский край",
  },

  // ═══════════════════════════════════════════════════════════
  // НЕ 223-ФЗ: ИНЖИНИРИНГ / ЛОГИСТИКА
  // ═══════════════════════════════════════════════════════════
  {
    name: 'ООО «Уголь-инжиниринг»',
    aliases: ["уголь-инжиниринг"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'ООО «СибПромРешения»',
    aliases: ["сибпромрешения"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'ООО «Сибкор»',
    aliases: ["сибкор"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
  {
    name: 'ООО «СИБ-ДАМЕЛЬ»',
    aliases: ["сиб-дамель"],
    regime: "non-223-fz", parentEntity: null, type: "юрлицо",
    thresholdKRub: null, businessUnit: "Прочие", region: null,
  },
];


/* ── Lookup functions ── */

/**
 * Find entity by alias match (case-insensitive).
 * Returns the best match (longest alias match wins).
 */
export function findEntity(query: string): SgkEntity | null {
  const lower = query.toLowerCase();
  let bestMatch: SgkEntity | null = null;
  let bestLen = 0;

  for (const entity of SGK_REGISTRY) {
    for (const alias of entity.aliases) {
      if (lower.includes(alias) && alias.length > bestLen) {
        bestMatch = entity;
        bestLen = alias.length;
      }
    }
  }

  return bestMatch;
}

/**
 * Find all entities mentioned in text.
 */
export function findAllEntities(query: string): SgkEntity[] {
  const lower = query.toLowerCase();
  const found: SgkEntity[] = [];
  const foundNames = new Set<string>();

  for (const entity of SGK_REGISTRY) {
    if (foundNames.has(entity.name)) continue;
    for (const alias of entity.aliases) {
      if (lower.includes(alias)) {
        found.push(entity);
        foundNames.add(entity.name);
        break;
      }
    }
  }

  return found;
}

/**
 * Get all subdivisions of a given parent entity.
 */
export function getSubdivisions(parentName: string): SgkEntity[] {
  return SGK_REGISTRY.filter((e) => e.parentEntity === parentName);
}

/**
 * Determine FZ regime for an entity mentioned in query.
 * Returns null if no entity recognized.
 */
export function detectRegime(query: string): { entity: SgkEntity; regime: FzRegime; parentInfo: string } | null {
  const entity = findEntity(query);
  if (!entity) return null;

  const parentInfo = entity.parentEntity
    ? `${entity.type} ${entity.parentEntity}`
    : `самостоятельное юридическое лицо`;

  return { entity, regime: entity.regime, parentInfo };
}

/**
 * Generate a compact reference block for the system prompt.
 * Lists key entities with their regime for the model's reference.
 */
export function generateRegistryPromptBlock(): string {
  const fz223 = SGK_REGISTRY.filter((e) => e.regime === "223-fz" && e.type === "юрлицо");
  const nonFz = SGK_REGISTRY.filter((e) => e.regime === "non-223-fz" && e.type === "юрлицо");

  let block = `=== РЕЕСТР ОРГАНИЗАЦИЙ ГРУППЫ СГК (ХАРДКОД) ===

ОРГАНИЗАЦИИ ПО 223-ФЗ (головные юрлица):
`;
  for (const e of fz223) {
    const subs = getSubdivisions(e.name);
    const subList = subs.length > 0
      ? ` → филиалы/ОП: ${subs.map((s) => s.name).join(", ")}`
      : "";
    const regionInfo = e.region ? `, ${e.region}` : "";
    block += `• ${e.name} (порог ${e.thresholdKRub} тыс. руб.${regionInfo})${subList}\n`;
  }

  block += `\nОРГАНИЗАЦИИ ВНЕ 223-ФЗ (основные):
`;
  for (const e of nonFz.filter((e) => e.businessUnit !== "Угольные разрезы")) {
    const subs = getSubdivisions(e.name);
    const subList = subs.length > 0
      ? ` → ${subs.map((s) => s.name).join(", ")}`
      : "";
    block += `• ${e.name}${subList}\n`;
  }

  block += `\nВАЖНО: Новомосковская ГРЭС (НМГРЭС) — филиал АО «НАК Азот» (ЕвроХим), НЕ работает по 223-ФЗ.
ВАЖНО: ООО «НТСК» (Новосибирская теплосетевая компания) — дочернее АО «СГК-Новосибирск», работает по 223-ФЗ (порог 100 тыс. руб.).
ВАЖНО: АО «Ново-Кемеровская ТЭЦ» и АО «Кузнецкая ТЭЦ» — самостоятельные юрлица по 223-ФЗ (НЕ дочерние Кемеровской генерации).
ВАЖНО: Филиалы ООО «СГК» (Красноярский, Кузбасский, Алтайский, Новосибирский) — НЕ работают по 223-ФЗ.

При ответе на вопрос о конкретной организации/объекте СНАЧАЛА определи режим закупки по этому реестру, ПОТОМ отвечай на вопрос с использованием документов соответствующего режима.`;

  return block;
}
