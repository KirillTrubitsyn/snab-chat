import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { withGoogleApiLimit } from "@/app/lib/google-ai";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader } from "@/app/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 120;

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

// Fallback chain: if primary model is unavailable (503), try next
const IMAGE_MODELS = [
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
];

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
5. МАКСИМАЛЬНО СОКРАЩАЙ текст на изображении. Каждая надпись — не более 1-3 коротких слов. Вместо текста используй: иконки, пиктограммы, цветовое кодирование, числа, графики, диаграммы, стрелки и символы (✓, ✗, →, %, №, ₽). Информацию передавай визуально, а не словами
6. Цветовая палитра: профессиональная, корпоративная (синий, серый, белый, акцентные цвета)
7. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать латинские буквы-двойники вместо русских (а→a, е→e, о→o, с→c, р→p, х→x и т.д.). Все буквы должны быть кириллическими
8. Шрифты должны быть достаточно крупными для удобного чтения
9. Перед отрисовкой каждой надписи мысленно проверь правописание каждого слова по буквам. Убедись, что все буквы написаны правильно и ни одна не пропущена, не переставлена и не заменена`;

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
    const { topic, style, aspectRatio, documentText, conversationId } = await req.json();

    const hasDocumentText = documentText && typeof documentText === "string" && documentText.trim().length > 0;
    const topicText = (topic && typeof topic === "string") ? topic.trim() : "";

    if (!topicText && !hasDocumentText) {
      return NextResponse.json(
        { error: "Укажите тему или загрузите контекст документа" },
        { status: 400 }
      );
    }

    const styleInstruction =
      INFOGRAPHIC_STYLE_PROMPTS[style] || style || "";

    let lastError: string | null = null;

    // Build user prompt (document context trimmed to 20k to stay within limits)
    const basePrompt = topicText
      ? `Создай инфографику на тему: ${topicText}\n\nВАЖНО: Если ты размещаешь текст на изображении, пиши каждое русское слово аккуратно, буква за буквой. Используй минимум слов — заменяй текст иконками, числами и графиками где возможно.`
      : "Создай инфографику по следующему документу. Определи тему и ключевые данные самостоятельно.\n\nВАЖНО: Если ты размещаешь текст на изображении, пиши каждое русское слово аккуратно, буква за буквой. Используй минимум слов — заменяй текст иконками, числами и графиками где возможно.";

    let userPrompt = basePrompt;
    if (styleInstruction) {
      userPrompt += `\n\nСтиль и формат: ${styleInstruction}`;
    }
    if (documentText && typeof documentText === "string") {
      const excerpt = documentText.slice(0, 20000);
      userPrompt += `\n\nИспользуй следующие данные как основу для инфографики:\n${excerpt}`;
    }

    const arHints: Record<string, string> = {
      "16:9": "Горизонтальная ориентация (16:9, широкоформатная)",
      "1:1": "Квадратный формат (1:1)",
      "9:16": "Вертикальная ориентация (9:16, для мобильных устройств)",
    };
    if (aspectRatio && arHints[aspectRatio]) {
      userPrompt += `\n\nФормат изображения: ${arHints[aspectRatio]}`;
    }

    // Try each model once with a 50s timeout — no retries, no delays
    for (const modelId of IMAGE_MODELS) {
      try {
        const result = await withGoogleApiLimit(() =>
          Promise.race([
            client.models.generateContent({
              model: modelId,
              contents: [{ role: "user", parts: [{ text: userPrompt }] }],
              config: {
                systemInstruction: SYSTEM_PROMPT,
                responseModalities: ["TEXT", "IMAGE"],
              },
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Timeout: 50s")), 50_000)
            ),
          ])
        );

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
          console.warn(`No image from ${modelId}, trying next...`);
          continue;
        }

        const descText = fixCyrillicLookalikes(description.trim());

        // Save infographic to dedicated infographics table
        let savedId: string | null = null;
        try {
          const invite = await getInviteCodeFromHeader(req);
          const supabase = createServiceClient();
          // Admin IDs are not UUIDs (e.g. "admin-КОЗЛОВ-4831"), so skip FK
          const isRealInviteCode = invite?.id && !invite.id.startsWith("admin-");
          const { data: saved, error: saveError } = await supabase
            .from("infographics")
            .insert({
              invite_code_id: isRealInviteCode ? invite!.id : null,
              conversation_id: (conversationId && typeof conversationId === "string") ? conversationId : null,
              topic: topicText || (descText ? descText.slice(0, 120) : "Инфографика"),
              style: style || "business_infographic",
              aspect_ratio: aspectRatio || "16:9",
              description: descText,
              image_base64: imageBase64,
            })
            .select("id")
            .single();
          if (saveError) {
            console.error("Infographic DB save error:", saveError.message);
          }
          savedId = saved?.id || null;
        } catch (saveErr) {
          console.error("Failed to save infographic:", saveErr);
        }

        console.log(`Infographic generated successfully with model: ${modelId}`);
        return NextResponse.json({
          image_base64: imageBase64,
          description: descText,
          infographicId: savedId,
          conversationId: conversationId || null,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Ошибка генерации";
        lastError = errMsg;
        console.error(`Infographic error with ${modelId}:`, errMsg);
        // Continue to next model immediately — no delays
      }
    }

    return NextResponse.json(
      {
        error: `Не удалось сгенерировать инфографику (все модели недоступны): ${lastError}`,
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
