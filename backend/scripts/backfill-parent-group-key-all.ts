/**
 * C08 backfill: заполнить parent_group_key для всех чанков, где он NULL.
 *
 * Существующий scripts/backfill-parent-keys.js охватывает только чанки
 * с тегом "денормализовано" (jsonl-ingested). Основная часть NULL-записей
 * (~8396 из 16006 по аудиту от 21.04.2026) приходит с обычного /api/ingest,
 * который parent_group_key не проставляет вовсе.
 *
 * Стратегия:
 *   parent_group_key = "<source_id_prefix>::<section>"
 *
 *   - source_id_prefix: первые 8 символов source.id (UUID) — гарантирует
 *     изоляцию разделов между документами с одинаковыми заголовками
 *     (см. L2-08 про кросс-документную контаминацию).
 *   - section: извлекается из content чанка по эвристикам:
 *       1. Первый h1/h2/h3 markdown заголовок.
 *       2. Первая "Статья N", "Раздел N", "Глава N", "Пункт N.N".
 *       3. Первая "Таблица N", "Приложение N".
 *       4. Фолбэк: "общий".
 *
 * Запуск (из корня репо):
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_KEY=... \
 *   npx tsx backend/scripts/backfill-parent-group-key-all.ts
 *
 * Безопасно для повторного запуска: каждый UPDATE целится только на
 * chunks WHERE parent_group_key IS NULL.
 */

import { createClient } from "@supabase/supabase-js";
import { computeParentGroupKey } from "../src/lib/parent-group-key.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH_SIZE = 200;
const PAGE_SIZE = 1000;

// ── Section extraction ──
// Формула и эвристики вынесены в backend/src/lib/parent-group-key.ts
// (L2-03, 22.04.2026) — чтобы /api/ingest и этот скрипт гарантированно
// считали один и тот же ключ для одинаковых входов.

// ── Main ──

interface ChunkRow {
  id: string;
  source_id: string | null;
  content: string;
}

async function fetchNullChunks(
  offset: number,
  limit: number,
): Promise<ChunkRow[]> {
  const { data, error } = await supabase
    .from("chunks")
    .select("id, source_id, content")
    .is("parent_group_key", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Fetch failed: ${error.message}`);
  return (data ?? []) as ChunkRow[];
}

async function countNull(): Promise<number> {
  const { count, error } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .is("parent_group_key", null);
  if (error) throw new Error(`Count failed: ${error.message}`);
  return count ?? 0;
}

async function updateChunkGroupKey(id: string, key: string): Promise<void> {
  const { error } = await supabase
    .from("chunks")
    .update({ parent_group_key: key })
    .eq("id", id)
    .is("parent_group_key", null); // idempotent guard
  if (error) throw new Error(`Update ${id} failed: ${error.message}`);
}

async function updateBatch(
  updates: Array<{ id: string; key: string }>,
): Promise<number> {
  // Supabase REST can't do heterogeneous UPDATEs in one call. Group by key
  // and issue IN (...) batch per key.
  const byKey = new Map<string, string[]>();
  for (const u of updates) {
    if (!byKey.has(u.key)) byKey.set(u.key, []);
    byKey.get(u.key)!.push(u.id);
  }
  let totalUpdated = 0;
  for (const [key, ids] of byKey) {
    // Chunk IN (...) into sub-batches of 100 to avoid URL length limits
    for (let i = 0; i < ids.length; i += 100) {
      const sub = ids.slice(i, i + 100);
      const { error, count } = await supabase
        .from("chunks")
        .update({ parent_group_key: key }, { count: "exact" })
        .in("id", sub)
        .is("parent_group_key", null);
      if (error) {
        console.error(`Batch update failed for key "${key}":`, error.message);
        // Fallback to per-row
        for (const id of sub) {
          try {
            await updateChunkGroupKey(id, key);
            totalUpdated++;
          } catch (e) {
            console.error(`  per-row failed ${id}:`, e);
          }
        }
      } else {
        totalUpdated += count ?? sub.length;
      }
    }
  }
  return totalUpdated;
}

async function main(): Promise<void> {
  const start = Date.now();
  const initialCount = await countNull();
  console.log(`[backfill-pgk] Starting. NULL parent_group_key: ${initialCount}`);

  if (initialCount === 0) {
    console.log("[backfill-pgk] Nothing to do.");
    return;
  }

  let processed = 0;
  let updated = 0;
  let offset = 0;

  // Loop until we've processed all initially-NULL rows.
  // Since UPDATE removes rows from the "NULL" set, we fetch with offset=0 each
  // iteration (cheaper than pagination, since the set shrinks).
  while (processed < initialCount) {
    const rows = await fetchNullChunks(0, PAGE_SIZE);
    if (rows.length === 0) break;

    const updates: Array<{ id: string; key: string }> = [];
    for (const row of rows) {
      const key = computeParentGroupKey(row.source_id, row.content);
      updates.push({ id: row.id, key });
    }

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const slice = updates.slice(i, i + BATCH_SIZE);
      updated += await updateBatch(slice);
    }
    processed += rows.length;

    const pct = Math.min(100, Math.round((processed / initialCount) * 100));
    console.log(
      `[backfill-pgk] processed=${processed}/${initialCount} updated=${updated} (${pct}%)`,
    );

    // Safety check — if we stop making progress, break.
    if (rows.length < PAGE_SIZE) break;
    offset += rows.length;
  }

  const remaining = await countNull();
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[backfill-pgk] Done in ${duration}s. Updated=${updated}, remaining NULL=${remaining}`,
  );
  if (remaining > 0) {
    console.warn(
      `[backfill-pgk] ${remaining} records still NULL — re-run or inspect manually`,
    );
  }
}

main().catch((err) => {
  console.error("[backfill-pgk] Fatal:", err);
  process.exit(1);
});
