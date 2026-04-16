/**
 * LLM-классификатор нецелевых запросов.
 * Портирован из sgc-legal-ai/backend/app/services/off_topic_classifier.py
 * для тематики закупок/снабжения. Использует Gemini Flash.
 *
 * Работает "тихо" — не блокирует запросы, только логирует для администратора.
 */
import { google, withGoogleApiLimit } from "./google-ai";
import { generateText } from "ai";

export type OffTopicCategory =
  | "procurement"
  | "household"
  | "family_personal"
  | "food_cooking"
  | "health_beauty"
  | "esoteric"
  | "psychology"
  | "travel"
  | "shopping"
  | "entertainment"
  | "tech_personal"
  | "nature_weather"
  | "personal_finance"
  | "education_hobby"
  | "gambling"
  | "pets"
  | "politics"
  | "military"
  | "other_off_topic";

export const CATEGORY_LABELS: Record<OffTopicCategory, string> = {
  procurement: "Закупки и снабжение",
  household: "Быт и дом",
  family_personal: "Семья и отношения",
  food_cooking: "Еда и кулинария",
  health_beauty: "Здоровье и красота",
  esoteric: "Эзотерика и гороскопы",
  psychology: "Психология",
  travel: "Путешествия",
  shopping: "Покупки и товары",
  entertainment: "Развлечения",
  tech_personal: "Личные технологии",
  nature_weather: "Природа и погода",
  personal_finance: "Личные финансы",
  education_hobby: "Образование и хобби",
  gambling: "Азартные игры",
  pets: "Домашние питомцы",
  politics: "Политика",
  military: "Войны и военное дело",
  other_off_topic: "Прочее нецелевое",
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as OffTopicCategory[];

const CLASSIFIER_PROMPT = `You are a query classifier for a corporate procurement assistant.
Your task: determine if a user query is ON-TOPIC (procurement/supply related) or OFF-TOPIC (personal/household).

ON-TOPIC queries (respond with: procurement):
- Procurement, tenders, auctions, quotations
- Supply chain, deliveries, logistics, warehouse
- Contracts, specifications, agreements
- Regulations, standards, normative documents
- Pricing, estimates, procurement budgets, НМЦК, НМЦЖ, НМЦ (начальная максимальная цена контракта/жизненного цикла)
- Materials, goods acceptance, claims
- Supplier qualification, counterparties
- Russian procurement laws (44-FZ, 223-FZ)
- Preparing procurement documentation
- Editing, improving, rephrasing work texts
- Meta-questions about the system: what documents are loaded, what the assistant can do, asking for help
- Requests to prepare/compose/draft any work document (ТЗ, письмо, таблица, отчёт, etc.)
- Procurement abbreviations: НМЦК, НМЦЖ, НМЦ, ОКПД, ЕП, ТРУ, ТЗ, КП, ОЗ, НДС, ФАС, ЕИС, ЭТП, РНП, ОТР, СМР, ПИР
- Responsibility assignment, organizational structure related to procurement processes
- Any query mentioning work/service pricing, cost estimation, contract formation
- Document templates (шаблон), forms (бланк, образец), reports (отчёт, сводка, ведомость)
- Cost summaries, cost calculations, expenditure breakdowns for works and services (затраты, расценки, калькуляция)
- Acts (акт выполненных работ, акт сверки, КС-2, КС-3), defect statements, estimates (сметы)
- Any mention of "работы" (works) and "услуги" (services) in business/procurement context
- Registers, certificates, extracts, protocols, memos (реестр, справка, выписка, протокол, записка)

OFF-TOPIC categories:
- household — home repair, cleaning, interior design, dacha
- family_personal — relationships, dating, weddings, parenting
- food_cooking — recipes, restaurants, diets, drinks, beer, wine, alcohol
- health_beauty — symptoms, medicine, cosmetics, fitness, weight loss
- esoteric — horoscopes, astrology, tarot, magic
- psychology — personal growth, motivation, anxiety
- travel — tours, hotels, tickets, resorts, hiking, camping
- shopping — electronics, clothes, cars, furniture, discounts
- entertainment — movies, series, games, music, books, memes, jokes
- tech_personal — phone setup, social media, personal apps
- nature_weather — weather, forecasts, plants, wildlife
- personal_finance — personal investments, crypto, personal budget
- education_hobby — language learning, crafts, self-development courses
- gambling — betting, casino, lottery
- pets — pet care, veterinary, pet food, breeds
- politics — politics, elections, parties, geopolitics
- military — wars, military, weapons, army
- other_off_topic — any other personal questions

RULES:
- If the query is about PROCUREMENT (even in personal context) → procurement
- Text editing/improvement requests → procurement (work tasks)
- When in doubt → procurement (better not to block a work query)
- Russian procurement abbreviations (НМЦК, НМЦЖ, НМЦ, ОКПД, ЕИС, ЭТП, РНП, ФАС, СМР, ПИР, ТРУ) → ALWAYS procurement
- Queries about responsibility, assignment, or organizational roles related to pricing, contracts, works, or services → procurement
- Do NOT confuse professional/work queries with personal topics
- Questions about the system itself (what documents are loaded, capabilities) → procurement
- Requests to prepare/draft/compose any document → procurement
- NEVER classify business terms like "затраты" (expenses), "расходы" (costs), "сводка" (summary), "калькуляция" (calculation), "расценки" (rates) as food_cooking — these are procurement/financial terms, NOT cooking
- Queries about "работы" (works) and "услуги" (services) with cost/expense context → ALWAYS procurement

You MUST respond with EXACTLY ONE word from the list above. Nothing else. No explanations.`;

const MAX_HISTORY = 4;

export interface ClassifyResult {
  isOffTopic: boolean;
  category: OffTopicCategory;
}

/**
 * Keyword-based fallback classifier.
 * Used when LLM returns empty/invalid response (e.g. safety filter).
 */
function keywordClassify(text: string): OffTopicCategory {
  const lower = text.toLowerCase();

  // Procurement keywords — check first
  const procurementPatterns = [
    /закупк/i, /тендер/i, /аукцион/i, /котировк/i, /поставк/i, /снабжен/i,
    /логистик/i, /склад/i, /договор/i, /контракт/i, /специфик/i, /регламент/i,
    /норматив/i, /стандарт/i, /ценообраз/i, /смет/i, /бюджет/i, /мтр/i, /тмц/i,
    /приёмк/i, /приемк/i, /рекламаци/i, /поставщик/i, /контрагент/i,
    /44.?фз/i, /223.?фз/i, /закон.*закупк/i, /документаци/i,
    /переформулир/i, /перефразир/i, /улучш.*текст/i, /редактир/i,
    /подготов/i,
    /коммерческ.*предлож/i, /техническ.*задан/i, /(?<![а-яёА-ЯЁ])тз(?![а-яёА-ЯЁ])/i,
    /нмцк/i, /нмцж/i, /(?<![а-яёА-ЯЁ])нмц(?![а-яёА-ЯЁ])/i, /начальн.*максимальн.*цен/i,
    /окпд/i, /(?<![а-яёА-ЯЁ])еис(?![а-яёА-ЯЁ])/i, /(?<![а-яёА-ЯЁ])этп(?![а-яёА-ЯЁ])/i,
    /(?<![а-яёА-ЯЁ])рнп(?![а-яёА-ЯЁ])/i, /(?<![а-яёА-ЯЁ])фас(?![а-яёА-ЯЁ])/i,
    /(?<![а-яёА-ЯЁ])смр(?![а-яёА-ЯЁ])/i, /(?<![а-яёА-ЯЁ])пир(?![а-яёА-ЯЁ])/i,
    /(?<![а-яёА-ЯЁ])отр(?![а-яёА-ЯЁ])/i, /(?<![а-яёА-ЯЁ])тру(?![а-яёА-ЯЁ])/i,
    /единствен.*поставщик/i, /конкурс/i, /лот[аеуы]/i,
    /обеспечен.*заявк/i, /обеспечен.*контракт/i, /обеспечен.*исполнен/i,
    /субподряд/i, /генподряд/i, /подрядчик/i, /исполнител/i,
    /заказчик/i, /извещен.*закупк/i, /протокол.*закупк/i,
    /формирован.*цен/i, /обоснован.*цен/i, /расчёт.*цен/i, /расчет.*цен/i,
    // Document templates, forms, reports — work document requests
    /шаблон/i, /образец/i, /бланк/i, /форм[аеуы].*документ/i,
    /сводк/i, /ведомост/i, /калькуляц/i, /расценк/i,
    /затрат.*работ/i, /затрат.*услуг/i, /работ.*услуг/i,
    /акт.*выполнен/i, /акт.*приёмк/i, /акт.*приемк/i, /акт.*сверк/i,
    /(?<![а-яёА-ЯЁ])кс-2(?![а-яёА-ЯЁ])/i, /(?<![а-яёА-ЯЁ])кс-3(?![а-яёА-ЯЁ])/i,
    /дефектн.*ведомост/i, /дефектн.*акт/i, /сметн/i,
    /объём.*работ/i, /объем.*работ/i, /перечень.*работ/i, /перечень.*услуг/i,
    /стоимост.*работ/i, /стоимост.*услуг/i, /стоимост.*ремонт/i,
    /расход.*работ/i, /расход.*подряд/i, /расход.*услуг/i, /расход.*ремонт/i,
    /подрядн/i, /сводн.*таблиц/i, /сводн.*затрат/i, /сводн.*расход/i,
    /ремонтн.*работ/i, /работ.*ремонт/i, /стоят.*работ/i,
    /(?<![а-яёА-ЯЁ])гпд(?![а-яёА-ЯЁ])/i, /гражданско.*правов/i,
    /реестр/i, /справк/i, /выписк/i, /протокол/i, /заключен/i,
    /отчёт/i, /отчет/i, /служебн.*записк/i, /пояснительн.*записк/i,
    // Meta-queries about the system itself (what documents are loaded, capabilities, etc.)
    /документ.*загружен/i, /загружен.*документ/i, /какие.*документ/i,
    /что ты (умеешь|можешь|знаешь)/i, /что.*загружен/i, /какие.*файл/i,
    /база знаний/i, /помоги.*разобрат/i, /помоги.*найти/i, /помоги.*сделат/i,
    /составь/i, /сформируй/i, /напиши.*письм/i, /сделай.*таблиц/i,
  ];
  for (const p of procurementPatterns) {
    if (p.test(lower)) return "procurement";
  }

  // Off-topic keyword patterns
  const offTopicMap: [RegExp, OffTopicCategory][] = [
    [/пиво|вино|водк|коктейл|рецепт|(?<![а-яёА-ЯЁ])готов[иь]|кулинар|ресторан|кафе|диет|калори/i, "food_cooking"],
    [/погод|прогноз.*температур|дожд|снег.*завтра|климат/i, "nature_weather"],
    [/гороскоп|астролог|таро|гадан|магия|сонник|знак.*зодиак/i, "esoteric"],
    [/фильм|сериал|кино|музык|песн|книг[уаи]|игр[уаы]|мем|анекдот/i, "entertainment"],
    [/жен[аеуы]|муж[а-я]*|свидан|свадьб|развод|отношен|девушк|парен/i, "family_personal"],
    [/ремонт.*квартир|уборк|дач[аеу]|интерьер|обои|плитк/i, "household"],
    [/здоров|болезн|лекарств|таблетк|симптом|врач|больниц|похуде|фитнес|косметик/i, "health_beauty"],
    [/психолог|тревожн|мотивац|депресси|самооценк/i, "psychology"],
    [/тур[аы]|отель|билет.*самол|курорт|путешеств|поход|кемпинг|отпуск/i, "travel"],
    [/купить.*iphone|купить.*телефон|скидк|распродаж|магазин.*одежд|автомобил/i, "shopping"],
    [/настро.*телефон|соцсет|instagram|tiktok|telegram.*личн/i, "tech_personal"],
    [/инвестиц.*личн|криптовалют|биткоин|личный.*бюджет/i, "personal_finance"],
    [/изуч.*язык|рукодел|курс.*саморазвит|хобби/i, "education_hobby"],
    [/ставк|казино|лотере|букмекер/i, "gambling"],
    [/собак|кошк|котён|щенок|питомец|ветеринар|корм.*животн/i, "pets"],
    [/политик|выбор.*президент|партия|геополитик/i, "politics"],
    [/войн[аеуы]|военн|оружи|армия|танк[аи]/i, "military"],
  ];

  for (const [pattern, category] of offTopicMap) {
    if (pattern.test(lower)) return category;
  }

  // If no keywords matched, default to procurement (don't block)
  return "procurement";
}

/**
 * Detects gibberish / meaningless random text input.
 *
 * Algorithm: checks "words" of 5+ lowercase letters for vowel density.
 * Real Russian/English words always contain some vowels; random character
 * strings typically have none. Uppercase-heavy tokens are skipped because
 * they are likely abbreviations (НМЦК, ТРУ, СМР, …).
 *
 * Returns true when the text looks like a meaningless random keystroke sequence.
 */
export function detectGibberish(text: string): boolean {
  if (!text || text.trim().length === 0) return false;

  const allLetters = text.match(/[а-яёА-ЯЁa-zA-Z]/g) ?? [];
  if (allLetters.length < 6) return false; // too short to judge reliably

  const ruVowel = /[аеёийоуыэюяАЕЁИЙОУЫЭЮЯ]/;
  const enVowel = /[aeiouAEIOU]/;

  const words = text.split(/[\s\-_.,!?;:()\[\]{}<>]+/);
  let checkable = 0;
  let gibberish = 0;

  for (const word of words) {
    const letters = word.match(/[а-яёА-ЯЁa-zA-Z]/g) ?? [];
    if (letters.length < 5) continue; // skip short tokens / abbreviations

    // Skip mostly-uppercase tokens (abbreviations like НМЦК, ОКПД2, ЭТП)
    const upperCount = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
    if (upperCount / letters.length > 0.6) continue;

    checkable++;
    const vowels = letters.filter((c) => ruVowel.test(c) || enVowel.test(c)).length;
    if (vowels / letters.length < 0.10) gibberish++;
  }

  return checkable > 0 && gibberish / checkable > 0.5;
}

/* ═══════════════════════════════════════════════════════════════════════════
   VAGUE QUERY DETECTION
   Blocking pre-RAG check. Returns true when the query is too general to
   answer without clarification (e.g. "как провести закупку?", "аукцион").
   ═══════════════════════════════════════════════════════════════════════════ */

export interface VagueQueryResult {
  isVague: boolean;
  /** Internal classification path for logging */
  detectedBy: "heuristic_specific" | "heuristic_vague" | "llm" | "llm_error";
}

/** Single-word procurement concepts that alone are too vague to answer */
const VAGUE_SINGLE_TERMS = new Set([
  "аукцион", "конкурс", "котировка", "котировки", "тендер", "закупка",
  "переторжка", "запрос", "лот", "нмц", "нмцк", "нмцд", "нмцж",
  "зц", "зп", "тз", "ти", "ктп", "еи", "ру",
  "сроки", "срок", "порог", "порядок", "процедура", "регламент",
  "способ", "способы", "этапы", "этап",
]);

/** Ultra-generic question patterns (without any qualifying detail) */
const VAGUE_TEMPLATE_PATTERNS = [
  /^как\s+провести\s+закупку\??$/i,
  /^как\s+организовать\s+закупку\??$/i,
  /^какие\s+сроки\??$/i,
  /^что\s+такое\s+[а-яёА-ЯЁ]{2,15}\??$/i,
  /^расскажи\s+про\s+[а-яёА-ЯЁ\s\-]{2,30}\??$/i,
  /^(?:опиши|объясни)\s+[а-яёА-ЯЁ\s\-]{2,30}\??$/i,
];

/**
 * Heuristic: returns true when the query already contains enough specificity —
 * the query is definitely NOT vague and no LLM call is needed.
 */
function heuristicIsSpecific(text: string): boolean {
  // Contains any digit → amount, section number, article, threshold
  if (/\d/.test(text)) return true;

  // Explicit FZ regime
  if (/223.?фз|вне\s+223|не\s+по\s+223|по\s+223/i.test(text)) return true;

  // Legal entity form (company named)
  if (/(?:ао|ооо|зао|пао)\s+[«"а-яё]/i.test(text)) return true;

  // Specific multi-word procedure name
  if (/(?:запрос\s+котировок|запрос\s+предложений|единственн\w+\s+(?:источник|поставщик|исполнитель))/i.test(text)) return true;

  // Section/article/clause reference
  if (/(?:пункт|п\.\s*\d|раздел|статья|ст\.\s*\d)/i.test(text)) return true;

  // Back-reference (follow-up question with pronoun — context from prior turns)
  if (/\b(?:это|такой|такая|такое|такие|тот\s+же|та\s+же|те\s+же|тем\s+же|этот|эта|эти)\b/i.test(text) && text.length < 80) return true;

  // Long queries are almost always specific enough
  if (text.trim().length > 120) return true;

  return false;
}

const VAGUE_CLASSIFIER_PROMPT = `You are a query quality classifier for a corporate procurement AI assistant (Russia, СГК group).
Your task: decide if a user query is TOO VAGUE to answer without clarification.

A query is VAGUE if it:
- Asks about a procurement concept without specifying: which legal regime (223-FZ for АО entities / non-223-FZ for ООО entities), which entity/company, which stage, or which amount range
- Is a single bare term with no context: "аукцион", "сроки", "НМЦ", "ЗЦ", "переторжка"
- Uses a template question with no specifics: "как провести закупку?", "какие сроки?", "расскажи про запрос котировок"
- Could apply to dozens of different documents or procedures (requires scanning everything to guess intent)

A query is SPECIFIC if it mentions ANY of:
- A legal regime: "по 223-ФЗ", "вне 223-ФЗ", "для АО", "для ООО СГК"
- A named entity or business unit
- A numeric threshold or amount (рублей, млн, тыс.)
- A specific procedure stage: "срок рассмотрения заявок", "обеспечение исполнения контракта", "этап согласования"
- A specific document, section, or clause reference
- A concrete action on a named object: "какой порог для простой закупки для ООО СГК"

RULES:
- When in doubt → SPECIFIC (never block a legitimate work query)
- Abbreviations like НМЦК, НМЦЖ, ЗЦ, ЗП, ЕИ alone → VAGUE (need context to answer)
- Same abbreviation with a qualifier ("срок согласования НМЦК по 223-ФЗ") → SPECIFIC
- Questions about the system itself ("что ты умеешь", "какие документы загружены") → SPECIFIC

Respond with EXACTLY one word: VAGUE or SPECIFIC`;

/**
 * Classifies whether a procurement query is too vague to answer without clarification.
 *
 * Uses a three-layer approach:
 *   A. Fast heuristics "definitely specific" → skip immediately (0ms, no API)
 *   B. Fast heuristics "definitely vague" → block immediately (0ms, no API)
 *   C. Gemini Flash Lite LLM → for ambiguous middle-ground cases
 *
 * Designed as a BLOCKING check before the RAG pipeline.
 * Fails open on any error (returns isVague: false) — never blocks a real query.
 */
export async function detectVagueQuery(text: string): Promise<VagueQueryResult> {
  const trimmed = text.trim();

  // ── Layer A: Heuristic "definitely specific" bypass ──
  if (heuristicIsSpecific(trimmed)) {
    return { isVague: false, detectedBy: "heuristic_specific" };
  }

  // ── Layer B: Heuristic "definitely vague" fast path ──
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  // Single known-vague term (possibly with trailing punctuation)
  if (words.length === 1) {
    const bare = words[0].replace(/[^а-яёa-z]/gi, "");
    if (VAGUE_SINGLE_TERMS.has(bare)) {
      return { isVague: true, detectedBy: "heuristic_vague" };
    }
  }
  // Matches a known ultra-generic question template
  if (VAGUE_TEMPLATE_PATTERNS.some((p) => p.test(trimmed))) {
    return { isVague: true, detectedBy: "heuristic_vague" };
  }

  // ── Layer C: LLM judgment for ambiguous middle-ground ──
  try {
    const { text: llmText } = await withGoogleApiLimit(() =>
      generateText({
        model: google("gemini-3.1-flash-lite-preview"),
        system: VAGUE_CLASSIFIER_PROMPT,
        prompt: trimmed,
        maxOutputTokens: 5,
        temperature: 0,
      })
    );

    const response = llmText.trim().toUpperCase();
    console.log(`[VagueQuery] Query: "${trimmed.slice(0, 80)}" → LLM: "${response}"`);
    const isVague = response.includes("VAGUE");
    return { isVague, detectedBy: "llm" };
  } catch (e) {
    console.error("[VagueQuery] LLM classification failed (failing open):", e);
    return { isVague: false, detectedBy: "llm_error" };
  }
}

export async function classifyOffTopic(
  userMessage: string,
  conversationHistory?: { role: string; content: string }[]
): Promise<ClassifyResult> {
  // Короткие сообщения — считаем целевыми
  if (!userMessage || userMessage.trim().length < 10) {
    return { isOffTopic: false, category: "procurement" };
  }

  // Быстрая проверка ключевыми словами ДО LLM — если очевидно закупочный, не тратим время
  const keywordPreCheck = keywordClassify(userMessage);
  if (keywordPreCheck === "procurement") {
    console.log(`[OffTopic] Keyword pre-check: procurement → skipping LLM`);
    return { isOffTopic: false, category: "procurement" };
  }

  let userPrompt: string;
  if (conversationHistory && conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-MAX_HISTORY);
    const historyLines = recent.map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const content = m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content;
      return `${role}: ${content}`;
    });
    userPrompt =
      `Conversation context:\n${historyLines.join("\n")}\n\n` +
      `New user query: ${userMessage}`;
  } else {
    userPrompt = `Classify this query: ${userMessage}`;
  }

  try {
    const { text } = await withGoogleApiLimit(() => generateText({
      model: google("gemini-3.1-flash-lite-preview"),
      system: CLASSIFIER_PROMPT,
      prompt: userPrompt,
      maxOutputTokens: 20,
      temperature: 0,
    }));

    const result = text.trim().toLowerCase().replace(/[^a-z_]/g, "");
    console.log(`[OffTopic] Query: "${userMessage.slice(0, 80)}" → LLM raw: "${text.trim()}", parsed: "${result}"`);

    // Check if LLM returned a valid category
    if (result) {
      for (const category of ALL_CATEGORIES) {
        if (result.includes(category)) {
          const isOffTopic = category !== "procurement";
          console.log(`[OffTopic] LLM classified as: ${category}, isOffTopic: ${isOffTopic}`);
          return { isOffTopic, category };
        }
      }
    }

    // LLM returned empty or unknown category — use keyword fallback
    console.warn(`[OffTopic] LLM returned invalid: "${text.trim()}", using keyword fallback`);
    const fallbackCategory = keywordClassify(userMessage);
    const isOffTopic = fallbackCategory !== "procurement";
    console.log(`[OffTopic] Keyword fallback: ${fallbackCategory}, isOffTopic: ${isOffTopic}`);
    return { isOffTopic, category: fallbackCategory };
  } catch (e) {
    console.error("[OffTopic] LLM classification failed:", e);
    // On error, use keyword fallback instead of defaulting to procurement
    const fallbackCategory = keywordClassify(userMessage);
    const isOffTopic = fallbackCategory !== "procurement";
    console.log(`[OffTopic] Error fallback (keywords): ${fallbackCategory}, isOffTopic: ${isOffTopic}`);
    return { isOffTopic, category: fallbackCategory };
  }
}
