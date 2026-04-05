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
5. Минимум текста — максимум наглядности
6. Цветовая палитра: профессиональная, корпоративная (синий, серый, белый, акцентные цвета)
7. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать латинские буквы-двойники вместо русских (а→a, е→e, о→o, с→c, р→p, х→x и т.д.). Все буквы должны быть кириллическими
8. Шрифты должны быть достаточно крупными для удобного чтения
9. Перед отрисовкой каждой надписи мысленно проверь правописание каждого слова по буквам. Убедись, что все буквы написаны правильно и ни одна не пропущена, не переставлена и не заменена
10. Предпочитай числа, проценты, стрелки и общепринятые символы (✓, ✗, →, %, №) вместо слов там, где это возможно`;

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

/**
 * Build a short, image-generation-friendly prompt for Ideogram.
 * Ideogram is NOT an LLM — it needs concise visual descriptions.
 * Russian text that should appear on the image must be in quotes.
 */
function buildIdeogramPrompt(
  topic: string,
  styleKey: string,
  documentText?: string
): string {
  const styleVisuals: Record<string, string> = {
    business_infographic: "corporate business infographic with icons, charts, and structured data blocks, blue and gray color palette",
    process_timeline: "timeline infographic showing sequential process steps, horizontal flow with arrows",
    comparison_chart: "comparison infographic with parallel columns, contrasting colors",
    statistics_dashboard: "statistics dashboard with pie charts, bar graphs, and large KPI numbers",
    process_flowchart: "flowchart diagram with rectangles for actions, diamonds for decisions, connecting arrows",
    hierarchy_orgchart: "organizational hierarchy chart with connected blocks",
    mindmap: "mind map with central topic and radiating colorful branches",
    procedure_summary: "procedure summary with numbered steps in cards, icons, highlighted key points",
  };

  const styleDesc = styleVisuals[styleKey] || "professional business infographic";

  // Extract short key phrases from document for data hints
  let dataHint = "";
  if (documentText) {
    const excerpt = documentText.slice(0, 2000);
    const numbers = excerpt.match(/\d+[%,.]?\d*/g)?.slice(0, 6) || [];
    if (numbers.length > 0) {
      dataHint = ` Include data: ${numbers.join(", ")}.`;
    }
  }

  // Keep topic short — truncate if too long for Ideogram (max ~200 chars for topic part)
  const topicShort = topic ? topic.slice(0, 200) : "business process overview";

  // Put the Russian title text in quotes so Ideogram renders it on the image
  return `Professional ${styleDesc}. Title text: "${topicShort}". Clean modern design, bold sans-serif Cyrillic font, minimal text on image, use icons, arrows, numbers and visual elements instead of words.${dataHint} All text in Russian Cyrillic script, perfectly spelled.`;
}

/**
 * Generate infographic via Ideogram 3 API.
 * Returns { imageBase64, description } or throws on failure.
 */
async function generateWithIdeogram(
  topic: string,
  styleKey: string,
  aspectRatio?: string,
  documentText?: string
): Promise<{ imageBase64: string; description: string }> {
  const apiKey = process.env.IDEOGRAM_API_KEY || "";
  if (!apiKey) {
    throw new Error("IDEOGRAM_API_KEY не настроен");
  }

  // Map app aspect ratios (16:9) → Ideogram format (16x9)
  const arMap: Record<string, string> = {
    "16:9": "16x9",
    "1:1": "1x1",
    "9:16": "9x16",
  };
  const ideogramAR = (aspectRatio && arMap[aspectRatio]) || "16x9";

  const prompt = buildIdeogramPrompt(topic, styleKey, documentText);

  const res = await Promise.race([
    fetch("https://api.ideogram.ai/v1/ideogram-v3/generate", {
      method: "POST",
      headers: {
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio: ideogramAR,
        rendering_speed: "QUALITY",
        style_type: "DESIGN",
        magic_prompt: "OFF",
        negative_prompt: "blurry text, misspelled words, garbled letters, Latin letters mixed with Cyrillic, unreadable text, gibberish",
      }),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout: 90s")), 90_000)
    ),
  ]);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ideogram API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const imageUrl = json.data?.[0]?.url;
  if (!imageUrl) {
    throw new Error("Ideogram не вернул изображение");
  }

  // Download image and convert to base64
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error("Не удалось загрузить изображение из Ideogram");
  }
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
  const mimeType = imgRes.headers.get("content-type") || "image/png";
  const imageBase64 = `data:${mimeType};base64,${imgBuffer.toString("base64")}`;

  return { imageBase64, description: topic || "Инфографика" };
}

export async function POST(req: NextRequest) {
  try {
    const { topic, style, aspectRatio, documentText, conversationId, model } = await req.json();

    const useIdeogram = model === "ideogram";

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

    // ── Ideogram 3 path ──
    if (useIdeogram) {
      try {
        const { imageBase64, description } = await generateWithIdeogram(topicText, style || "business_infographic", aspectRatio, documentText);
        const descText = fixCyrillicLookalikes(description.trim());

        // Save to DB
        let savedId: string | null = null;
        try {
          const invite = await getInviteCodeFromHeader(req);
          const supabase = createServiceClient();
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
          if (saveError) console.error("Infographic DB save error:", saveError.message);
          savedId = saved?.id || null;
        } catch (saveErr) {
          console.error("Failed to save infographic:", saveErr);
        }

        console.log("Infographic generated successfully with model: ideogram-v3");
        return NextResponse.json({
          image_base64: imageBase64,
          description: descText,
          infographicId: savedId,
          conversationId: conversationId || null,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Ошибка генерации";
        console.error("Ideogram infographic error:", errMsg);
        return NextResponse.json(
          { error: `Не удалось сгенерировать инфографику (Ideogram): ${errMsg}` },
          { status: 502 }
        );
      }
    }

    // ── Google Gemini path (default) ──
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
          // Admin IDs are not UUIDs (e.g. "admin-КИРИЛЛ-АДМИН"), so skip FK
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
