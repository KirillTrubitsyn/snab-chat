/**
 * Одноразовый скрипт для перетегирования всех документов в базе.
 * Запуск: npx tsx scripts/retag.ts
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { autoTag, detectCategory, getCategoryLabel } from "../app/lib/tagging";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Установите NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("🔄 Загрузка списка документов...\n");

  const { data: sources, error: srcErr } = await supabase
    .from("sources")
    .select("id, filename, content_preview")
    .order("id");

  if (srcErr || !sources) {
    console.error("❌ Ошибка загрузки sources:", srcErr?.message);
    process.exit(1);
  }

  const total = sources.length;
  console.log(`📚 Найдено документов: ${total}\n`);

  const categoryStats: Record<string, number> = {};

  for (let i = 0; i < total; i++) {
    const source = sources[i];
    const prefix = `[${i + 1}/${total}]`;

    // Собираем полный текст из чанков
    const { data: chunks, error: chunkErr } = await supabase
      .from("chunks")
      .select("content")
      .eq("source_id", source.id)
      .order("chunk_index");

    if (chunkErr) {
      console.error(`${prefix} ❌ Ошибка чтения чанков для ${source.filename}:`, chunkErr.message);
      continue;
    }

    const fullText = chunks?.map((c) => c.content).join("\n\n") || source.content_preview || "";

    if (!fullText.trim()) {
      console.log(`${prefix} ⚠️  ${source.filename} — пустой текст, пропуск`);
      continue;
    }

    // Генерируем теги
    const tags = await autoTag(fullText, source.filename);
    const category = detectCategory(tags, source.filename);
    const categoryLabel = getCategoryLabel(category);

    // Обновляем sources
    const { error: updSrcErr } = await supabase
      .from("sources")
      .update({ tags, category })
      .eq("id", source.id);

    if (updSrcErr) {
      console.error(`${prefix} ❌ Ошибка обновления source ${source.filename}:`, updSrcErr.message);
      continue;
    }

    // Обновляем chunks
    const { error: updChunkErr } = await supabase
      .from("chunks")
      .update({ tags })
      .eq("source_id", source.id);

    if (updChunkErr) {
      console.error(`${prefix} ❌ Ошибка обновления chunks ${source.filename}:`, updChunkErr.message);
    }

    // Статистика
    categoryStats[categoryLabel] = (categoryStats[categoryLabel] || 0) + 1;

    console.log(`${prefix} ${source.filename}`);
    console.log(`       → [${tags.slice(0, 5).join(", ")}${tags.length > 5 ? ", ..." : ""}]`);
    console.log(`       → ${categoryLabel}\n`);

    // Задержка 1 секунда между документами (rate limit Gemini)
    if (i < total - 1) {
      await sleep(1000);
    }
  }

  // Итоговая статистика
  console.log("═".repeat(50));
  console.log("📊 Статистика по категориям:\n");

  const sorted = Object.entries(categoryStats).sort(([, a], [, b]) => b - a);
  for (const [label, count] of sorted) {
    console.log(`   ${label}: ${count}`);
  }
  console.log(`\n   Итого: ${sorted.reduce((s, [, c]) => s + c, 0)} документов`);
  console.log("\n✅ Готово!");
}

main().catch((err) => {
  console.error("❌ Фатальная ошибка:", err);
  process.exit(1);
});
