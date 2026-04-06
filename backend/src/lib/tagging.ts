import { google, withGoogleApiLimit } from "./google-ai.js";
import { generateText } from "ai";
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
export async function autoTag(markdown: string, filename?: string, folderPath?: string | null): Promise<string[]> {
  const preview = markdown.slice(0, 5000);
  try {
    const { text } = await withGoogleApiLimit(() => generateText({
      model: google("gemini-3.1-flash-lite-preview"),
      prompt: `Ты — классификатор документов RAG-базы знаний «СнабЧат» Дирекции по закупкам СГК (Сибирская генерирующая компания).
Проанализируй текст документа и сгенерируй массив из 12-18 тегов на русском языке.
${filename ? `\nИмя файла: "${filename}"` : ""}
${folderPath ? `\nРаздел базы знаний: "${folderPath}"` : ""}
СТРУКТУРА ТЕГОВ (все группы обязательны):
1. ТИП ДОКУМЕНТА (1 тег, ВСЕГДА первый) — одно из значений:
   стандарт, положение, приказ, инструкция, методика, форма, шаблон, схема,
   справочник, реестр, перечень, договор, федеральный закон, постановление правительства,
   индекс, памятка, презентация, служебная записка, протокол, техническое задание
2. КАТЕГОРИЯ ДОКУМЕНТА (1 тег, ВСЕГДА второй) — строго одно из 8 значений:
   стандарты и положения | формы и шаблоны | нпа | схемы процессов |
   инструкции и методики | ценообразование | справочники и реестры | договоры
   Правила определения категории:
   - НПА: только 223-ФЗ, постановления Правительства, федеральные законы
   - Стандарты и Положения: стандарты закупок, положения, приказы об утверждении, регламенты
   - Формы и Шаблоны: заполняемые формы, шаблоны ТЗ/ТЭ, бланки инициаций, СЗ, протоколы
   - Схемы процессов: блок-схемы, визуальные алгоритмы закупочных процедур
   - Инструкции и Методики: пошаговые инструкции (в т.ч. по ИС), методики оценки, обучение
   - Ценообразование: индексы пересчёта, стоимость чел-часа, коэффициенты, НМЦД, сметы
   - Справочники и Реестры: перечни, лимиты, сроки поставки, зоны ответственности, классификаторы
   - Договоры: контракты, ДС, агентские договоры, приложения к договорам
3. ОБЛАСТЬ РЕГУЛИРОВАНИЯ (1-3 тега):
   223-ФЗ | вне 223-ФЗ | СМР | ПИР | МТР | планирование закупок
4. ЭТАП ЗАКУПКИ (1-3 тега, если применимо):
   инициация | техническое задание | выбор способа | конкурс | оценка |
   переговоры | итоги | договор | ценообразование | контроль
5. ОРГАНИЗАЦИЯ (1-2 тега):
   СГК | СибЭР | СибЭМ | НАК Азот | ТГК-13 | Кузбассэнерго
6. ИНФОРМАЦИОННАЯ СИСТЕМА (только если документ описывает работу в ИС):
   SRM | B2B | ИАИС | SAP
7. СОДЕРЖАНИЕ (3-5 тегов) — специфика именно этого документа
8. РОДИТЕЛЬСКИЙ ДОКУМЕНТ (если документ является приложением):
   → Стандарт закупок по 223-ФЗ | → Стандарт закупок вне 223-ФЗ |
   → Стандарт планирования закупок | → Инструкция закупок СМР ПИР |
   → Положение о ЗК СибЭМ | определяй по скобкам в имени файла
ПРАВИЛА:
- Теги в нижнем регистре, 1-4 слова каждый
- Первый тег = тип документа, второй = категория (это критически важно для фильтрации)
- Включай сокращения: СЗ, ТЭ, ТЗ, ДС, ЗКО, ЕИ, НМЦД, ИЕР, ФЕР, МТР, СМР, ПИР
- НЕ дублируй смысл
Верни ТОЛЬКО JSON-массив строк.
Текст документа:
${preview}`,
    }));
    const cleaned = text.replace(/\`\`\`json?\s*/g, "").replace(/\`\`\`/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string").slice(0, 20);
    }
  } catch (err) {
    console.error("autoTag error:", err);
  }
  return ["документ"];
}
