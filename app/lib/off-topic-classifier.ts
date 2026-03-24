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

const CLASSIFIER_PROMPT = `Ты — классификатор запросов для корпоративного ассистента Дирекции по закупкам и ресурсному обеспечению.
Твоя задача: определить, является ли запрос ЦЕЛЕВЫМ (связанным с работой дирекции) или НЕЦЕЛЕВЫМ (личным/бытовым).

ЦЕЛЕВЫЕ запросы (категория: procurement):
- Закупки, тендеры, конкурсы, аукционы, запросы котировок
- Снабжение, поставки, логистика, складские операции
- Договоры с поставщиками, контракты, спецификации
- Нормативные документы, регламенты, стандарты организации
- Ценообразование, калькуляция, сметы, бюджеты закупок
- Приёмка товаров, рекламации, гарантии
- Планирование закупок, потребности подразделений
- МТР (материально-технические ресурсы), ТМЦ
- Квалификация поставщиков, реестры, проверки контрагентов
- Документооборот закупочной деятельности
- Редактирование, улучшение, переформулировка текста (рабочие задачи)
- Вопросы по внутренним процедурам и регламентам компании
- 44-ФЗ, 223-ФЗ, закупочное законодательство

НЕЦЕЛЕВЫЕ категории:
- household — быт, ремонт, дача, уборка, дизайн интерьера
- family_personal — личные отношения, свидания, свадьбы, воспитание детей
- food_cooking — рецепты, рестораны, диеты, продукты
- health_beauty — симптомы болезней, лекарства, косметика, фитнес
- esoteric — гороскопы, астрология, гадания, таро, магия
- psychology — личностный рост, мотивация, тревожность
- travel — туры, отели, билеты, достопримечательности
- shopping — бытовая техника, одежда, автомобили, мебель, скидки
- entertainment — фильмы, сериалы, игры, музыка, книги, мемы
- tech_personal — настройка телефона, соцсети, личные приложения
- nature_weather — погода, прогнозы, растения, животные в природе
- personal_finance — личные инвестиции, криптовалюты, личный бюджет
- education_hobby — изучение языков, рукоделие, курсы для саморазвития
- gambling — ставки, казино, лотереи
- pets — уход за питомцами, ветеринария, корма
- politics — политика, выборы, партии, геополитика
- military — войны, военное дело, оружие, армия
- other_off_topic — прочие личные вопросы

ВАЖНО:
- Если вопрос связан с закупками, снабжением, договорами — это procurement
- Запросы на редактирование текста — это procurement (рабочие задачи)
- При сомнениях относи к procurement (лучше не блокировать рабочий запрос)
- Но если вопрос ОЧЕВИДНО не связан с работой — классифицируй честно, не натягивай на procurement

ПРИМЕРЫ НЕЦЕЛЕВЫХ ЗАПРОСОВ (НЕ procurement):
- "какое пиво лучше брать" → food_cooking
- "где купить iPhone" → shopping
- "какая погода завтра" → nature_weather
- "посоветуй фильм" → entertainment
- "как похудеть" → health_beauty
- "куда поехать в отпуск" → travel
- "какой курс биткоина" → personal_finance
- "расскажи анекдот" → entertainment
- "что приготовить на ужин" → food_cooking
- "как воспитывать ребёнка" → family_personal
- "какую машину купить" → shopping

УТОЧНЯЮЩИЕ ВОПРОСЫ И ПРОДОЛЖЕНИЕ ДИАЛОГА:
- Если запрос — продолжение предыдущего разговора ("подробнее", "а ещё?", "что насчёт..."),
  классифицируй на основе ТЕМЫ РАЗГОВОРА, а не буквального текста.
- Если есть история разговора — ОБЯЗАТЕЛЬНО учитывай её.

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
  // Короткие сообщения не классифицируем
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
      model: google("gemini-3-flash"),
      system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 20,
      temperature: 0,
    });

    const result = text.trim().toLowerCase();

    for (const cat of ALL_CATEGORIES) {
      if (result.includes(cat)) {
        return { isOffTopic: cat !== "procurement", category: cat };
      }
    }

    // Не распознали — считаем целевым
    console.warn(`[OffTopic] Неизвестная категория: "${result}", default → procurement`);
    return { isOffTopic: false, category: "procurement" };
  } catch (e) {
    console.error("[OffTopic] Ошибка классификации:", e);
    return { isOffTopic: false, category: "procurement" };
  }
}
