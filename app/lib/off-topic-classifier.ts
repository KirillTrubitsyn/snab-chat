/**
 * LLM-классификатор нецелевых запросов.
 * Адаптация sgc-legal-ai/backend/app/services/off_topic_classifier.py
 * для тематики закупок/снабжения. Использует Gemini Flash.
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
const OFF_TOPIC_CATEGORIES = ALL_CATEGORIES.filter((c) => c !== "procurement");

const CLASSIFIER_PROMPT = `Ты — классификатор запросов для корпоративного ассистента Дирекции по закупкам и ресурсному обеспечению.
Определи категорию запроса.

ЦЕЛЕВЫЕ (procurement):
- Закупки, тендеры, конкурсы, аукционы, котировки
- Снабжение, поставки, логистика, склад
- Договоры, контракты, спецификации
- Нормативные документы, регламенты, стандарты
- Ценообразование, сметы, бюджеты закупок
- МТР, ТМЦ, приёмка товаров, рекламации
- Квалификация поставщиков, контрагенты
- 44-ФЗ, 223-ФЗ, закупочное законодательство
- Редактирование/улучшение рабочего текста

НЕЦЕЛЕВЫЕ:
- household — быт, ремонт, дача
- family_personal — отношения, свидания, дети
- food_cooking — рецепты, рестораны, еда, напитки, вино, пиво
- health_beauty — здоровье, лекарства, косметика, фитнес
- esoteric — гороскопы, гадания, магия
- psychology — личностный рост, мотивация
- travel — туры, отели, отпуск
- shopping — техника, одежда, авто, мебель
- entertainment — фильмы, игры, музыка, анекдоты
- tech_personal — телефон, соцсети, приложения
- nature_weather — погода, природа
- personal_finance — инвестиции, криптовалюта
- education_hobby — языки, хобби, курсы
- gambling — ставки, казино
- pets — питомцы, ветеринария
- politics — политика, выборы
- military — войны, армия, оружие
- other_off_topic — прочее нецелевое

ПРАВИЛА:
1. Если ОЧЕВИДНО не связано с работой/закупками — выбери нецелевую категорию
2. При сомнениях — procurement
3. Учитывай контекст разговора если он есть

Ответь СТРОГО одним словом — название категории. Примеры:
"какое пиво лучше" → food_cooking
"как подобрать цветы для девушки" → family_personal
"классное вино" → food_cooking
"какая погода" → nature_weather
"закупка труб" → procurement`;

const MAX_HISTORY = 4;

export interface ClassifyResult {
  isOffTopic: boolean;
  category: OffTopicCategory;
}

/**
 * Simple keyword-based fallback when LLM fails or returns empty.
 */
// NOTE: \b does NOT work with Cyrillic in JS regex (only ASCII \w).
// Use Unicode-aware lookaround for word boundaries with Cyrillic text.
const CYR_B = "(?<![а-яА-ЯёЁa-zA-Z0-9])"; // leading word boundary
const CYR_B_END = "(?![а-яА-ЯёЁa-zA-Z0-9])"; // trailing word boundary

const KEYWORD_RULES: [RegExp, OffTopicCategory][] = [
  [new RegExp(`${CYR_B}(пив[оа]|вин[оа]|виски|водк[аи]|коктейл|рецепт|готовить|кулинар|еда|ужин|обед|завтрак|ресторан|кафе|бар)${CYR_B_END}`, "i"), "food_cooking"],
  [new RegExp(`${CYR_B}(погод[аеу]|дожд[ьи]|снег|температур|прогноз)${CYR_B_END}`, "i"), "nature_weather"],
  [new RegExp(`${CYR_B}(фильм|сериал|кино|музык|песн[яию]|игр[аыу]|анекдот|мем|книг[аиу]|развлеч)${CYR_B_END}`, "i"), "entertainment"],
  [new RegExp(`${CYR_B}(девушк|парен[ьи]|свидани|знаком|отношени|свадьб|цвет[ыа] для|подарок для|роман)${CYR_B_END}`, "i"), "family_personal"],
  [new RegExp(`${CYR_B}(похуде|фитнес|спортзал|диет[аыу]|лекарств|таблетк|болезн|симптом|врач|здоровь|косметик|красот)${CYR_B_END}`, "i"), "health_beauty"],
  [new RegExp(`${CYR_B}(купить|магазин|скидк|iPhone|телефон|ноутбук|машин[аыу]|авто|одежд)${CYR_B_END}`, "i"), "shopping"],
  [new RegExp(`${CYR_B}(отпуск|тур[иы]|отел[ьи]|билет[ыа]|путешеств|достопримечат)${CYR_B_END}`, "i"), "travel"],
  [new RegExp(`${CYR_B}(гороскоп|астролог|гадани|таро|магия|эзотерик)${CYR_B_END}`, "i"), "esoteric"],
  [new RegExp(`${CYR_B}(биткоин|крипт|инвестиц|акци[ийя]|курс валют|брокер)${CYR_B_END}`, "i"), "personal_finance"],
  [new RegExp(`${CYR_B}(ремонт квартир|дач[аеу]|уборк|интерьер|мебел[ьи])${CYR_B_END}`, "i"), "household"],
  [new RegExp(`${CYR_B}(кот[аыу]|собак|питом|щенок|котёнок|ветеринар)${CYR_B_END}`, "i"), "pets"],
  [new RegExp(`${CYR_B}(политик|выбор[ыа]|парти[ийя]|президент|депутат)${CYR_B_END}`, "i"), "politics"],
  [new RegExp(`${CYR_B}(войн[аыу]|армия|военн|оружи|солдат)${CYR_B_END}`, "i"), "military"],
  [new RegExp(`${CYR_B}(ставк[аиу]|казино|лотере|букмекер)${CYR_B_END}`, "i"), "gambling"],
  [new RegExp(`${CYR_B}(психолог|мотивац|тревож|депресс|самооценк)${CYR_B_END}`, "i"), "psychology"],
  [new RegExp(`${CYR_B}(язык[аиу] выучить|хобби|рукодели|курс[ыа] для себя)${CYR_B_END}`, "i"), "education_hobby"],
];

function keywordFallback(message: string): ClassifyResult {
  const lower = message.toLowerCase();
  for (const [re, cat] of KEYWORD_RULES) {
    if (re.test(lower)) {
      console.log(`[OffTopic] Keyword fallback matched: ${cat}`);
      return { isOffTopic: true, category: cat };
    }
  }
  return { isOffTopic: false, category: "procurement" };
}

function parseCategory(text: string): OffTopicCategory | null {
  const result = text.trim().toLowerCase().replace(/[^a-z_]/g, "");
  if (!result) return null;

  // Exact match
  if (ALL_CATEGORIES.includes(result as OffTopicCategory)) {
    return result as OffTopicCategory;
  }

  // Partial match: LLM returns "family" → matches "family_personal"
  // or "food" → "food_cooking", etc.
  if (result.length >= 4) {
    const matched = ALL_CATEGORIES.filter(
      (cat) => cat.includes(result) || result.includes(cat)
    );
    // Prefer off-topic categories over procurement for partial matches
    const offTopicMatch = matched.find((c) => c !== "procurement");
    if (offTopicMatch) return offTopicMatch;
    if (matched.length > 0) return matched[0];
  }

  return null;
}

export async function classifyOffTopic(
  userMessage: string,
  conversationHistory?: { role: string; content: string }[]
): Promise<ClassifyResult> {
  // Короткие сообщения — используем keyword fallback
  if (!userMessage || userMessage.trim().length < 10) {
    return keywordFallback(userMessage ?? "");
  }

  let userPrompt: string;
  if (conversationHistory && conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-MAX_HISTORY);
    const historyLines = recent.map((m) => {
      const role = m.role === "user" ? "Пользователь" : "Ассистент";
      const content = m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content;
      return `${role}: ${content}`;
    });
    userPrompt =
      `Контекст предыдущего разговора:\n${historyLines.join("\n")}\n\n` +
      `Новый запрос пользователя: ${userMessage}`;
  } else {
    userPrompt = `Запрос пользователя: ${userMessage}\n\nКатегория:`;
  }

  try {
    const { text } = await generateText({
      model: google("gemini-3-flash-preview"),
      system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 30,
      temperature: 0,
    });

    console.log(`[OffTopic] Query: "${userMessage.slice(0, 80)}" → LLM raw: "${text.trim()}"`);

    const cat = parseCategory(text);
    if (cat) {
      console.log(`[OffTopic] Classified as: ${cat}, isOffTopic: ${cat !== "procurement"}`);
      return { isOffTopic: cat !== "procurement", category: cat };
    }

    // LLM returned empty or unrecognizable — use keyword fallback
    console.warn(`[OffTopic] LLM returned unparseable: "${text.trim()}", trying keyword fallback`);
    return keywordFallback(userMessage);
  } catch (e) {
    console.error("[OffTopic] LLM error, using keyword fallback:", e);
    return keywordFallback(userMessage);
  }
}
