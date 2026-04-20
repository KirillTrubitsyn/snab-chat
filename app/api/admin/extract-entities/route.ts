import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/app/lib/supabase';
import { embedQuery } from '@/app/lib/embeddings';
import { GoogleGenAI } from '@google/genai';
import { requireAdmin } from '@/app/lib/auth';
import { serverError } from '@/app/lib/api-helpers';
import {
  resolveOntologyForTags,
  resolveOntologyForBatch,
  buildDomainPromptAddendum,
  type DomainOntology,
} from '@/app/lib/kg-ontologies';

// ============================================================
// POST /api/admin/extract-entities
// Batch-извлечение сущностей и связей из чанков через Gemini 3 Flash.
// Параметры body:
//   filterTags?: string[]            — теги для фильтрации. По умолчанию берётся
//                                      preset DEFAULT_FILTER_TAGS (стандарты, положения,
//                                      договоры, матрица полномочий). Передай []
//                                      для обработки ВСЕХ чанков без фильтрации.
//   batchSize?: number               — чанков за один вызов LLM (по умолчанию 5)
//   limit?: number                   — макс. чанков за один запуск (по умолчанию 50)
//   embedEntities?: boolean          — генерировать эмбеддинги для новых сущностей (по умолчанию true)
//   crossDocResolution?: boolean     — cross-document резолюция сущностей по
//                                      семантической близости эмбеддинга (по умолчанию true;
//                                      неактивно при embedEntities=false)
//   resolveSimilarityThreshold?: number
//                                    — порог cosine similarity для слияния сущностей
//                                      одного типа (по умолчанию 0.92)
// ============================================================

// Дефолтный whitelist тегов для Graph RAG extraction.
// Распространён на договоры и матрицы полномочий помимо стандартов/положений.
const DEFAULT_FILTER_TAGS = [
  'стандарт',
  'положения',
  'договоры',
  'матрица полномочий',
];

// Типы сущностей, для которых НЕЛЬЗЯ мёржить по эмбеддингу
// (идентификаторы с числовыми компонентами — путать нельзя).
const STRICT_MATCH_TYPES = new Set(['standard', 'regulation', 'threshold', 'section']);

const ENTITY_TYPES = [
  'standard',        // ГОСТ, СТО, РД, ОСТ, ТУ
  'branch',          // филиалы СГК (СГК-Алтай, ЕТГК, Кузбассэнерго и т.д.)
  'mtr_type',        // виды МТР (трубопроводная арматура, кабельная продукция и т.д.)
  'procedure',       // процедуры закупок (конкурс, аукцион, запрос котировок и т.д.)
  'system',          // информационные системы (SRM, SAP, B2B-Center и т.д.)
  'organization',    // организации, подразделения, контрагенты
  'document',        // регламенты, положения, инструкции (как ссылки на документы)
  'role',            // должности (директор по закупкам, руководитель ДЗ и т.д.)
  'threshold',       // пороговые значения (суммы, сроки, лимиты)
  'concept',         // понятия закупочной деятельности
  'regulation',      // нормативные акты (223-ФЗ, 44-ФЗ и т.д.)
  'section',         // разделы/пункты документов
  'contract_party',  // сторона договора (Заказчик / Исполнитель / Поставщик)
  'obligation',      // конкретное обязательство в договоре
  'approval_level',  // уровень согласования (1-й уровень / ЦЗК / Правление)
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
  'party_of',           // organization/role → contract_party
  'obliged_to',         // contract_party → obligation
  'penalized_by',       // obligation → threshold (штраф, неустойка)
  'approves',           // role / approval_level → procedure / threshold
  'escalates_to',       // approval_level → approval_level (эскалация)
  // B1/B2: soft-link для близких, но не идентичных сущностей (cross-doc semantic
  // match отклонён из-за несовпадения canonical_name или из-за конфликта режима
  // 223-фз vs вне 223-фз). Используется ПРОГРАММНО, не от LLM.
  'related_to',
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
- contract_party: сторона договора (Заказчик, Исполнитель, Поставщик, Подрядчик)
- obligation: конкретное обязательство в договоре (поставка, оплата, гарантия и т.д.)
- approval_level: уровень согласования из матрицы полномочий (1-й уровень, ЦЗК, Правление)

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
- party_of: организация/роль является стороной договора
- obliged_to: сторона обязуется выполнить (contract_party → obligation)
- penalized_by: обязательство обеспечено санкцией (obligation → threshold)
- approves: роль/уровень согласовывает (role/approval_level → procedure/threshold)
- escalates_to: эскалация между уровнями согласования

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
    .replace(/\bкд\b/g, 'конкурсная документация')
    .replace(/\bцзк\b/g, 'центральная закупочная комиссия')
    .replace(/\bзк\b/g, 'закупочная комиссия');
}

// B1 (recovery plan от 2026-04-20): ужесточённый safety check.
// Старая версия пропускала мёрж при любом общем токене длиной >=3 и length ratio до 2.5x,
// из-за чего «СГК-Алтай» и «СГК-Новосибирск» могли быть объединены (общий токен «сгк»),
// а «Филиал НАК Азот НМГРЭС» — с «НМГРЭС Квадра» (общий токен «нмгрэс»).
//
// Новая политика (STRICT):
//   1. Точное совпадение нормализованных имён — мёрж разрешён.
//   2. Иначе — требуем Jaccard на значимых токенах (длина >=4) >= 0.75
//      И разницу длин не более 1.5x.
//   3. Цифровые токены (номера ГОСТ/СТО/пунктов) должны совпадать все до единого.
// Этим мы почти полностью отсекаем ложные merge'ы при сохранении точных
// повторений (разные варианты написания одной и той же сущности).
//
// Если функция вернула false, но cosine similarity высокий — вызывающая сторона
// создаёт новую сущность и связь related_to вместо молчаливого объединения.
function canonicalNamesCompatible(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;

  // Жёсткий лимит по длине: 1.5x вместо прежних 2.5x.
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (shorter.length === 0) return false;
  if (longer.length / shorter.length > 1.5) return false;

  const tokenize = (s: string) =>
    s.split(/[\s\-\.,;:/()]+/).filter(Boolean);

  // Все цифровые/идентификаторные токены должны совпадать.
  // Это защита для стандартов/пунктов/номеров постановлений: «12.1.005» != «12.1.007».
  const digitLike = (t: string) => /\d/.test(t);
  const digitsA = new Set(tokenize(a).filter(digitLike));
  const digitsB = new Set(tokenize(b).filter(digitLike));
  if (digitsA.size !== digitsB.size) return false;
  for (const d of digitsA) if (!digitsB.has(d)) return false;

  // Jaccard на значимых текстовых токенах (длина >=4).
  // Порог 0.75 отсекает случаи с одним общим токеном среди нескольких разных.
  const significant = (t: string) => t.length >= 4 && !digitLike(t);
  const setA = new Set(tokenize(a).filter(significant));
  const setB = new Set(tokenize(b).filter(significant));
  if (setA.size === 0 && setB.size === 0) {
    // Оба имени состоят из очень коротких или цифровых токенов — полагаемся
    // только на цифровой чек (он уже пройден) и равенство строк (не прошло).
    return false;
  }
  const union = new Set([...setA, ...setB]);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const jaccard = union.size > 0 ? inter / union.size : 0;
  return jaccard >= 0.75;
}

// B2 (recovery plan от 2026-04-20): определение режима (223-ФЗ vs вне 223-ФЗ)
// по тегам набора чанков. Если явных тегов нет или они смешаны — возвращает null
// (режим «неопределён» → блокировку merge не применяем).
type RegimeLabel = '223' | 'non-223';
function detectRegime(tags: Array<string[] | null | undefined>): RegimeLabel | null {
  let has223 = false;
  let hasNon223 = false;
  for (const t of tags) {
    if (!t) continue;
    if (t.includes('223-фз')) has223 = true;
    if (t.includes('вне 223-фз')) hasNon223 = true;
  }
  if (has223 && !hasNon223) return '223';
  if (hasNon223 && !has223) return 'non-223';
  return null;
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
    // filterTags: undefined → preset; [] → без фильтра; массив → явный выбор.
    const filterTags: string[] = Array.isArray(body.filterTags)
      ? body.filterTags
      : DEFAULT_FILTER_TAGS;
    const batchSize: number = Math.min(body.batchSize || 5, 10);
    const limit: number = Math.min(body.limit || 50, 200);
    const embedEntities: boolean = body.embedEntities !== false;
    const crossDocResolution: boolean =
      embedEntities && body.crossDocResolution !== false;
    const resolveSimilarityThreshold: number = Math.min(
      Math.max(Number(body.resolveSimilarityThreshold) || 0.92, 0.8),
      0.99,
    );

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
    const ontologyUsage: Record<string, number> = {};

    // Группируем чанки по домену (онтологии), чтобы каждый батч получал
    // доменно-специфичный промпт и был однородным по жанру документа.
    // Чанки без совпадения ни с одной онтологией идут в группу "default".
    const chunksByDomain = new Map<string, { ontology: DomainOntology | null; list: typeof chunks }>();
    for (const c of chunks) {
      const ont = resolveOntologyForTags(c.tags);
      const key = ont?.name ?? '__default__';
      const entry = chunksByDomain.get(key);
      if (entry) entry.list.push(c);
      else chunksByDomain.set(key, { ontology: ont, list: [c] });
    }

    // 4. Обработка пачками (в каждой группе — своя онтология)
    for (const { ontology: groupOntology, list: groupChunks } of chunksByDomain.values()) {
      for (let i = 0; i < groupChunks.length; i += batchSize) {
        const batch = groupChunks.slice(i, i + batchSize);

        // Формируем контекст для LLM
        const batchText = batch.map((c, idx) =>
          `--- Чанк ${idx + 1} (файл: ${c.source_filename}) ---\n${c.content.slice(0, 6000)}`
        ).join('\n\n');

        // На случай смешанных тегов в батче — пересчитаем онтологию по голосованию.
        const batchOntology = groupOntology ?? resolveOntologyForBatch(batch);
        const domainAddendum = buildDomainPromptAddendum(batchOntology);
        const ontologyKey = batchOntology?.name ?? 'default';
        ontologyUsage[ontologyKey] = (ontologyUsage[ontologyKey] || 0) + batch.length;

        // Вызов Gemini 3 Flash
        let extraction: ExtractionResult = { entities: [], relations: [] };

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: [
                {
                  role: 'user',
                  parts: [{
                    text: `${EXTRACTION_PROMPT}${domainAddendum}\n\nТЕКСТ ДЛЯ АНАЛИЗА:\n\n${batchText}`,
                  }],
                },
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
            console.error(`Extraction error batch ${i} (domain=${ontologyKey}):`, error.message);
            break;
          }
        }

        // 5. Upsert сущностей
        const batchEntityMap = new Map<string, string>(); // name → entity_id
        let batchResolvedByEmbedding = 0;
        let batchSoftLinked = 0;
        let batchRegimeConflicts = 0;

        // B2: режим пачки (223-ФЗ / вне 223-ФЗ / неопределённо) определяется
        // по тегам исходных чанков. Если батч однороден — используется для блокировки
        // merge'ев с сущностями противоположного режима.
        const batchRegime = detectRegime(batch.map(c => c.tags));

        for (const ent of extraction.entities) {
          if (!ent.name || !ent.type || !ENTITY_TYPES.includes(ent.type)) continue;

          const canonical = normalize(ent.name);
          const cacheKey = `${canonical}::${ent.type}`;
          const chunkIds = batch.map(c => c.id);
          const sourceIds = [...new Set(batch.map(c => c.source_id))];

          // --- 5a. Точный мёрж по canonical_name + type (O(1) через кэш) ---
          if (entityCache.has(cacheKey)) {
            const existing = entityCache.get(cacheKey)!;
            await mergeIntoExisting(supabase, existing, chunkIds, sourceIds);
            batchEntityMap.set(ent.name, existing.id);
            continue;
          }

          // --- 5b. Cross-document резолюция по эмбеддингу (semantic merge) ---
          // B1/B2: кандидаты из kg_search_entities классифицируются на:
          //   • merge   — canonical совпадает и режим не конфликтует;
          //   • related — высокая cosine, но отклонено canonical-чеком или режимом;
          //                создаём связь related_to вместо слияния;
          //   • reject  — ниже порога, игнор.
          let entityId: string | null = null;
          let entityEmbedding: number[] | null = null;
          const softRelated: string[] = []; // entity_id кандидатов, не прошедших merge

          if (
            crossDocResolution &&
            !STRICT_MATCH_TYPES.has(ent.type)
          ) {
            try {
              const embedText = `${ent.name}. ${ent.description || ''}`.trim();
              entityEmbedding = await embedQuery(embedText);

              const { data: matches, error: matchErr } = await supabase.rpc('kg_search_entities', {
                query_embedding: JSON.stringify(entityEmbedding),
                match_count: 3,
                filter_types: [ent.type],
              });

              if (!matchErr && Array.isArray(matches)) {
                for (const m of matches as Array<{
                  entity_id: string;
                  canonical_name: string;
                  similarity: number;
                  source_chunk_ids: string[] | null;
                  source_ids: string[] | null;
                }>) {
                  if (m.similarity < resolveSimilarityThreshold) continue;

                  const canonicalOk = canonicalNamesCompatible(canonical, m.canonical_name);

                  // B2: определяем режим кандидата по тегам его source chunks.
                  let candidateRegime: RegimeLabel | null = null;
                  if (m.source_chunk_ids && m.source_chunk_ids.length > 0) {
                    try {
                      const { data: candChunks } = await supabase
                        .from('chunks')
                        .select('tags')
                        .in('id', m.source_chunk_ids.slice(0, 20));
                      candidateRegime = detectRegime((candChunks || []).map(c => c.tags));
                    } catch {
                      // игнорируем — candidateRegime останется null, merge не блокируется
                    }
                  }
                  const regimeConflict =
                    batchRegime !== null &&
                    candidateRegime !== null &&
                    batchRegime !== candidateRegime;

                  if (canonicalOk && !regimeConflict) {
                    const resolved = {
                      id: m.entity_id,
                      source_chunk_ids: m.source_chunk_ids || [],
                      source_ids: m.source_ids || [],
                    };
                    await mergeIntoExisting(supabase, resolved, chunkIds, sourceIds);

                    entityCache.set(`${m.canonical_name}::${ent.type}`, resolved);
                    entityCache.set(cacheKey, resolved);
                    entityId = m.entity_id;
                    batchResolvedByEmbedding++;
                    break;
                  }

                  // Merge отклонён: копим кандидата в soft-related (≤2 штуки).
                  if (softRelated.length < 2 && softRelated.indexOf(m.entity_id) === -1) {
                    softRelated.push(m.entity_id);
                  }
                  if (regimeConflict) batchRegimeConflicts++;
                }
              }
            } catch (err) {
              console.error('cross-doc resolve error for', ent.name, err);
            }
          }

          if (entityId) {
            batchEntityMap.set(ent.name, entityId);
            continue;
          }

          // --- 5c. Создание новой сущности ---
          const insertPayload: Record<string, unknown> = {
            name: ent.name,
            canonical_name: canonical,
            entity_type: ent.type,
            description: ent.description || '',
            source_chunk_ids: chunkIds,
            source_ids: sourceIds,
          };
          if (entityEmbedding) {
            insertPayload.embedding = JSON.stringify(entityEmbedding);
          }

          const { data: inserted, error: insError } = await supabase
            .from('kg_entities')
            .upsert(insertPayload, { onConflict: 'canonical_name,entity_type' })
            .select('id')
            .single();

          if (!insError && inserted) {
            entityCache.set(cacheKey, {
              id: inserted.id,
              source_chunk_ids: chunkIds,
              source_ids: sourceIds,
            });
            batchEntityMap.set(ent.name, inserted.id);
            if (!entityEmbedding) newEntityIds.push(inserted.id);
            totalEntities++;

            // B1/B2: связываем новую сущность с близкими, но отклонёнными кандидатами
            // через related_to. Это сохраняет семантическую связь в графе без
            // потери различимости двух сущностей.
            for (const targetId of softRelated) {
              if (targetId === inserted.id) continue;
              const { error: relErr } = await supabase
                .from('kg_relations')
                .insert({
                  source_entity_id: inserted.id,
                  target_entity_id: targetId,
                  relation_type: 'related_to',
                  description:
                    'Семантически близкая сущность (cross-doc); merge отклонён canonical-чеком или режимным фасетом',
                  confidence: 0.6,
                  source_chunk_id: chunkIds[0] ?? null,
                  source_id: sourceIds[0] ?? null,
                });
              if (!relErr) batchSoftLinked++;
            }
          }
        }

        if (batchResolvedByEmbedding > 0 || batchSoftLinked > 0 || batchRegimeConflicts > 0) {
          console.log(
            `[extract-entities] batch ${i} (domain=${ontologyKey}): merged=${batchResolvedByEmbedding}, soft-linked=${batchSoftLinked}, regime-conflicts=${batchRegimeConflicts}, batchRegime=${batchRegime ?? 'unknown'}`,
          );
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
        if (i + batchSize < groupChunks.length) {
          await new Promise(r => setTimeout(r, 500));
        }
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
      filterTags,
      crossDocResolution,
      resolveSimilarityThreshold,
      ontologyUsage,
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

// Утилита: добавить новые chunk_id / source_id к существующей сущности
// (обновляет БД и мутирует объект в entityCache).
async function mergeIntoExisting(
  supabase: ReturnType<typeof createServiceClient>,
  existing: { id: string; source_chunk_ids: string[]; source_ids: string[] },
  chunkIds: (string | number)[],
  sourceIds: (string | number)[],
): Promise<void> {
  const mergedChunks = [...new Set([...existing.source_chunk_ids, ...chunkIds])] as string[];
  const mergedSources = [...new Set([...existing.source_ids, ...sourceIds])] as string[];

  await supabase
    .from('kg_entities')
    .update({
      source_chunk_ids: mergedChunks,
      source_ids: mergedSources,
    })
    .eq('id', existing.id);

  existing.source_chunk_ids = mergedChunks;
  existing.source_ids = mergedSources;
}
