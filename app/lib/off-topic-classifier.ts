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

const CLASSIFIER_PROMPT = `Ты — классификатор запросов для корпоративного ассистента Дирекции по закупкам и ресурсному обеспечению.
Твоя задача: определить, является ли запрос ЦЕЛЕВЫМ (связанным с работой закупок/снабжения) или НЕЦЕЛЕВЫМ (личным/бытовым).

ЦЕЛЕВЫЕ запросы (категория: procurement):
- Закупки, тендеры, конкурсы, аукционы, котировки
- Снабжение, поставки, логистика, склад
- Договоры, контракты, спецификации
- Нормативные документы, регламенты, стандарты
- Ценообразование, сметы, бюджеты закупок
- МТР, ТМЦ, приёмка товаров, рекламации
- Квалификация поставщиков, контрагенты
- 44-ФЗ, 223-ФЗ, закупочное законодательство
- Подготовка закупочной документации
- Редактирование, улучшение, переформулировка рабочего текста

НЕЦЕЛЕВЫЕ категории:
- household — быт, ремонт, дача, уборка, дизайн интерьера
- family_personal — личные отношения, свидания, свадьбы, воспитание детей
- food_cooking — рецепты, рестораны, диеты, продукты, напитки, пиво, вино
- health_beauty — симптомы болезней, лекарства, косметика, фитнес, похудение
- esoteric — гороскопы, астрология, гадания, таро, магия, сонники
- psychology — личностный рост, мотивация, отношения с близкими, тревожность
- travel — туры, отели, билеты, достопримечательности, курорты
- shopping — бытовая техника, одежда, автомобили, мебель, скидки
- entertainment — фильмы, сериалы, игры, музыка, книги, мемы, анекдоты
- tech_personal — настройка телефона, соцсети, личные приложения
- nature_weather — погода, прогнозы, растения, животные в природе
- personal_finance — личные инвестиции, криптовалюты, личный бюджет
- education_hobby — изучение языков, рукоделие, курсы для саморазвития
- gambling — ставки, казино, лотереи
- pets — уход за питомцами, ветеринария, корма, породы
- politics — политика, выборы, партии, политические деятели, геополитика
- military — войны, военное дело, оружие, армия, военная техника
- other_off_topic — прочие личные вопросы

ВАЖНО:
- Если вопрос связан с ЗАКУПКАМИ (даже в личном контексте) — это procurement
  Пример: "Как провести закупку?" — procurement
  Пример: "Как помириться с женой?" — family_personal (не закупки)
- Если вопрос о работе отдела закупок — procurement
- Запросы на редактирование, улучшение, переформулировку — это procurement (рабочие задачи)
  Пример: "как это улучшить, сформулируй" — procurement
  Пример: "перефразируй этот абзац" — procurement
- При сомнениях относи к procurement (лучше не блокировать рабочий запрос)

ПРИМЕРЫ:
"какое пиво лучше" → food_cooking
"как подобрать цветы для девушки" → family_personal
"классное вино" → food_cooking
"какая погода" → nature_weather
"закупка труб" → procurement
"как провести тендер" → procurement
"ремонт квартиры" → household
"где купить iPhone" → shopping

УТОЧНЯЮЩИЕ ВОПРОСЫ И ПРОДОЛЖЕНИЕ ДИАЛОГА:
- Если запрос — это ПРОДОЛЖЕНИЕ или УТОЧНЕНИЕ предыдущего разговора (например: "подробнее", "а ещё?", "что насчёт...", "а если...", "расскажи больше"), классифицируй его НА ОСНОВЕ ТЕМЫ РАЗГОВОРА, а не буквального текста.
- Пример: предыдущий разговор о закупках, уточнение "а как это на практике?" = procurement
- Если есть история разговора — ОБЯЗАТЕЛЬНО учитывай её при классификации.

Ответь ОДНИМ словом — названием категории из списка выше.`;

const MAX_HISTORY = 4;

export interface ClassifyResult {
  isOffTopic: boolean;
  category: OffTopicCategory;
}

export async function classifyOffTopic(
  userMessage: string,
  conversationHistory?: { role: string; content: string }[]
): Promise<ClassifyResult> {
  // Короткие сообщения — считаем целевыми (как в sgc-legal-ai)
  if (!userMessage || userMessage.trim().length < 10) {
    return { isOffTopic: false, category: "procurement" };
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
    userPrompt = userMessage;
  }

  try {
    const { text } = await generateText({
      model: google("gemini-3-flash-preview"),
      system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 20,
      temperature: 0,
    });

    const result = text.trim().toLowerCase();
    console.log(`[OffTopic] Query: "${userMessage.slice(0, 80)}" → LLM raw: "${result}"`);

    // Простой парсинг как в sgc-legal-ai: проверяем вхождение категории в ответ
    for (const category of ALL_CATEGORIES) {
      if (result.includes(category)) {
        const isOffTopic = category !== "procurement";
        console.log(`[OffTopic] Classified as: ${category}, isOffTopic: ${isOffTopic}`);
        return { isOffTopic, category };
      }
    }

    console.warn(`[OffTopic] Unknown category: "${result}", defaulting to procurement`);
    return { isOffTopic: false, category: "procurement" };
  } catch (e) {
    console.error("[OffTopic] Classification failed:", e);
    return { isOffTopic: false, category: "procurement" };
  }
}
