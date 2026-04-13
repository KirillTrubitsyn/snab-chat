import { createServiceClient } from "./supabase.js";
import { embedQuery } from "./embeddings.js";

// ============================================================
// Knowledge Graph Search — поиск и обход графа сущностей
// Backend (Railway) версия
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
  source_chunk_ids?: number[];
  source_ids?: number[];
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
  source_chunk_id: number;
}

/* ── 1. Семантический поиск сущностей ── */

export async function findEntities(
  query: string,
  topK: number = DEFAULT_TOP_K,
  entityTypes?: string[]
): Promise<KGEntity[]> {
  const supabase = createServiceClient();
  const queryEmbedding = await embedQuery(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const { data, error } = await supabase.rpc("kg_search_entities", {
    query_embedding: embeddingStr,
    match_count: topK,
    filter_types: entityTypes || null,
  });

  if (error) {
    console.error("kg_search_entities error:", error.message);
    return [];
  }

  return (data || []) as KGEntity[];
}

/* ── 2. Обход графа от стартовых сущностей ── */

export async function traverseGraph(
  entityIds: string[],
  maxHops: number = DEFAULT_MAX_HOPS,
  relationTypes?: string[]
): Promise<KGTraversalResult[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc("kg_traverse", {
    start_entity_ids: entityIds,
    max_hops: Math.min(maxHops, 3),
    filter_relation_types: relationTypes || null,
  });

  if (error) {
    console.error("kg_traverse error:", error.message);
    return [];
  }

  return (data || []) as KGTraversalResult[];
}

/* ── 3. Сбор chunk_id из сущностей (scope для поиска) ── */

export async function getScopedChunkIds(entityIds: string[]): Promise<number[]> {
  const supabase = createServiceClient();

  const { data, error } = await supabase.rpc("kg_get_scoped_chunks", {
    entity_ids: entityIds,
    max_chunks: MAX_SCOPED_CHUNKS,
  });

  if (error) {
    console.error("kg_get_scoped_chunks error:", error.message);
    return [];
  }

  return (data || []).map((r: { chunk_id: number }) => r.chunk_id);
}

/* ── 4. Полный граф-запрос: найти → обойти → собрать чанки ── */

export async function graphQuery(
  question: string,
  maxHops: number = DEFAULT_MAX_HOPS
): Promise<{
  startEntities: KGEntity[];
  connectedEntities: KGTraversalResult[];
  scopedChunkIds: number[];
}> {
  const startEntities = await findEntities(question, DEFAULT_TOP_K);

  if (startEntities.length === 0) {
    return { startEntities: [], connectedEntities: [], scopedChunkIds: [] };
  }

  const startIds = startEntities.map((e) => e.entity_id);
  const connected = await traverseGraph(startIds, maxHops);

  const allEntityIds = [
    ...startIds,
    ...connected.map((c) => c.entity_id),
  ];
  const uniqueEntityIds = [...new Set(allEntityIds)];

  const scopedChunkIds = await getScopedChunkIds(uniqueEntityIds);

  return { startEntities, connectedEntities: connected, scopedChunkIds };
}

/* ── 5. Graph-enhanced search: scoped hybrid search по чанкам из графа ── */

export async function graphScopedSearch(
  query: string,
  matchCount: number = 15
): Promise<{
  chunkIds: number[];
  hasGraphResults: boolean;
}> {
  try {
    const result = await graphQuery(query);

    if (result.scopedChunkIds.length === 0) {
      return { chunkIds: [], hasGraphResults: false };
    }

    console.log(
      `graphScopedSearch: ${result.startEntities.length} entities, ` +
      `${result.connectedEntities.length} connected, ` +
      `${result.scopedChunkIds.length} scoped chunks`
    );

    return {
      chunkIds: result.scopedChunkIds,
      hasGraphResults: true,
    };
  } catch (error) {
    console.error("graphScopedSearch error:", error);
    return { chunkIds: [], hasGraphResults: false };
  }
}
