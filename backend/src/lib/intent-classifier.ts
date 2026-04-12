import { GoogleGenAI } from "@google/genai";
import { withGoogleApiLimit } from "./google-ai.js";

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

/* ── Intent types ── */

export type QueryIntent =
  | "entity_lookup"  // Поиск информации об организации/компании группы СГК
  | "procedure"     // Как провести закупку, порядок, этапы
  | "regulation"    // Что говорит закон, нормативные требования
  | "pricing"       // НМЦД, сметы, ценообразование
  | "authority"     // Кто согласовывает/утверждает, матрица полномочий
  | "system"        // SRM, SAP, B2B, ИАИС
  | "contract"      // Договоры, претензии, гарантии
  | "general";      // Прочие закупочные вопросы

export type FzType = "223" | "non-223" | "both" | "unknown";

export type SpuSubIntent =
  | "find_by_work"      // Подбор контрагентов по виду работ/услуг
  | "company_info"      // Информация о конкретном контрагенте
  | "check_participant" // Проверка участника в реестре СПУ
  | "contacts"          // Контакты контрагента
  | "compare";          // Сравнение контрагентов

export interface IntentResult {
  intent: QueryIntent;
  fz_type: FzType;
  search_tags: string[];
  query_variants: string[];
  confidence: number;
  spu_sub_intent?: SpuSubIntent;
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
- "entity_lookup" — спрашивает о конкретной организации/компании группы СГК (режим закупки, структура, принадлежность, по какому ФЗ работает). Также вопросы о подрядчиках/поставщиках/исполнителях
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

Правила для search_tags (2-5 штук, на русском, СТРОГО в нижнем регистре):
- Включай релевантные теги: "223-фз", "вне 223-фз", "ценообразование", "матрица полномочий", "смр", "пир", "реестр", "договоры", "инструкции", "единственный источник", "рамочный договор", "аварийная закупка"
- Для entity_lookup добавляй теги, релевантные вопросу об организации (например, "223-фз" или "вне 223-фз" если спрашивают о режиме)
- Для pricing всегда добавляй "ценообразование"
- При упоминании конкретных систем добавляй их аббревиатуру
- Если пользователь спрашивает о конкретной компании/организации группы СГК — это entity_lookup

Правила для query_variants (1-3 штуки):
- Переформулируй запрос для улучшения поиска
- Используй синонимы и смежные термины
- Не дублируй оригинальный запрос

Верни ТОЛЬКО валидный JSON. Без комментариев, без markdown.`;
/* ── Post-LLM keyword override ── */
// Strong signals that the query is about a specific company/contractor.
// These override the LLM result when it misclassifies as "general".
export const COMPANY_PATTERNS = [
  // Legal entity abbreviations followed by a name
  /(?:^|\s)(?:ооо|ао|зао|пао|ип|нпо|гк|ук|тк|нпп|гуп|муп|фгуп)\s+[«"а-яё]/i,
  // "расскажи / информация / сведения / данные / опиши" + "компания / организация / фирма"
  /расскаж.*(компани|организаци|фирм)|информаци.+о\s+(компани|организаци|фирм)|сведени.+о\s+(компани|организаци|фирм)|данные.+о\s+(компани|организаци|фирм)|опиши.*(компани|организаци|фирм)/i,
  // "что знаешь/известно про X компанию" or "чем занимается"
  /что (ты )?(знаешь|известно) про|чем занимается/i,
  // Direct contractor/supplier mention
  /подрядчик|контрагент|поставщик|исполнител/i,
  // "найти / подбери компанию"
  /найти.*(компани|организаци|фирм)|подбери.*(компани|организаци|фирм)/i,
  // INN lookup
  /инн\s+\d{10}/i,
];

function applyCompanyOverride(query: string, result: IntentResult): void {
  if (result.intent === "entity_lookup") return; // already correct
  const lower = query.toLowerCase();
  if (COMPANY_PATTERNS.some((p) => p.test(lower))) {
    console.log(`classifyIntent: override ${result.intent} → entity_lookup (keyword pattern matched)`);
    result.intent = "entity_lookup";
  }
}

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
      "entity_lookup", "procedure", "regulation", "pricing",
      "authority", "system", "contract", "general",
    ];
    if (!validIntents.includes(parsed.intent)) parsed.intent = "general";

    const validFz: FzType[] = ["223", "non-223", "both", "unknown"];
    if (!validFz.includes(parsed.fz_type)) parsed.fz_type = "unknown";

    if (!Array.isArray(parsed.search_tags)) parsed.search_tags = [];
    // Normalize tags to lowercase for consistent matching
    parsed.search_tags = parsed.search_tags.map((t) => t.toLowerCase());
    if (!Array.isArray(parsed.query_variants)) parsed.query_variants = [query];
    if (typeof parsed.confidence !== "number") parsed.confidence = 0.5;

    // Post-LLM correction: force entity_lookup when query clearly mentions a company
    applyCompanyOverride(query, parsed);

    // Sub-classify entity_lookup into SPU sub-intents
    if (parsed.intent === "entity_lookup") {
      parsed.spu_sub_intent = classifySpuSubIntent(query);
      if (!parsed.search_tags.includes("карточка контрагента")) {
        parsed.search_tags.push("карточка контрагента");
      }
    }

    console.log("classifyIntent:", JSON.stringify({
      intent: parsed.intent,
      fz_type: parsed.fz_type,
      tags: parsed.search_tags,
      confidence: parsed.confidence,
      spu_sub_intent: parsed.spu_sub_intent,
    }));

    return parsed;
  } catch (err) {
    console.error("Intent classification failed, using keyword fallback:", err);
    return fallbackClassify(query);
  }
}
/* ── SPU sub-intent classifier (zero latency, regex) ── */

export function classifySpuSubIntent(query: string): SpuSubIntent {
  const q = query.toLowerCase();

  // Contacts
  if (/контакт|телефон|номер|email|e-mail|почт[аыу]|адрес|позвонить|написать|связаться/i.test(q)) return "contacts";

  // Compare
  if (/сравни|сопостав|отличи[яе]|разниц[аыу]|vs\.?|против\s|лучше\s.*или/i.test(q)) return "compare";

  // Check participant
  if (/провер[ьи]|есть ли .*(базе|реестре|системе)|числится|зарегистрирован|участвует|работал[аи]? (с нами|у нас|в сгк)|статус.*(компани|контрагент|поставщик)|допущен/i.test(q)) return "check_participant";

  // Company info (specific entity mentioned)
  const hasLegalEntity = /(?:^|\s)(?:ооо|ао|зао|пао|ип|нпо|гк|ук|тк|нпп|гуп|муп|фгуп)\s+[«"а-яё]/i.test(q);
  const asksAboutCompany = /расскаж.*(компани|организаци|фирм)|что (ты )?(знаешь|известно) про|чем занимается|информаци.+о\s+(компани|организаци)|инн\s+\d{10}/i.test(q);
  if (hasLegalEntity || asksAboutCompany) return "company_info";

  // Default: find by work type
  return "find_by_work";
}

/* ── Keyword-based fallback (zero latency) ── */

function fallbackClassify(query: string): IntentResult {
  const lower = query.toLowerCase();
  let intent: QueryIntent = "general";
  let fz_type: FzType = "unknown";
  const search_tags: string[] = [];

  // Intent detection
  if (/подрядчик|контрагент|поставщик|исполнител|кто (делает|выполня|оказыва)|найти.*(компани|организаци)|подбери.*(компани|организаци|фирм)/i.test(lower)) {
    intent = "entity_lookup";
  } else if (/что (ты )?(знаешь|известно) про.*(компани|организаци|фирм|ооо|ао |зао|пао)|чем занимается.*(компани|организаци|ооо|ао |зао|пао)|инн\s+\d{10}/i.test(lower)) {
    intent = "entity_lookup";
  } else if (/расскаж.*(компани|организаци|фирм)|информаци.+о\s+(компани|организаци|фирм)|сведени.+о\s+(компани|организаци|фирм)|данные.+о\s+(компани|организаци|фирм)|опиши.*(компани|организаци|фирм)/i.test(lower)) {
    intent = "entity_lookup";
  } else if (/(?:^|\s)(?:ооо|ао|зао|пао|ип|нпо|гк|ук|тк|нпп|гуп|муп|фгуп)\s+[«"а-яё]/i.test(lower)) {
    intent = "entity_lookup";
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

  // FZ type detection (lowercase tags to match stored data)
  if (/223[\-\s]*фз/i.test(lower) && !/вне\s+223|не\s+по\s+223/i.test(lower)) {
    fz_type = "223";
    search_tags.push("223-фз");
  } else if (/вне\s+223|не\s+по\s+223|без\s+223/i.test(lower)) {
    fz_type = "non-223";
    search_tags.push("вне 223-фз");
  }

  const result: IntentResult = {
    intent,
    fz_type,
    search_tags,
    query_variants: [query],
    confidence: 0.3,
  };

  if (intent === "entity_lookup") {
    result.spu_sub_intent = classifySpuSubIntent(query);
    if (!result.search_tags.includes("карточка контрагента")) {
      result.search_tags.push("карточка контрагента");
    }
  }

  return result;
}
