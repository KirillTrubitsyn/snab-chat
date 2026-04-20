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
  // Новомосковская ГРЭС и её учредительный контур (филиал АО «НАК Азот», группа ЕвроХим).
  // Важно для graph-aware поиска, иначе findEntitiesByName не находит стартовый узел
  // и система опирается только на семантический поиск, который уступает предобученной
  // галлюцинации модели («Квадра»).
  new RegExp(`${B}НМГРЭС${E}`, "i"),
  new RegExp(`${B}Новомосковск(?:ая|ой|ую|ой|ая\\s+ГРЭС)?${E}`, "i"),
  new RegExp(`${B}НАК[\\s-]?Азот${E}`, "i"),
  /\bНАК\s*«?Азот»?/i,
  new RegExp(`${B}ЕвроХим${E}`, "i"),
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

/* ── 5. Graph-enhanced search: balanced multi-entity scoped search ── */

export interface GraphScopedResult {
  /** All scoped chunk_ids (unified) */
  chunkIds: number[];
  /** Per-entity-group chunk_ids for balanced retrieval */
  groups: { name: string; chunkIds: number[] }[];
  hasGraphResults: boolean;
  /**
   * Per-chunk provenance signals used by confidence/hop-weighted scoring.
   * - minHop: кратчайший путь от стартовой сущности (0 — прямое упоминание).
   * - maxConfidence: максимальная уверенность связи вдоль этого пути.
   * Chunk'и, упомянутые сразу в source_chunk_ids стартовой сущности,
   * получают (0, 1.0). Chunk'и, найденные через связь hop N,
   * получают (N, relation.confidence).
   */
  chunkSignals: Map<number, { minHop: number; maxConfidence: number }>;
}

export async function graphScopedSearch(
  query: string,
  matchCount: number = 15
): Promise<GraphScopedResult> {
  try {
    // Step 1: Find named + semantic entities
    const [semanticEntities, namedEntities] = await Promise.all([
      findEntities(query, DEFAULT_TOP_K),
      findEntitiesByName(query),
    ]);

    // Merge all entities
    const seenIds = new Set<string>();
    const allEntities: KGEntity[] = [];
    for (const e of [...namedEntities, ...semanticEntities]) {
      const eid = e.entity_id || (e as any).id;
      if (!seenIds.has(eid)) {
        seenIds.add(eid);
        allEntities.push({ ...e, entity_id: eid });
      }
    }

    if (allEntities.length === 0) {
      return { chunkIds: [], groups: [], hasGraphResults: false, chunkSignals: new Map() };
    }

    // Аккумулятор сигналов по чанкам: (minHop, maxConfidence).
    // Заполняется по мере обхода; для каждого chunk_id сохраняем лучший путь.
    const chunkSignals = new Map<number, { minHop: number; maxConfidence: number }>();
    const recordSignal = (chunkId: number | null | undefined, hop: number, confidence: number) => {
      if (chunkId == null) return;
      const prev = chunkSignals.get(chunkId);
      if (!prev) {
        chunkSignals.set(chunkId, { minHop: hop, maxConfidence: confidence });
        return;
      }
      if (hop < prev.minHop) prev.minHop = hop;
      if (confidence > prev.maxConfidence) prev.maxConfidence = confidence;
    };

    // Step 2: Group named entities by matched pattern name
    // (e.g., all "СГК-Алтай" entities in one group, all "НТСК" in another)
    const matched: string[] = [];
    for (const pattern of KNOWN_ENTITY_PATTERNS) {
      const m = query.match(pattern);
      if (m) matched.push(m[0].trim());
    }

    // Build per-group chunk_ids if we have multiple named groups
    const groups: { name: string; chunkIds: number[] }[] = [];

    if (matched.length >= 2) {
      // Multiple named entities → build separate scoped chunks per group
      const supabase = createServiceClient();

      for (const name of matched) {
        // Find entities matching this name
        const { data: nameEntities } = await supabase.rpc("kg_find_entity_by_name", {
          search_name: name,
          filter_types: null,
        });

        if (!nameEntities || nameEntities.length === 0) continue;

        const entityIds = nameEntities.map((e: any) => e.entity_id);

        // Traverse from these entities
        const connected = await traverseGraph(entityIds, DEFAULT_MAX_HOPS);
        const allIds = [...new Set([...entityIds, ...connected.map(c => c.entity_id)])];

        // Get scoped chunks for this group (graph-derived)
        const graphChunkIds = await getScopedChunkIds(allIds);

        // Supplement with filename-based discovery:
        // Query chunks whose source_filename contains the group name (case-insensitive).
        // This catches documents like "Положение_о_закупках_НТСК_ред_12.docx" that may
        // not be linked to the entity in the knowledge graph.
        // Try multiple variants: raw name, underscored, hyphenated
        const nameVariants = new Set<string>();
        nameVariants.add(name.trim());
        nameVariants.add(name.replace(/[\s-]+/g, "_"));
        nameVariants.add(name.replace(/[_\s]+/g, "-"));
        // For compound names like "СГК-Алтай", also try just the second part
        const parts = name.split(/[\s_-]+/);
        if (parts.length > 1) {
          for (const part of parts) {
            if (part.length >= 3) nameVariants.add(part);
          }
        }

        const filenameChunkIdSet = new Set<number>();
        for (const variant of nameVariants) {
          const { data: fnChunks, error: fnErr } = await supabase
            .from("chunks")
            .select("id")
            .ilike("source_filename", `%${variant}%`)
            .limit(MAX_SCOPED_CHUNKS);
          if (!fnErr && fnChunks) {
            for (const c of fnChunks as { id: number }[]) {
              filenameChunkIdSet.add(c.id);
            }
          }
        }
        const filenameChunkIds = [...filenameChunkIdSet];

        // Merge all chunk sources, deduplicate
        const chunkIdSet = new Set([...graphChunkIds, ...filenameChunkIds]);
        const chunkIds = [...chunkIdSet];

        if (chunkIds.length > 0) {
          groups.push({ name, chunkIds });
          console.log(
            `[kg] Group "${name}": ${nameEntities.length} entities, ${connected.length} connected, ` +
            `${graphChunkIds.length} graph chunks + ${filenameChunkIds.length} filename chunks = ${chunkIds.length} total`
          );
        }
      }
    }

    // Also compute unified scoped chunks (for fallback / single-entity queries)
    const startIds = allEntities.map(e => e.entity_id);
    const connected = await traverseGraph(startIds, DEFAULT_MAX_HOPS);
    const uniqueIds = [...new Set([...startIds, ...connected.map(c => c.entity_id)])];
    const allChunkIds = await getScopedChunkIds(uniqueIds);

    // Заполняем chunkSignals: стартовые сущности → hop=0, conf=1.0
    // по их source_chunk_ids; связи → hop/confidence ребра по его source_chunk_id.
    for (const e of allEntities) {
      for (const cid of e.source_chunk_ids ?? []) recordSignal(cid, 0, 1.0);
    }
    for (const c of connected) {
      recordSignal(c.source_chunk_id, c.hop, c.confidence);
    }

    console.log(
      `[kg] graphScopedSearch: ${allEntities.length} entities, ` +
      `${connected.length} connected, ${allChunkIds.length} total chunks, ` +
      `${groups.length} named groups, ${chunkSignals.size} scored chunks`
    );

    return {
      chunkIds: allChunkIds,
      groups,
      hasGraphResults: allChunkIds.length > 0,
      chunkSignals,
    };
  } catch (error) {
    console.error("graphScopedSearch error:", error);
    return { chunkIds: [], groups: [], hasGraphResults: false, chunkSignals: new Map() };
  }
}
