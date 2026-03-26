import { GoogleGenAI } from "@google/genai";
import { withGoogleApiLimit } from "./google-ai";

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

/* ── Intent types ── */

export type QueryIntent =
  | "spu_search"    // Поиск подрядчиков/поставщиков
  | "procedure"     // Как провести закупку, порядок, этапы
  | "regulation"    // Что говорит закон, нормативные требования
  | "pricing"       // НМЦД, сметы, ценообразование
  | "authority"     // Кто согласовывает/утверждает, матрица полномочий
  | "system"        // SRM, SAP, B2B, ИАИС
  | "contract"      // Договоры, претензии, гарантии
  | "general";      // Прочие закупочные вопросы

export type FzType = "223" | "non-223" | "both" | "unknown";

export interface IntentResult {
  intent: QueryIntent;
  fz_type: FzType;
  search_tags: string[];
  query_variants: string[];
  confidence: number;
}
/* ── LLM classification prompt ── */

const CLASSIFY_PROMPT = `Ты — классификатор запросов для чат-бота Дирекции по закупкам СГК.

Проанализируй запрос пользователя и верни JSON (без markdown-обёрток):

{
  "intent": "<тип запроса>",
  "fz_type": "<режим закупки>",
  "search_tags": ["тег1", "тег2"],
  "query_variants": ["альтернативная формулировка 1"],
  "confidence": 0.0-1.0
}

Типы intent:
- "spu_search" — ищет подрядчиков, поставщиков, исполнителей для конкретных работ
- "procedure" — вопрос о порядке проведения закупки, этапах, процессе
- "regulation" — нормативные требования, что говорит закон/стандарт
- "pricing" — НМЦД, расценки, сметы, индексы, ФЕР, ГЭСН
- "authority" — кто согласовывает/утверждает, матрица полномочий, лимиты
- "system" — вопросы по IT-системам (SRM, SAP, B2B, ИАИС)
- "contract" — договорные условия, претензии, штрафы, гарантии
- "general" — прочие закупочные вопросы

Значения fz_type:
- "223" — запрос явно или контекстно относится к закупкам по 223-ФЗ
- "non-223" — запрос относится к закупкам вне 223-ФЗ
- "both" — сравнение двух режимов или вопрос применим к обоим
- "unknown" — режим не определяется из запроса

Правила для search_tags (2-5 штук, на русском, в нижнем регистре):
- Включай релевантные теги: "223-ФЗ", "вне 223-ФЗ", "ценообразование", "матрица полномочий", "СМР", "ПИР", "реестр", "договоры", "инструкции", "единственный источник", "рамочный договор", "аварийная закупка"
- Для spu_search всегда добавляй "реестр"
- Для pricing всегда добавляй "ценообразование"
- При упоминании конкретных систем добавляй их аббревиатуру

Правила для query_variants (1-3 штуки):
- Переформулируй запрос для улучшения поиска
- Используй синонимы и смежные термины
- Не дублируй оригинальный запрос

Верни ТОЛЬКО валидный JSON. Без комментариев, без markdown.`;
/* ── LLM-based classification ── */

export async function classifyIntent(query: string): Promise<IntentResult> {
  // Short queries bypass LLM
  if (query.length < 8) {
    return fallbackClassify(query);
  }

  try {
    const raw = await withGoogleApiLimit(async () => {
      const response = await client.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: `Запрос: "${query}"`,
        config: {
          systemInstruction: CLASSIFY_PROMPT,
          temperature: 0,
          maxOutputTokens: 400,
        },
      });
      return response.text ?? "";
    });

    const cleaned = raw.replace(/```json?\\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned) as IntentResult;

    // Validate and sanitize
    const validIntents: QueryIntent[] = [
      "spu_search", "procedure", "regulation", "pricing",
      "authority", "system", "contract", "general",
    ];
    if (!validIntents.includes(parsed.intent)) parsed.intent = "general";

    const validFz: FzType[] = ["223", "non-223", "both", "unknown"];
    if (!validFz.includes(parsed.fz_type)) parsed.fz_type = "unknown";

    if (!Array.isArray(parsed.search_tags)) parsed.search_tags = [];
    if (!Array.isArray(parsed.query_variants)) parsed.query_variants = [query];
    if (typeof parsed.confidence !== "number") parsed.confidence = 0.5;

    console.log("classifyIntent:", JSON.stringify({
      intent: parsed.intent,
      fz_type: parsed.fz_type,
      tags: parsed.search_tags,
      confidence: parsed.confidence,
    }));

    return parsed;
  } catch (err) {
    console.error("Intent classification failed, using keyword fallback:", err);
    return fallbackClassify(query);
  }
}
/* ── Keyword-based fallback (zero latency) ── */

function fallbackClassify(query: string): IntentResult {
  const lower = query.toLowerCase();
  let intent: QueryIntent = "general";
  let fz_type: FzType = "unknown";
  const search_tags: string[] = [];

  // Intent detection
  if (/подрядчик|контрагент|поставщик|исполнител|кто (делает|выполня|оказыва)|найти.*(компани|организаци)/i.test(lower)) {
    intent = "spu_search";
    search_tags.push("реестр");
  } else if (/как (провести|организовать|запустить|оформить)|порядок|процедур|этап|шаг|алгоритм/i.test(lower)) {
    intent = "procedure";
  } else if (/закон|статья|норм[аы]|требовани|обязательн|запрещ|допускается/i.test(lower)) {
    intent = "regulation";
    search_tags.push("законодательство");
  } else if (/цена|стоимост|нмцд|нмцк|смет|расценк|индекс|фер|гэсн/i.test(lower)) {
    intent = "pricing";
    search_tags.push("ценообразование");
  } else if (/кто (согласов|утвержда|подписыва|принимает)|полномочи|матрица|лимит.*(млн|руб)/i.test(lower)) {
    intent = "authority";
    search_tags.push("матрица полномочий");
  } else if (/\bsrm\b|\bsap\b|\bb2b\b|иаис|систем/i.test(lower)) {
    intent = "system";
  } else if (/договор|контракт|претенз|штраф|неустойк|гарант/i.test(lower)) {
    intent = "contract";
    search_tags.push("договоры");
  }

  // FZ type detection
  if (/223[\-\s]*фз/i.test(lower) && !/вне\s+223|не\s+по\s+223/i.test(lower)) {
    fz_type = "223";
    search_tags.push("223-ФЗ");
  } else if (/вне\s+223|не\s+по\s+223|без\s+223/i.test(lower)) {
    fz_type = "non-223";
    search_tags.push("вне 223-ФЗ");
  }

  return {
    intent,
    fz_type,
    search_tags,
    query_variants: [query],
    confidence: 0.3,
  };
}
