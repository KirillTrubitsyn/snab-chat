import { google } from "@/app/lib/google-ai";
import { generateText } from "ai";

export async function autoTag(markdown: string): Promise<string[]> {
  const preview = markdown.slice(0, 4000);

  const { text } = await generateText({
    model: google("gemini-3-flash"),
    prompt: `Проанализируй текст документа и сгенерируй от 3 до 10 тегов (на русском языке) для классификации.
Теги должны отражать тематику документа в контексте закупок, снабжения и корпоративного управления.
Верни ТОЛЬКО JSON-массив строк, без пояснений.

Пример ответа: ["закупки", "тендер", "договор поставки"]

Текст:
${preview}`,
  });

  try {
    const cleaned = text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string").slice(0, 10);
    }
  } catch {
    // fallback
  }
  return ["документ"];
}
