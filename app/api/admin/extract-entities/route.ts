import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/app/lib/supabase';
import { embedQuery } from '@/app/lib/embeddings';
import { GoogleGenAI } from '@google/genai';
import { requireAdmin } from '@/app/lib/auth';
import { serverError } from '@/app/lib/api-helpers';

// ============================================================
// POST /api/admin/extract-entities
// Batch-извлечение сущностей и связей из чанков через Gemini 3 Flash.
// Параметры body:
//   filterTags?: string[]   — теги для фильтрации (по умолчанию ['стандарт', 'положения'])
//   batchSize?: number      — чанков за один вызов LLM (по умолчанию 5)
//   limit?: number          — макс. чанков за один запуск (по умолчанию 50)
//   embedEntities?: boolean — генерировать эмбеддинги для новых сущностей (по умолчанию true)
// ============================================================

const ENTITY_TYPES = [
  'standard',      // ГОСТ, СТО, РД, ОСТ, ТУ
  'branch',        // филиалы СГК (СГК-Алтай, ЕТГК, Кузбассэнерго и т.д.)
  'mtr_type',      // виды МТР (трубопроводная арматура, кабельная продукция и т.д.)
  'procedure',     // процедуры закупок (конкурс, аукцион, запрос котировок и т.д.)
  'system',        // информационные системы (SRM, SAP, B2B-Center и т.д.)
  'organization',  // организации, подразделения, контрагенты
  'document',      // регламенты, положения, инструкции (как ссылки на документы)
  'role',          // должности (директор по закупкам, руководитель ДЗ и т.д.)
  'threshold',     // пороговые значения (суммы, сроки, лимиты)
  'concept',       // понятия закупочной деятельности
  'regulation',    // нормативные акты (223-ФЗ, 44-ФЗ и т.д.)
  'section',       // разделы/пункты документов
];

const RELATION_TYPES = [
  'defines',            // определяет (документ → понятие)
  'references',         // ссылается на (документ → документ/стандарт)
  'requires',           // требует (процедура → условие)
  'governs',            // регулирует (регламент → процедуру)
  'part_of',            // часть (раздел → документа)
  'belongs_to',         // принадлежит (подразделение → филиалу)
  'supersedes',         // заменяет (новый стандарт → старый)
  'amends',             // изменяет
  'sets_threshold',     // устанавливает порог (документ → пороговое значение)
  'restricts',          // ограничивает
  'delegates_to',       // делегирует (роль → роли)
  'requires_approval',  // требует согласования (процедура → роль)
];

const EXTRACTION_PROMPT = `Ты — эксперт по извлечению сущностей и связей из документов в области закупочной деятельности.

Извлеки из текста все именованные сущности и связи между ними.

ТИПЫ СУЩНОСТЕЙ:
- standard: стандарты (ГОСТ, СТО, РД, ОСТ, ТУ с номерами)
- branch: филиалы СГК (СГК-Алтай, ЕТГК, Кузбассэнерго, СГК-Новосибирск, НТСК и др.)
- mtr_type: виды МТР (трубопроводная арматура, кабельная продукция, запчасти и т.д.)
- procedure: процедуры закупок (конкурс, аукцион, запрос котировок, закупка у ед. поставщика и т.д.)
- system: информационные системы (SRM, SAP, B2B-Center, 1С и т.д.)
- organization: организации, подразделения, контрагенты
- document: названия документов, регламентов, положений (на которые есть ссылки)
- role: должности и роли (директор по закупкам, руководитель ДЗ, закупочная комиссия и т.д.)
- threshold: пороговые значения (суммы в рублях, сроки в днях, проценты)
- concept: ключевые понятия закупочной деятельности (НМЦД, ТЗ, КД, реестр и т.д.)
- regulation: нормативные акты (223-ФЗ, 44-ФЗ, ГК РФ и т.д.)
- section: конкретные пункты/разделы документов (п. 3.2, раздел 5 и т.д.)

ТИПЫ СВЯЗЕЙ:
- defines: определяет
- references: ссылается на
- requires: требует
- governs: регулирует
- part_of: является частью
- belongs_to: принадлежит
- supersedes: заменяет
- amends: изменяет
- sets_threshold: устанавливает порог
- restricts: ограничивает
- delegates_to: делегирует полномочия
- requires_approval: требует согласования

ПРАВИЛА:
1. Извлекай ТОЛЬКО сущности, явно упомянутые в тексте.
2. Для стандартов указывай полный номер (например, «ГОСТ 12.1.005-88», «СТО СГК 013-2021»).
3. Для порогов указывай конкретное значение (например, «500 000 руб.», «10 рабочих дней»).
4. Каждая связь должна соединять две извлечённые сущности.
5. Confidence связи: 1.0 если прямо указана в тексте, 0.8 если подразумевается контекстом.
6. Не дублируй сущности: если одно и то же понятие упомянуто в разных формах, выбери каноническую.

Верни JSON строго в формате:
{
  "entities": [
    {"name": "полное название", "type": "тип из списка", "description": "краткое описание из контекста"}
  ],
  "relations": [
    {"source": "имя сущности-источника", "target": "имя сущности-цели", "type": "тип из списка", "description": "суть связи", "confidence": 1.0}
  ]
}

Если сущностей или связей нет, верни пустые массивы.`;

// Нормализация имени сущности
function normalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/«|»|"|"/g, '')
    .replace(/\bсгк\b/g, 'сибирская генерирующая компания')
    .replace(/\bдз\b/g, 'дирекция по закупкам')
    .replace(/\bмтр\b/g, 'материально-технические ресурсы')
    .replace(/\bнмцд\b/g, 'начальная максимальная цена договора')
    .replace(/\bтз\b/g, 'техническое задание')
    .replace(/\bкд\b/g, 'конкурсная документация');
}

interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}

interface ExtractedRelation {
  source: string;
  target: string;
  type: string;
  description: string;
  confidence: number;
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const filterTags: string[] = body.filterTags || ['стандарт', 'положения'];
    const batchSize: number = Math.min(body.batchSize || 5, 10);
    const limit: number = Math.min(body.limit || 50, 200);
    const embedEntities: boolean = body.embedEntities !== false;

    const supabase = createServiceClient();
    const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

    // 1. Получить уже обработанные chunk_id
    const { data: processed } = await supabase
      .from('kg_extraction_log')
      .select('chunk_id');
    const processedIds = new Set((processed || []).map(r => r.chunk_id));

    // 2. Получить чанки с нужными тегами, ещё не обработанные
    let query = supabase
      .from('chunks')
      .select('id, content, source_id, source_filename, tags')
      .order('chunk_index', { ascending: true });

    // Фильтр по тегам: чанк должен содержать хотя бы один из filterTags
    if (filterTags.length > 0) {
      query = query.overlaps('tags', filterTags);
    }

    const { data: allChunks, error: chunksError } = await query;
    if (chunksError) throw chunksError;

    // Отфильтровать уже обработанные
    const chunks = (allChunks || [])
      .filter(c => !processedIds.has(c.id))
      .slice(0, limit);

    if (chunks.length === 0) {
      return NextResponse.json({
        message: 'Все чанки с указанными тегами уже обработаны',
        processed: 0,
        remaining: 0,
      });
    }

    // 3. Загрузить существующие сущности для дедупликации
    const { data: existingEntities } = await supabase
      .from('kg_entities')
      .select('id, canonical_name, entity_type, source_chunk_ids, source_ids');

    const entityCache = new Map<string, { id: string; source_chunk_ids: string[]; source_ids: string[] }>();
    for (const e of existingEntities || []) {
      entityCache.set(`${e.canonical_name}::${e.entity_type}`, {
        id: e.id,
        source_chunk_ids: e.source_chunk_ids || [],
        source_ids: e.source_ids || [],
      });
    }

    let totalEntities = 0;
    let totalRelations = 0;
    const newEntityIds: string[] = [];

    // 4. Обработка пачками
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      // Формируем контекст для LLM
      const batchText = batch.map((c, idx) =>
        `--- Чанк ${idx + 1} (файл: ${c.source_filename}) ---\n${c.content.slice(0, 6000)}`
      ).join('\n\n');

      // Вызов Gemini 3 Flash
      let extraction: ExtractionResult = { entities: [], relations: [] };

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [
              { role: 'user', parts: [{ text: `${EXTRACTION_PROMPT}\n\nТЕКСТ ДЛЯ АНАЛИЗА:\n\n${batchText}` }] }
            ],
            config: {
              temperature: 0.1,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json',
            },
          });

          const text = response.text || '';
          const parsed = JSON.parse(text);
          extraction = {
            entities: Array.isArray(parsed.entities) ? parsed.entities : [],
            relations: Array.isArray(parsed.relations) ? parsed.relations : [],
          };
          break;
        } catch (err: unknown) {
          const error = err as { status?: number; message?: string };
          if (error.status === 429 && attempt < 2) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
            continue;
          }
          console.error(`Extraction error batch ${i}:`, error.message);
          break;
        }
      }

      // 5. Upsert сущностей
      const batchEntityMap = new Map<string, string>(); // name → entity_id

      for (const ent of extraction.entities) {
        if (!ent.name || !ent.type || !ENTITY_TYPES.includes(ent.type)) continue;

        const canonical = normalize(ent.name);
        const cacheKey = `${canonical}::${ent.type}`;
        const chunkIds = batch.map(c => c.id);
        const sourceIds = [...new Set(batch.map(c => c.source_id))];

        if (entityCache.has(cacheKey)) {
          // Обновить: добавить новые chunk_id и source_id
          const existing = entityCache.get(cacheKey)!;
          const mergedChunks = [...new Set([...existing.source_chunk_ids, ...chunkIds])];
          const mergedSources = [...new Set([...existing.source_ids, ...sourceIds])];

          await supabase
            .from('kg_entities')
            .update({
              source_chunk_ids: mergedChunks,
              source_ids: mergedSources,
            })
            .eq('id', existing.id);

          existing.source_chunk_ids = mergedChunks;
          existing.source_ids = mergedSources;
          batchEntityMap.set(ent.name, existing.id);
        } else {
          // Создать новую сущность
          const { data: inserted, error: insError } = await supabase
            .from('kg_entities')
            .upsert({
              name: ent.name,
              canonical_name: canonical,
              entity_type: ent.type,
              description: ent.description || '',
              source_chunk_ids: chunkIds,
              source_ids: sourceIds,
            }, { onConflict: 'canonical_name,entity_type' })
            .select('id')
            .single();

          if (!insError && inserted) {
            entityCache.set(cacheKey, {
              id: inserted.id,
              source_chunk_ids: chunkIds,
              source_ids: sourceIds,
            });
            batchEntityMap.set(ent.name, inserted.id);
            newEntityIds.push(inserted.id);
            totalEntities++;
          }
        }
      }

      // 6. Вставка связей
      for (const rel of extraction.relations) {
        if (!rel.source || !rel.target || !rel.type || !RELATION_TYPES.includes(rel.type)) continue;

        const sourceId = batchEntityMap.get(rel.source)
          || entityCache.get(`${normalize(rel.source)}::${findTypeByName(extraction.entities, rel.source)}`)?.id;
        const targetId = batchEntityMap.get(rel.target)
          || entityCache.get(`${normalize(rel.target)}::${findTypeByName(extraction.entities, rel.target)}`)?.id;

        if (!sourceId || !targetId || sourceId === targetId) continue;

        const { error: relError } = await supabase
          .from('kg_relations')
          .insert({
            source_entity_id: sourceId,
            target_entity_id: targetId,
            relation_type: rel.type,
            description: rel.description || '',
            confidence: rel.confidence || 1.0,
            source_chunk_id: batch[0].id,
            source_id: batch[0].source_id,
          });

        if (!relError) totalRelations++;
      }

      // 7. Записать в лог извлечения
      const logEntries = batch.map(c => ({
        chunk_id: c.id,
        source_id: c.source_id,
        entities_count: extraction.entities.length,
        relations_count: extraction.relations.length,
      }));

      await supabase.from('kg_extraction_log').upsert(logEntries, { onConflict: 'chunk_id' });

      // Пауза между батчами (rate limiting)
      if (i + batchSize < chunks.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 8. Генерация эмбеддингов для новых сущностей
    let embeddedCount = 0;
    if (embedEntities && newEntityIds.length > 0) {
      const { data: newEnts } = await supabase
        .from('kg_entities')
        .select('id, name, description')
        .in('id', newEntityIds)
        .is('embedding', null);

      for (const ent of newEnts || []) {
        try {
          const text = `${ent.name}. ${ent.description}`.trim();
          const emb = await embedQuery(text);
          await supabase
            .from('kg_entities')
            .update({ embedding: JSON.stringify(emb) })
            .eq('id', ent.id);
          embeddedCount++;
        } catch {
          console.error(`Failed to embed entity ${ent.id}`);
        }
        // Пауза для rate limit
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // 9. Подсчёт оставшихся
    const totalRemaining = (allChunks || []).filter(c => !processedIds.has(c.id)).length - chunks.length;

    return NextResponse.json({
      processed: chunks.length,
      newEntities: totalEntities,
      newRelations: totalRelations,
      embeddedEntities: embeddedCount,
      remaining: Math.max(0, totalRemaining),
      message: totalRemaining > 0
        ? `Обработано ${chunks.length} чанков. Осталось ~${totalRemaining}. Запустите ещё раз.`
        : 'Все чанки обработаны.',
    });
  } catch (error: unknown) {
    console.error('Extract entities error:', error instanceof Error ? error.message : error);
    return serverError('Ошибка извлечения сущностей');
  }
}

// GET /api/admin/extract-entities — статистика графа
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if (auth instanceof NextResponse) return auth;

    const supabase = createServiceClient();
    const { data } = await supabase.rpc('kg_stats');
    return NextResponse.json(data?.[0] || data || {});
  } catch {
    return serverError('kg_stats RPC not found');
  }
}

// Утилита: найти тип сущности по имени в массиве extracted
function findTypeByName(entities: ExtractedEntity[], name: string): string {
  const found = entities.find(e => e.name === name);
  return found?.type || 'concept';
}
