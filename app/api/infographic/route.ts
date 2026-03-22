import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { withGoogleApiLimit } from "@/app/lib/google-ai";

export const runtime = "nodejs";
export const maxDuration = 120;

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

const MODEL = "gemini-3.1-flash-image-preview";

const INFOGRAPHIC_STYLE_PROMPTS: Record<string, string> = {
  business_infographic:
    "Деловая корпоративная инфографика с чёткой структурой, иконками, числовыми данными и графиками. Используй синие и серые тона.",
  process_timeline:
    "Таймлайн / хронология этапов процесса. Расположи этапы последовательно слева направо или сверху вниз с датами и описаниями.",
  comparison_chart:
    "Сравнительная инфографика: таблица или параллельные блоки для сравнения вариантов, поставщиков или условий. Используй контрастные цвета для различения.",
  statistics_dashboard:
    "Дашборд статистики: круговые диаграммы, столбчатые графики, ключевые числовые показатели (KPI) крупным шрифтом.",
  process_flowchart:
    "Блок-схема процесса: прямоугольники для действий, ромбы для решений, стрелки для переходов. Чёткая логика алгоритма.",
  hierarchy_orgchart:
    "Организационная структура / иерархия: блоки с названиями подразделений или должностей, соединённые линиями подчинённости.",
  mindmap:
    "Интеллект-карта (mind map): центральная тема и расходящиеся ветви с подтемами. Используй разные цвета для каждой ветви.",
  procedure_summary:
    "Визуальное резюме процедуры / регламента: ключевые пункты в карточках, иконки, нумерация шагов, выделение важного.",
};

const SYSTEM_PROMPT = `Ты профессиональный дизайнер инфографики. Создавай наглядные, информативные инфографики на русском языке.

ВАЖНЫЕ ПРАВИЛА:
1. Весь текст на инфографике ДОЛЖЕН быть на русском языке (кириллица)
2. Текст должен быть чётким, читаемым, без ошибок и опечаток
3. Используй профессиональный деловой стиль
4. Структурируй информацию визуально: блоки, стрелки, иконки, нумерация
5. Минимум текста — максимум наглядности
6. Цветовая палитра: профессиональная, корпоративная (синий, серый, белый, акцентные цвета)
7. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать латинские буквы-двойники вместо русских (а→a, е→e, о→o, с→c, р→p, х→x и т.д.). Все буквы должны быть кириллическими
8. Шрифты должны быть достаточно крупными для удобного чтения`;

/**
 * Fix Cyrillic lookalike characters — replace Latin chars that look like
 * Cyrillic with their proper Cyrillic counterparts in Russian text.
 */
function fixCyrillicLookalikes(text: string): string {
  const map: Record<string, string> = {
    A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К",
    M: "М", O: "О", P: "Р", T: "Т", X: "Х",
    a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у",
  };
  return text.replace(/[ABCEHKMOPTXaceopxy]/g, (ch) => map[ch] ?? ch);
}

export async function POST(req: NextRequest) {
  try {
    const { topic, style, aspectRatio, documentText } = await req.json();

    if (!topic || typeof topic !== "string" || topic.trim().length < 3) {
      return NextResponse.json(
        { error: "Тема должна содержать минимум 3 символа" },
        { status: 400 }
      );
    }

    const styleInstruction =
      INFOGRAPHIC_STYLE_PROMPTS[style] || style || "";

    const maxRetries = 3;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Progressive simplification: reduce document context on retries
      const docLimit = attempt === 0 ? 30000 : attempt === 1 ? 10000 : 0;

      let userPrompt = `Создай инфографику на тему: ${topic}`;
      if (styleInstruction) {
        userPrompt += `\n\nСтиль и формат: ${styleInstruction}`;
      }
      if (documentText && typeof documentText === "string" && docLimit > 0) {
        const excerpt = documentText.slice(0, docLimit);
        userPrompt += `\n\nИспользуй следующие данные как основу для инфографики:\n${excerpt}`;
      }

      // Aspect ratio hint
      const arHints: Record<string, string> = {
        "16:9": "Горизонтальная ориентация (16:9, широкоформатная)",
        "1:1": "Квадратный формат (1:1)",
        "9:16": "Вертикальная ориентация (9:16, для мобильных устройств)",
      };
      if (aspectRatio && arHints[aspectRatio]) {
        userPrompt += `\n\nФормат изображения: ${arHints[aspectRatio]}`;
      }

      try {
        const result = await withGoogleApiLimit(async () => {
          const response = await client.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            config: {
              systemInstruction: SYSTEM_PROMPT,
              responseModalities: ["TEXT", "IMAGE"],
            },
          });
          return response;
        });

        // Extract image and text from response
        const parts = result.candidates?.[0]?.content?.parts ?? [];
        let imageBase64 = "";
        let description = "";

        for (const part of parts) {
          if (part.inlineData?.data) {
            const mimeType = part.inlineData.mimeType || "image/png";
            imageBase64 = `data:${mimeType};base64,${part.inlineData.data}`;
          }
          if (part.text) {
            description += part.text;
          }
        }

        if (!imageBase64) {
          lastError = "Модель не вернула изображение";
          console.warn(
            `No image in response (attempt ${attempt + 1}/${maxRetries})`
          );
          if (attempt < maxRetries - 1) {
            await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
            continue;
          }
          break;
        }

        return NextResponse.json({
          image_base64: imageBase64,
          description: fixCyrillicLookalikes(description.trim()),
        });
      } catch (err) {
        lastError =
          err instanceof Error ? err.message : "Ошибка генерации";
        console.error(
          `Infographic generation error (attempt ${attempt + 1}/${maxRetries}):`,
          err
        );
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
          continue;
        }
      }
    }

    return NextResponse.json(
      {
        error: `Не удалось сгенерировать инфографику после ${maxRetries} попыток: ${lastError}`,
      },
      { status: 502 }
    );
  } catch (err) {
    console.error("Infographic generation error:", err);
    return NextResponse.json(
      { error: "Ошибка сервера при генерации инфографики" },
      { status: 500 }
    );
  }
}
