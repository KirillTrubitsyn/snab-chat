/**
 * Parent-Child ключ для группировки чанков одного раздела документа.
 *
 * Формат: "<source_id_8hex>::<section>"
 *
 *   - source_id_8hex: первые 8 hex-символов UUID source.id (без дефисов).
 *     Гарантирует изоляцию разделов между документами с одинаковыми
 *     заголовками разделов (см. аудит L2-08 про кросс-документную
 *     контаминацию).
 *
 *   - section: извлекается из content чанка каскадом эвристик:
 *       1. Первый markdown h1/h2/h3 заголовок.
 *       2. "Статья N", "Раздел N", "Глава N", "Пункт N.N".
 *       3. "Таблица N", "Приложение N".
 *       4. Фолбэк: "общий".
 *
 * Используется в:
 *   - backend/src/routes/ingest.ts (вставка новых чанков через /api/ingest)
 *   - backend/scripts/backfill-parent-group-key-all.ts (исторический backfill)
 *
 * ВАЖНО: изменение формулы сломает связи с уже залитыми чанками.
 * При изменении необходимо перезапустить backfill.
 */

export function normalizeSection(str: string): string {
  return str
    .replace(/\s+/g, "_")
    .replace(/[«»""()]/g, "")
    .replace(/[^а-яА-ЯёЁa-zA-Z0-9_\-.]/g, "")
    .slice(0, 60);
}

export function extractSection(content: string): string {
  // Heuristic cascade — first match wins.
  const patterns: RegExp[] = [
    /^#{1,3}\s+(.{3,80}?)\s*$/m, // markdown headings
    /(?:Стать[яеи])\s+(\d+[а-яА-Я]?(?:\.\d+)?)/i,
    /(?:Раздел)\s+(\d+[а-яА-Я]?(?:\.\d+)?)/i,
    /(?:Глав[ае])\s+(\d+[а-яА-Я]?)/i,
    /(?:Пункт)\s+(\d+(?:\.\d+)+)/i,
    /(?:Таблиц[аеы])\s+(?:№\s*)?(\d+[а-яА-Я]?(?:\.\d+)?)/i,
    /(?:Приложени[еяю])\s+(?:№\s*)?(\d+[а-яА-Я]?)/i,
  ];
  for (const pattern of patterns) {
    const m = content.match(pattern);
    if (m && m[1]) return normalizeSection(m[1]);
  }
  return "общий";
}

/**
 * Главная функция: принимает source_id (UUID) и content чанка,
 * возвращает готовый parent_group_key.
 *
 * Если source_id null/пустой — используется prefix "orphan".
 */
export function computeParentGroupKey(
  sourceId: string | null | undefined,
  content: string,
): string {
  const sourcePrefix = sourceId
    ? sourceId.replace(/-/g, "").slice(0, 8)
    : "orphan";
  const section = extractSection(content ?? "");
  return `${sourcePrefix}::${section}`;
}
