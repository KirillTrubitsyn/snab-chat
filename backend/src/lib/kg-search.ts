import { createServiceClient } from "./supabase.js";
import { embedQuery } from "./embeddings.js";

// ============================================================
// Knowledge Graph Search — поиск и обход графа сущностей
// Backend (Railway) версия
// ============================================================

const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_HOPS = 2;
const MAX_SCOPED_CHUNKS = 200;

/**
 * Известные именованные сущности для прямого поиска.
 * NOTE: \b в JS не работает с кириллицей, поэтому используем
 * (?:^|[\s,.(])  и  (?=$|[\s,.)]) как замену word boundary.
 */
const B = `(?:^|[\\s,.(:;«"—])`;  // начало слова (кириллица-safe)
const E = `(?=$|[\\s,.():;»"—?!])`;  // конец слова (кириллица-safe)

const KNOWN_ENTITY_PATTERNS = [
  // Филиалы / организации
  new RegExp(`${B}СГК[\\s-]?Алтай${E}`, "i"),
  new RegExp(`${B}НТСК${E}`, "i"),
  new RegExp(`${B}ЕТГК${E}`, "i"),
  new RegExp(`${B}Кузбассэнерго${E}`, "i"),
  new RegExp(`${B}СГК[\\s-]?Новосибирск${E}`, "i"),
  new RegExp(`${B}СГК${E}`, "i"),
  // Стандарты / регуляции
  new RegExp(`${B}ГОСТ\\s*[\\d.\\-]+`, "i"),
  new RegExp(`${B}223[\\s-]?ФЗ${E}`, "i"),
  new RegExp(`${B}44[\\s-]?ФЗ${E}`, "i"),
  // Системы
  /\bSAP\s*(?:ERP|SRM|SEM|MM)?\b/i,
  /\bB2B[\s-]?Center\b/i,
  // Процедуры
  /закупк[аиу]\s+у\s+единственного\s+источника/i,
  /конкурентн(?:ая|ой|ую)\s+закупк/i,
  /запрос\s+(?:котировок|предложений)/i,
  /маркетинговое\s+исследование/i,
  // Роли
  new RegExp(`${B}ДКБ${E}`, "i"),
  new RegExp(`${B}ЦЗК${E}`, "i"),
  new RegExp(`${B}ЗКО${E}`, "i"),
  /инициатор\s+закупки/i,
  /организатор\s+закупки/i,
  /комитет\s+по\s+закупкам/i,
];

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

/* ── 1b. Именной поиск: извлечь имена из запроса и найти через ILIKE ── */

export async function findEntitiesByName(query: string): Promise<KGEntity[]> {
  const supabase = createServiceClient();
  const matched: string[] = [];

  for (const pattern of KNOWN_ENTITY_PATTERNS) {
    const m = query.match(pattern);
    if (m) matched.push(m[0]);
  }

  if (matched.length === 0) return [];

  const results: KGEntity[] = [];
  const seenIds = new Set<string>();

  for (const name of matched) {
    const { data, error } = await supabase.rpc("kg_find_entity_by_name", {
      search_name: name,
      filter_types: null,
    });

    if (error) {
      console.error(`kg_find_entity_by_name error for "${name}":`, error.message);
      continue;
    }

    for (const e of (data || []) as KGEntity[]) {
      const eid = e.entity_id || (e as any).id;
      if (!seenIds.has(eid)) {
        seenIds.add(eid);
        results.push({ ...e, entity_id: eid });
      }
    }
  }

  console.log(`[kg] findEntitiesByName: query="${query}" → matched patterns: [${matched.join(", ")}] → ${results.length} entities`);
  return results;
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
  // Параллельно: семантический поиск + именной поиск
  const [semanticEntities, namedEntities] = await Promise.all([
    findEntities(question, DEFAULT_TOP_K),
    findEntitiesByName(question),
  ]);

  // Объединить, дедуплицировать
  const seenIds = new Set<string>();
  const startEntities: KGEntity[] = [];

  for (const e of [...namedEntities, ...semanticEntities]) {
    const eid = e.entity_id || (e as any).id;
    if (!seenIds.has(eid)) {
      seenIds.add(eid);
      startEntities.push({ ...e, entity_id: eid });
    }
  }

  if (startEntities.length === 0) {
    return { startEntities: [], connectedEntities: [], scopedChunkIds: [] };
  }

  console.log(`[kg] graphQuery: ${startEntities.length} start entities (${namedEntities.length} by name, ${semanticEntities.length} semantic)`);

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
      `[kg] graphScopedSearch: ${result.startEntities.length} entities, ` +
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
