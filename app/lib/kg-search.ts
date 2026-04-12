import { createServiceClient } from './supabase';
import { embedQuery } from './embeddings';

// ============================================================
// Knowledge Graph Search — поиск и обход графа сущностей
// ============================================================

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_HOPS = 2;
const MAX_SCOPED_CHUNKS = 200;

export interface KGEntity {
  entity_id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  description: string;
  similarity?: number;
  source_chunk_ids?: string[];
  source_ids?: string[];
}

export interface KGTraversalResult {
  entity_id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  description: string;
  relation_type: string;
  relation_description: string;
  confidence: number;
  hop: number;
  from_entity_id: string;
  source_chunk_id: string;
}

export interface GraphQueryResult {
  startEntities: KGEntity[];
  connectedEntities: KGTraversalResult[];
  scopedChunkIds: string[];
  totalEntities: number;
  totalHops: number;
}

// ============================================================
// 1. Семантический поиск сущностей по запросу
// ============================================================
export async function findEntities(
  query: string,
  topK: number = DEFAULT_TOP_K,
  entityTypes?: string[]
): Promise<KGEntity[]> {
  const supabase = createServiceClient();
  const queryEmbedding = await embedQuery(query);

  const { data, error } = await supabase.rpc('kg_search_entities', {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: topK,
    filter_types: entityTypes || null,
  });

  if (error) {
    console.error('kg_search_entities error:', error.message);
    return [];
  }

  return (data || []) as KGEntity[];
}

// ============================================================
// 2. Поиск сущности по точному имени
// ============================================================
export async function findEntityByName(
  name: string,
  entityTypes?: string[]
): Promise<KGEntity[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc('kg_find_entity_by_name', {
    search_name: name,
    filter_types: entityTypes || null,
  });

  if (error) {
    console.error('kg_find_entity_by_name error:', error.message);
    return [];
  }

  return (data || []) as KGEntity[];
}

// ============================================================
// 3. Обход графа от стартовых сущностей
// ============================================================
export async function traverseGraph(
  entityIds: string[],
  maxHops: number = DEFAULT_MAX_HOPS,
  relationTypes?: string[]
): Promise<KGTraversalResult[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc('kg_traverse', {
    start_entity_ids: entityIds,
    max_hops: Math.min(maxHops, 3),
    filter_relation_types: relationTypes || null,
  });

  if (error) {
    console.error('kg_traverse error:', error.message);
    return [];
  }

  return (data || []) as KGTraversalResult[];
}

// ============================================================
// 4. Сбор chunk_id из сущностей (scope для hybrid_search)
// ============================================================
export async function getScopedChunkIds(entityIds: string[]): Promise<string[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc('kg_get_scoped_chunks', {
    entity_ids: entityIds,
    max_chunks: MAX_SCOPED_CHUNKS,
  });

  if (error) {
    console.error('kg_get_scoped_chunks error:', error.message);
    return [];
  }

  // chunk_id приходит как bigint (number), приводим к string для совместимости
  return (data || []).map((r: { chunk_id: number | string }) => String(r.chunk_id));
}

// ============================================================
// 5. Полный граф-запрос: найти сущности → обойти → собрать чанки
// ============================================================
export async function graphQuery(
  question: string,
  entityName?: string,
  maxHops: number = DEFAULT_MAX_HOPS
): Promise<GraphQueryResult> {
  // Шаг 1: найти стартовые сущности
  let startEntities: KGEntity[] = [];

  if (entityName) {
    // Сначала по имени, потом семантически
    startEntities = await findEntityByName(entityName);
    if (startEntities.length === 0) {
      startEntities = await findEntities(entityName, 3);
    }
  } else {
    startEntities = await findEntities(question, DEFAULT_TOP_K);
  }

  if (startEntities.length === 0) {
    return {
      startEntities: [],
      connectedEntities: [],
      scopedChunkIds: [],
      totalEntities: 0,
      totalHops: 0,
    };
  }

  // Шаг 2: обойти граф
  const startIds = startEntities.map(e => e.entity_id);
  const connected = await traverseGraph(startIds, maxHops);

  // Шаг 3: собрать все entity_id (старт + найденные через обход)
  const allEntityIds = [
    ...startIds,
    ...connected.map(c => c.entity_id),
  ];
  const uniqueEntityIds = [...new Set(allEntityIds)];

  // Шаг 4: собрать chunk_id
  const scopedChunkIds = await getScopedChunkIds(uniqueEntityIds);

  const maxHop = connected.length > 0
    ? Math.max(...connected.map(c => c.hop))
    : 0;

  return {
    startEntities,
    connectedEntities: connected,
    scopedChunkIds,
    totalEntities: uniqueEntityIds.length,
    totalHops: maxHop,
  };
}

// ============================================================
// 6. Graph-enhanced hybrid search
//    Объединяет результаты графа с обычным hybrid_search
// ============================================================
export async function graphEnhancedSearch(
  query: string,
  matchCount: number = 20
): Promise<{
  chunkIds: string[];
  graphContext: string;
  hasGraphResults: boolean;
}> {
  try {
    const result = await graphQuery(query);

    if (result.scopedChunkIds.length === 0) {
      return { chunkIds: [], graphContext: '', hasGraphResults: false };
    }

    // Сформировать текстовый контекст графа для системного промпта
    const entityLines = result.startEntities
      .map(e => `[${e.entity_type}] ${e.name}: ${e.description}`)
      .slice(0, 5);

    const relationLines = result.connectedEntities
      .filter(c => c.confidence >= 0.7)
      .map(c => `${c.name} (${c.entity_type}) —[${c.relation_type}]→ hop ${c.hop}`)
      .slice(0, 10);

    const graphContext = [
      '=== Граф знаний ===',
      'Найденные сущности:',
      ...entityLines,
      '',
      'Связи:',
      ...relationLines,
    ].join('\n');

    return {
      chunkIds: result.scopedChunkIds.slice(0, matchCount),
      graphContext,
      hasGraphResults: true,
    };
  } catch (error) {
    console.error('graphEnhancedSearch error:', error);
    return { chunkIds: [], graphContext: '', hasGraphResults: false };
  }
}
