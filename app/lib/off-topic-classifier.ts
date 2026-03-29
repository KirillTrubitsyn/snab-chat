/**
 * LLM-классификатор нецелевых запросов.
 * Портирован из sgc-legal-ai/backend/app/services/off_topic_classifier.py
 * для тематики закупок/снабжения. Использует Gemini Flash.
 *
 * Работает "тихо" — не блокирует запросы, только логирует для администратора.
 */
import { google } from "./google-ai";
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
    const { text } = await generateText({
      model: google("gemini-3-flash-preview"),
      system: CLASSIFIER_PROMPT,
      prompt: userPrompt,
      maxTokens: 20,
      temperature: 0,
    });

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
