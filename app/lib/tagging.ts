import { google, withGoogleApiLimit } from "@/app/lib/google-ai";
import { generateText } from "ai";

/* ── Document Categories ── */

export const DOCUMENT_CATEGORIES = [
  { key: "standards", label: "Стандарты и Положения", icon: "verified" },
  { key: "forms", label: "Формы документов", icon: "article" },
  { key: "npa", label: "НПА", icon: "gavel" },
  { key: "schemas", label: "Схемы и Алгоритмы", icon: "schema" },
  { key: "other", label: "Прочее", icon: "folder" },
] as const;

const CATEGORY_KEYWORDS: Record<string, string> = {
  "стандарт": "standards",
  "положение": "standards",
  "регламент": "standards",
  "методика": "standards",
  "инструкция": "standards",
  "руководство": "standards",
  "порядок": "standards",
  "правила": "standards",
  "форма": "forms",
  "шаблон": "forms",
  "бланк": "forms",
  "образец": "forms",
  "анкета": "forms",
  "заявка": "forms",
  "приказ": "npa",
  "закон": "npa",
  "постановление": "npa",
  "распоряжение": "npa",
  "указ": "npa",
  "федеральный": "npa",
  "кодекс": "npa",
  "схема": "schemas",
  "алгоритм": "schemas",
  "диаграмма": "schemas",
  "блок-схема": "schemas",
  "маршрут": "schemas",
  "процесс": "schemas",
};

export function detectCategory(tags: string[], filename?: string): string {
  // Check tags first
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) return category;
    }
  }
  // Check filename
  if (filename) {
    const lower = filename.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
      if (lower.includes(keyword)) return category;
    }
  }
  return "other";
}

export function getCategoryLabel(key: string): string {
  return DOCUMENT_CATEGORIES.find((c) => c.key === key)?.label || "Прочее";
}

export async function autoTag(markdown: string, filename?: string): Promise<string[]> {
  const preview = markdown.slice(0, 5000);

  try {
    const { text } = await withGoogleApiLimit(() => generateText({
      model: google("gemini-3-flash-preview"),
      prompt: `Ты — эксперт по классификации корпоративных документов в области закупок и снабжения.

Проанализируй текст документа и сгенерируй ровно 10-12 тегов (на русском языке).
${filename ? `\nИмя файла: "${filename}"` : ""}

СТРУКТУРА ТЕГОВ (все категории обязательны):

1. ВИД ДОКУМЕНТА (1-2 тега) — определи тип по содержанию и названию файла:
   стандарт, регламент, методика, инструкция, положение, спецификация, техническое задание, договор, приказ, протокол, акт, реестр, форма, шаблон и т.д.

2. ТЕМАТИЧЕСКАЯ ОБЛАСТЬ (2-3 тега) — общая сфера:
   планирование закупок, управление поставщиками, тендерные процедуры, договорная работа, складская логистика, входной контроль, бюджетирование и т.д.

3. КОНКРЕТНОЕ СОДЕРЖАНИЕ (4-5 тегов) — специфика именно этого документа:
   что конкретно описано, какие процессы, этапы, объекты, критерии, формулы, процедуры

4. КЛЮЧЕВЫЕ ОБЪЕКТЫ (2-3 тега) — упомянутые сущности:
   оборудование, материалы, услуги, подразделения, роли, системы

ПРАВИЛА:
- Каждый тег — 1-3 слова
- Теги должны помогать НАЙТИ этот документ среди сотен других
- Первым тегом ВСЕГДА ставь вид документа (стандарт, регламент, методика и т.д.)
- НЕ дублируй смысл в разных тегах

Верни ТОЛЬКО JSON-массив строк, без пояснений.

Текст документа:
${preview}`,
    }));

    const cleaned = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string").slice(0, 15);
    }
  } catch (err) {
    console.error("autoTag error:", err);
  }
  return ["документ"];
}
