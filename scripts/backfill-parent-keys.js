/**
 * backfill-parent-keys.js
 *
 * Скрипт для простановки parent_group_key в существующих чанках Группы 1.
 * Запускается из browser console на странице Supabase SQL Editor
 * или через Node.js с переменными окружения.
 *
 * Логика группировки:
 *   parent_group_key = "{source_filename}::{table_name_or_section}"
 *
 * Чанки группируются по source_id + анализу content для определения
 * принадлежности к одной таблице.
 *
 * Использование (browser console):
 *   1. Откройте https://supabase.com/dashboard/project/hjjfugvnhjnvbchfjsbm
 *   2. Откройте Console (F12)
 *   3. Вставьте этот скрипт и нажмите Enter
 *
 * Использование (Node.js):
 *   SUPABASE_URL=https://hjjfugvnhjnvbchfjsbm.supabase.co \
 *   SUPABASE_SERVICE_KEY=... \
 *   node backfill-parent-keys.js
 */

// ── Конфигурация ──
const SUPABASE_URL = typeof process !== 'undefined'
  ? process.env.SUPABASE_URL
  : 'https://hjjfugvnhjnvbchfjsbm.supabase.co';

const SUPABASE_KEY = typeof process !== 'undefined'
  ? process.env.SUPABASE_SERVICE_KEY
  : prompt('Введите Supabase service role key:');

const BATCH_SIZE = 50;

// ── Вспомогательные функции ──

async function supabaseRPC(method, path, body = null) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'PATCH' ? 'return=minimal' : 'return=representation',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`);
  }
  if (method === 'PATCH') return null;
  return res.json();
}

/**
 * Извлекает table_name / section из content чанка.
 * Паттерны, которые встречаются в денормализованных стейтментах:
 *   - "В матрице полномочий ЗКО ..." → "Матрица полномочий ЗКО"
 *   - "Согласно Таблице 4 ..." → "Таблица 4"
 *   - "В Приложении 3 ..." → "Приложение 3"
 *   - Для стейтментов без явного указания таблицы → группировка по source_filename
 */
function extractTableKey(content) {
  // Паттерн 1: явное упоминание таблицы/приложения в начале
  const tablePatterns = [
    /(?:Таблиц[аеыу]|Table)\s*(?:№\s*)?(\d+[а-яА-Я]?(?:\.\d+)?(?:\s*[«"].+?[»"])?)/i,
    /(?:Приложени[еяю])\s*(?:№\s*)?(\d+[а-яА-Я]?)/i,
    /(?:Матриц[аеыу])\s+(?:полномочий\s+)?((?:ЗКО|закупочн)[^\.,]*)/i,
    /(?:Перечень|Реестр|Справочник|Каталог)\s+([^\.,]{5,40})/i,
  ];

  for (const pattern of tablePatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[0].trim().substring(0, 60);
    }
  }

  return null; // группируем по source_filename целиком
}

/**
 * Нормализует ключ: убирает лишние пробелы, спецсимволы
 */
function normalizeKey(str) {
  return str
    .replace(/\s+/g, '_')
    .replace(/[«»""]/g, '')
    .replace(/[^а-яА-ЯёЁa-zA-Z0-9_\-]/g, '')
    .substring(0, 80);
}

// ── Основная логика ──

async function main() {
  console.log('📦 Загружаю все денормализованные чанки...');

  // Получаем все чанки с тегом "денормализовано" и без parent_group_key
  const chunks = await supabaseRPC('GET',
    'chunks?tags=cs.{денормализовано}&parent_group_key=is.null' +
    '&select=id,content,source_id,source_filename,chunk_index' +
    '&order=source_filename,chunk_index&limit=5000'
  );

  console.log(`📊 Найдено чанков без parent_group_key: ${chunks.length}`);

  if (chunks.length === 0) {
    console.log('✅ Все чанки уже имеют parent_group_key. Завершаю.');
    return;
  }

  // Группируем по source_filename
  const bySource = new Map();
  for (const chunk of chunks) {
    const key = chunk.source_filename;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(chunk);
  }

  console.log(`📁 Файлов-источников: ${bySource.size}`);

  // Для каждого файла определяем parent_group_key
  const updates = []; // { id, parent_group_key }

  for (const [sourceFile, fileChunks] of bySource) {
    const sourceKey = normalizeKey(sourceFile.replace(/\.\w+$/, ''));

    // Пытаемся выделить подгруппы по таблицам внутри файла
    const subGroups = new Map(); // tableKey → chunk ids

    for (const chunk of fileChunks) {
      const tableKey = extractTableKey(chunk.content);
      const fullKey = tableKey
        ? `${sourceKey}::${normalizeKey(tableKey)}`
        : `${sourceKey}::общий`;

      if (!subGroups.has(fullKey)) subGroups.set(fullKey, []);
      subGroups.get(fullKey).push(chunk.id);

      updates.push({ id: chunk.id, parent_group_key: fullKey });
    }

    // Логируем подгруппы для этого файла
    for (const [gk, ids] of subGroups) {
      console.log(`  ${gk}: ${ids.length} чанков`);
    }
  }

  console.log(`\n🔄 Обновляю ${updates.length} чанков батчами по ${BATCH_SIZE}...`);

  // Обновляем батчами
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);

    // Supabase REST API не поддерживает bulk update по разным значениям,
    // поэтому группируем по parent_group_key и обновляем каждую группу
    const byKey = new Map();
    for (const u of batch) {
      if (!byKey.has(u.parent_group_key)) byKey.set(u.parent_group_key, []);
      byKey.get(u.parent_group_key).push(u.id);
    }

    for (const [pgk, ids] of byKey) {
      const idsFilter = ids.map(id => `"${id}"`).join(',');
      await supabaseRPC('PATCH',
        `chunks?id=in.(${idsFilter})`,
        { parent_group_key: pgk }
      );
      updated += ids.length;
    }

    const pct = Math.round((updated / updates.length) * 100);
    console.log(`  ✅ ${updated}/${updates.length} (${pct}%)`);

    // Rate limiting
    if (i + BATCH_SIZE < updates.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`\n✅ Готово! Обновлено чанков: ${updated}`);
  console.log('📋 Проверьте результат:');
  console.log('   SELECT parent_group_key, COUNT(*) FROM chunks');
  console.log('   WHERE parent_group_key IS NOT NULL');
  console.log('   GROUP BY parent_group_key ORDER BY count DESC;');
}

// ── Обновление sources: проставляем original_filename ──

async function backfillOriginalFilenames() {
  console.log('\n📦 Обновляю original_filename в sources...');

  const sources = await supabaseRPC('GET',
    'sources?mime_type=eq.application/x-denormalized' +
    '&original_filename=is.null' +
    '&select=id,filename,folder_path'
  );

  console.log(`📊 Sources без original_filename: ${sources.length}`);

  if (sources.length === 0) {
    console.log('✅ Все sources уже имеют original_filename.');
    return;
  }

  // Для денормализованных sources original_filename = filename
  // (т.к. filename уже содержит имя исходного файла)
  for (const source of sources) {
    await supabaseRPC('PATCH',
      `sources?id=eq.${source.id}`,
      { original_filename: source.filename }
    );
  }

  console.log(`✅ Обновлено ${sources.length} sources.`);
}

// ── Запуск ──

main()
  .then(() => backfillOriginalFilenames())
  .then(() => console.log('\n🎉 Backfill завершён!'))
  .catch(err => console.error('❌ Ошибка:', err));
