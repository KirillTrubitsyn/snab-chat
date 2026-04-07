/**
 * Скрипт миграции: находит документы в категории "Договоры",
 * которые на самом деле являются формами/шаблонами/карточками,
 * и перемещает их в правильную категорию.
 *
 * Запуск: npx ts-node --project tsconfig.json scripts/migrate-contracts-to-forms.ts
 * (или через tsx: npx tsx scripts/migrate-contracts-to-forms.ts)
 *
 * Требует переменных окружения: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Копия логики из app/lib/tagging.ts ──

const CATEGORY_KEYWORDS: Record<string, string> = {
  "федеральный закон": "npa",
  "постановление правительства": "npa",
  "223-фз": "npa",
  "кодекс": "npa",
  "ценообразование": "pricing",
  "стоимость чел-час": "pricing",
  "сметная стоимость": "pricing",
  "базовые цены": "pricing",
  "индексы": "pricing",
  "индекс": "pricing",
  "коэффициент": "pricing",
  "тариф": "pricing",
  "нмцд": "pricing",
  "фер": "pricing",
  "справочник": "references",
  "реестр": "references",
  "перечень": "references",
  "лимит": "references",
  "классификатор": "references",
  "нормативные сроки": "references",
  "зоны ответственности": "references",
  "список ответственных": "references",
  "карточка контрагента": "contractor-cards",
  "карточка поставщика": "contractor-cards",
  "история закупок": "contractor-cards",
  "сведения о контрагенте": "contractor-cards",
  "сведения о поставщике": "contractor-cards",
  "досье поставщика": "contractor-cards",
  "договор": "contracts",
  "контракт": "contracts",
  "дополнительное соглашение": "contracts",
  "агентский": "contracts",
  "инструкция": "instructions",
  "методика": "instructions",
  "руководство": "instructions",
  "памятка": "instructions",
  "форма": "forms",
  "шаблон": "forms",
  "бланк": "forms",
  "образец": "forms",
  "анкета": "forms",
  "инициация": "forms",
  "служебная записка": "forms",
  "спецификация": "forms",
  "техническое задание": "forms",
  "протокол": "forms",
  "бюллетень": "forms",
  "извещение": "forms",
  "обоснование нмцд": "forms",
  "заявка": "forms",
  "блок-схема": "schemas",
  "схема": "schemas",
  "алгоритм": "schemas",
  "диаграмма": "schemas",
  "стандарт": "standards",
  "положение": "standards",
  "регламент": "standards",
  "приказ": "standards",
  "правила": "standards",
  "закон": "npa",
  "постановление": "npa",
  "указ": "npa",
  "распоряжение": "npa",
  "обучение": "training",
  "курс": "training",
  "тренинг": "training",
  "учебный": "training",
};

const SORTED_KEYWORDS = Object.entries(CATEGORY_KEYWORDS)
  .sort((a, b) => b[0].length - a[0].length);

function detectCategory(tags: string[], filename?: string): string {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    for (const [keyword, category] of SORTED_KEYWORDS) {
      if (lower.includes(keyword)) return category;
    }
  }
  if (filename) {
    const lower = filename.toLowerCase();
    for (const [keyword, category] of SORTED_KEYWORDS) {
      if (lower.includes(keyword)) return category;
    }
  }
  return "standards";
}

// ── Специальная логика для Карточка_КА ──
function refineCategory(detected: string, filename: string, tags: string[]): string {
  const lower = filename.toLowerCase();
  // Карточка_КА = карточка контрагента
  if (lower.includes("карточка_ка") || lower.includes("карточка ка")) {
    return "contractor-cards";
  }
  // Обоснование НМЦД → forms (форма обоснования)
  if (lower.includes("обоснование") && lower.includes("нмцд")) {
    return "forms";
  }
  return detected;
}

const CATEGORY_LABELS: Record<string, string> = {
  npa: "НПА",
  standards: "Стандарты и Положения",
  forms: "Формы и Шаблоны",
  schemas: "Схемы процессов",
  instructions: "Инструкции и Методики",
  pricing: "Ценообразование",
  references: "Справочники и Реестры",
  "contractor-cards": "Карточки контрагентов",
  contracts: "Договоры",
  training: "Обучение",
};

async function main() {
  console.log("Загружаю документы из категории 'Договоры'...\n");

  const { data: sources, error } = await supabase
    .from("sources")
    .select("id, filename, tags, folder_path")
    .eq("folder_path", "contracts")
    .order("filename");

  if (error) {
    console.error("Ошибка запроса:", error.message);
    process.exit(1);
  }

  console.log(`Найдено ${sources.length} документов в 'Договоры'\n`);

  const toMove: { id: number; filename: string; newCategory: string }[] = [];
  const keepContracts: { id: number; filename: string }[] = [];

  for (const doc of sources) {
    const detected = detectCategory(doc.tags || [], doc.filename);
    const refined = refineCategory(detected, doc.filename || "", doc.tags || []);

    if (refined !== "contracts") {
      toMove.push({ id: doc.id, filename: doc.filename, newCategory: refined });
    } else {
      keepContracts.push({ id: doc.id, filename: doc.filename });
    }
  }

  console.log(`📦 Остаются в 'Договоры' (${keepContracts.length}):`);
  for (const d of keepContracts) {
    console.log(`  ✅  ${d.filename}`);
  }

  console.log(`\n🔀 Перемещаются (${toMove.length}):`);
  for (const d of toMove) {
    console.log(`  📁  ${d.filename}  →  ${CATEGORY_LABELS[d.newCategory] || d.newCategory}`);
  }

  if (toMove.length === 0) {
    console.log("\nНечего перемещать.");
    return;
  }

  const answer = process.argv.includes("--dry-run")
    ? "n"
    : "y";

  if (process.argv.includes("--dry-run")) {
    console.log("\n[DRY RUN] Изменения не применены. Убери --dry-run для применения.");
    return;
  }

  console.log("\nПрименяю изменения...");

  // Group by target category for batch updates
  const byCategory: Record<string, number[]> = {};
  for (const d of toMove) {
    if (!byCategory[d.newCategory]) byCategory[d.newCategory] = [];
    byCategory[d.newCategory].push(d.id);
  }

  let totalMoved = 0;
  for (const [cat, ids] of Object.entries(byCategory)) {
    const { error: updateError } = await supabase
      .from("sources")
      .update({ folder_path: cat })
      .in("id", ids);

    if (updateError) {
      console.error(`Ошибка при обновлении категории '${cat}':`, updateError.message);
    } else {
      console.log(`  ✅  ${ids.length} документов → '${CATEGORY_LABELS[cat]}'`);
      totalMoved += ids.length;
    }
  }

  console.log(`\n✨ Готово! Перемещено ${totalMoved} из ${toMove.length} документов.`);
}

main().catch(console.error);
