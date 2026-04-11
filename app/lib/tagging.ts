/* ── Document Categories (9 types) ── */
export const DOCUMENT_CATEGORIES = [
  { key: "npa", label: "НПА", icon: "gavel" },
  { key: "standards", label: "Стандарты и Положения", icon: "verified" },
  { key: "forms", label: "Формы и Шаблоны", icon: "article" },
  { key: "schemas", label: "Схемы процессов", icon: "schema" },
  { key: "instructions", label: "Инструкции и Методики", icon: "menu_book" },
  { key: "pricing", label: "Ценообразование", icon: "payments" },
  { key: "references", label: "Справочники и Реестры", icon: "list_alt" },
  { key: "contractor-cards", label: "Карточки контрагентов", icon: "badge" },
  { key: "contracts", label: "Договоры", icon: "handshake" },
  { key: "training", label: "Обучение", icon: "school" },
] as const;

const VALID_CATEGORY_KEYS = new Set<string>(DOCUMENT_CATEGORIES.map((c) => c.key));

const FOLDER_PATH_ALIASES: Record<string, string> = {
  registries: "contractor-cards",
};

/** Нормализация folder_path в валидный ключ категории */
export function normalizeFolderPath(fp: string | null | undefined): string {
  if (!fp) return "standards";
  if (VALID_CATEGORY_KEYS.has(fp)) return fp;
  return FOLDER_PATH_ALIASES[fp] || "standards";
}

/* ── Keyword → Category mapping ── */
export const CATEGORY_KEYWORDS: Record<string, string> = {
  "федеральный закон": "npa",
  "постановление правительства": "npa",
  "223-фз": "npa",
  "кодекс": "npa",
  "ценообразование": "pricing",
  "стоимость чел-час": "pricing",
  "сметная стоимость": "pricing",
  "базовые цены": "pricing",
  "индексы": "pricing",
  "индекс": "pricing",
  "коэффициент": "pricing",
  "тариф": "pricing",
  "нмцд": "pricing",
  "фер": "pricing",
  "справочник": "references",
  "реестр": "references",
  "перечень": "references",
  "лимит": "references",
  "классификатор": "references",
  "нормативные сроки": "references",
  "зоны ответственности": "references",
  "список ответственных": "references",
  "карточка контрагента": "contractor-cards",
  "карточка поставщика": "contractor-cards",
  "история закупок": "contractor-cards",
  "сведения о контрагенте": "contractor-cards",
  "сведения о поставщике": "contractor-cards",
  "досье поставщика": "contractor-cards",
  "договор": "contracts",
  "контракт": "contracts",
  "дополнительное соглашение": "contracts",
  "агентский": "contracts",
  "инструкция": "instructions",
  "методика": "instructions",
  "руководство": "instructions",
  "памятка": "instructions",
  "onboarding": "instructions",
  "обучение": "training",
  "курс": "training",
  "тренинг": "training",
  "учебный": "training",
  "форма": "forms",
  "шаблон": "forms",
  "бланк": "forms",
  "образец": "forms",
  "анкета": "forms",
  "инициация": "forms",
  "служебная записка": "forms",
  "спецификация": "forms",
  "техническое задание": "forms",
  "протокол": "forms",
  "бюллетень": "forms",
  "извещение": "forms",
  "обоснование нмцд": "forms",
  "заявка": "forms",
  "блок-схема": "schemas",
  "схема": "schemas",
  "алгоритм": "schemas",
  "диаграмма": "schemas",
  "стандарт": "standards",
  "положение": "standards",
  "регламент": "standards",
  "приказ": "standards",
  "правила": "standards",
  "закон": "npa",
  "постановление": "npa",
  "указ": "npa",
  "распоряжение": "npa",
};
// Sort keywords by length descending — longer (more specific) keywords match first
const SORTED_CATEGORY_ENTRIES = Object.entries(CATEGORY_KEYWORDS)
  .sort((a, b) => b[0].length - a[0].length);

export function detectCategory(tags: string[], filename?: string): string {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    for (const [keyword, category] of SORTED_CATEGORY_ENTRIES) {
      if (lower.includes(keyword)) return category;
    }
  }
  if (filename) {
    const lower = filename.toLowerCase();
    for (const [keyword, category] of SORTED_CATEGORY_ENTRIES) {
      if (lower.includes(keyword)) return category;
    }
  }
  return "standards";
}
export function getCategoryLabel(key: string | null | undefined): string {
  const normalized = normalizeFolderPath(key);
  return DOCUMENT_CATEGORIES.find((c) => c.key === normalized)?.label || "Стандарты и Положения";
}
// autoTag() has been moved to backend/src/lib/tagging.ts — it requires Google AI SDK
