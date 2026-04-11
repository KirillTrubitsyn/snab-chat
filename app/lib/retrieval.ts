import { createServiceClient } from "./supabase";
import { embedQuery } from "./embeddings";
import type { IntentResult, QueryIntent } from "./intent-classifier";
import type { SectionReference, DocumentReference, CatalogQuery } from "./query-analyzer";

/** Escape special regex characters to prevent ReDoS and syntax errors */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchResult {
  id: string;
  content: string;
  source_filename: string;
  chunk_index: number;
  similarity: number;
  tags: string[];
  image_paths: string[];  // NEW: paths to images in chunk-images bucket
}

/* ── Relevance filtering constants ── */
const SIMILARITY_THRESHOLD = 0.35;
const CLIFF_RATIO = 0.6;
const CLIFF_RATIO_RELAXED = 0.5;
const MAX_CHUNKS = 15;
const MIN_CHUNKS_BEFORE_RELAX = 3;

export interface FilteredSearchResult {
  results: SearchResult[];
  lowConfidence: boolean;
}

export function filterByRelevance(results: SearchResult[]): FilteredSearchResult {
  if (results.length === 0) {
    return { results: [], lowConfidence: true };
  }

  const sorted = [...results].sort((a, b) => b.similarity - a.similarity);

  if (sorted[0].similarity < SIMILARITY_THRESHOLD) {
    return { results: [sorted[0]], lowConfidence: true };
  }

  const filtered: SearchResult[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].similarity < SIMILARITY_THRESHOLD) break;
    if (sorted[i].similarity < sorted[i - 1].similarity * CLIFF_RATIO) break;
    if (filtered.length >= MAX_CHUNKS) break;
    filtered.push(sorted[i]);
  }

  // If too few chunks passed strict filtering, retry with relaxed cliff ratio
  if (filtered.length < MIN_CHUNKS_BEFORE_RELAX && sorted.length > filtered.length) {
    for (let i = filtered.length; i < sorted.length; i++) {
      if (sorted[i].similarity < SIMILARITY_THRESHOLD) break;
      if (sorted[i].similarity < sorted[0].similarity * CLIFF_RATIO_RELAXED) break;
      if (filtered.length >= MAX_CHUNKS) break;
      filtered.push(sorted[i]);
    }
  }

  return { results: filtered, lowConfidence: false };
}

/* ── Tier-weighted reranking ── */

const TIER_WEIGHTS: Record<string, number> = {
  "законодательство": 1.25,
  "положения":        1.15,
  "стандарт":         1.10,
  "223-фз":           1.10,
  "вне 223-фз":       1.10,
  "методика":         1.05,
  "матрица полномочий": 1.05,
  "инструкции":       1.00,
  "ценообразование":  1.00,
  "договоры":         1.00,
  "реестр":           0.95,
  "справочники":      0.90,
  "форма":            0.90,
  "денормализовано":   1.00,
  "обучение":          1.05,
};

export function intentAwareRerank(
  results: SearchResult[],
  intent: IntentResult
): SearchResult[] {
  let working = [...results];

  if (intent.fz_type === "223" || intent.fz_type === "non-223") {
    const targetTag = intent.fz_type === "223" ? "223-фз" : "вне 223-фз";
    const oppositeTag = intent.fz_type === "223" ? "вне 223-фз" : "223-фз";

    working = working.map((r) => {
      if (r.tags.includes(targetTag)) {
        return { ...r, similarity: r.similarity * 1.15 };
      }
      if (r.tags.includes(oppositeTag)) {
        return { ...r, similarity: r.similarity * 0.85 };
      }
      return r;
    });
  }

  const INTENT_BOOST_TAGS: Partial<Record<QueryIntent, string[]>> = {
    pricing: ["ценообразование"],
    authority: ["матрица полномочий"],
    regulation: ["законодательство"],
    contract: ["договоры"],
    spu_search: ["реестр", "контрагенты", "карточка контрагента"],
    procedure: ["обучение"],
  };
  const boostTags = INTENT_BOOST_TAGS[intent.intent];
  if (boostTags) {
    working = working.map((r) => {
      const hasBoostTag = boostTags.some((t) => r.tags.includes(t));
      return hasBoostTag ? { ...r, similarity: r.similarity * 1.10 } : r;
    });
  }

  console.log("intentAwareRerank:", {
    intent: intent.intent,
    fz_type: intent.fz_type,
    confidence: intent.confidence,
    inputCount: results.length,
  });

  return tierWeightedRerank(working);
}

export function tierWeightedRerank(results: SearchResult[]): SearchResult[] {
  return results
    .map((r) => {
      let bestWeight = 1.0;
      for (const tag of r.tags) {
        const w = TIER_WEIGHTS[tag.toLowerCase()];
        if (w !== undefined && w > bestWeight) bestWeight = w;
      }
      return { ...r, similarity: r.similarity * bestWeight };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

/* ── Query variant generation ── */

function generateQueryVariants(query: string): string[] {
  const variants: string[] = [query];
  const lower = query.toLowerCase();

  const hasAmount = /\d+[\s,.]*(млн|миллион|тыс|тысяч|руб)/i.test(query);
  const hasProcurement = /закупк|согласов|утвержд|полномоч|одобр|решени|подпис/i.test(lower);

  if (hasAmount && hasProcurement) {
    variants.push(
      "матрица полномочий уполномоченный руководитель лимит закупка согласование ЗКО коллегиальный орган"
    );
  }

  if (/кто (согласов|утвержда|одобря|подписыва|принимает решени|должен)/i.test(lower)) {
    variants.push(
      "матрица полномочий закупочный коллегиальный орган уполномоченный руководитель полномочия"
    );
  }

  if (/лимит|порог|сумм[аы]|стоимост|предел|свыше|больше|более|до \d/i.test(lower) && hasProcurement) {
    variants.push(
      "лимит млн руб МТР централизованные децентрализованные услуги работы ПИР единственный источник"
    );
  }

  if (/комисси|коллегиальн|зко|цзк/i.test(lower)) {
    variants.push(
      "закупочная комиссия коллегиальный орган ЗКО ЦЗК полномочия состав"
    );
  }

  if (/коэффициент.*смет|смет.*коэффициент|превышен.*смет/i.test(lower)) {
    variants.push(
      "коэффициент к смете более 1 ЦЗК центральная закупочная комиссия рассмотрение работы услуги"
    );
  }

  return variants;
}

/* ── Core hybrid search (updated: image_paths in result) ── */

export async function hybridSearch(
  query: string,
  matchCount: number = 20,
  filterTags: string[] | null = null
): Promise<SearchResult[]> {
  const supabase = createServiceClient();
  const queryEmbedding = await embedQuery(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  // Normalize filter tags to lowercase for consistent matching
  const normalizedTags = filterTags
    ? filterTags.map((t) => t.toLowerCase())
    : null;

  console.log("hybrid_search: query =", query.slice(0, 100), "tags =", normalizedTags);

  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: matchCount,
    vector_weight: 0.7,
    fts_weight: 0.3,
    filter_tags: normalizedTags,
  });

  if (error) {
    console.error("hybrid_search error:", error);
    return [];
  }

  // Ensure image_paths is always an array (backward compat with old chunks)
  const results: SearchResult[] = (data ?? []).map(
    (row: SearchResult & { image_paths?: string[] | null }) => ({
      ...row,
      image_paths: row.image_paths ?? [],
    })
  );

  console.log("hybrid_search: results =", results.length);
  return results;
}

/* ── Contractor card search (bypasses pgvector index filtering issue) ── */

/**
 * Dedicated search for contractor cards.
 * The pgvector HNSW index scans ALL chunks for nearest neighbors,
 * then applies the tag filter — so filtered results are often empty.
 * This function uses a dedicated RPC (with CTE-based pre-filtering)
 * or falls back to FTS + cosine similarity computed in the app.
 */
export async function searchContractorCards(
  query: string,
  matchCount: number = 20
): Promise<SearchResult[]> {
  const supabase = createServiceClient();
  const queryEmbedding = await embedQuery(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  console.log("searchContractorCards: query =", query.slice(0, 100));

  // Try dedicated RPC first (requires migration)
  const { data: rpcData, error: rpcError } = await supabase.rpc(
    "search_contractor_cards",
    {
      query_text: query,
      query_embedding: embeddingStr,
      match_count: matchCount,
    }
  );

  if (!rpcError && rpcData && rpcData.length > 0) {
    console.log("searchContractorCards: RPC returned", rpcData.length, "results");
    return (rpcData as SearchResult[]).map((r) => ({
      ...r,
      image_paths: r.image_paths ?? [],
    }));
  }

  if (rpcError) {
    console.log("searchContractorCards: RPC unavailable, using FTS+vector fallback");
  }

  // Fallback: FTS + multi-word ILIKE search within contractor cards,
  // then compute cosine similarity in the app.

  // Filter out generic procurement stopwords that won't appear in card content.
  const CONTRACTOR_STOPWORDS = new Set([
    "подрядчик", "подрядчика", "подрядчики", "подрядчиков",
    "контрагент", "контрагента", "контрагенты", "контрагентов",
    "поставщик", "поставщика", "поставщики", "поставщиков",
    "исполнитель", "исполнителя", "исполнители",
    "компания", "компании", "компанию", "организация", "организации",
    "фирма", "фирмы", "фирму",
    "подбери", "подбор", "найди", "найти", "поиск",
    "выполняет", "выполняют", "делает", "делают", "оказывает",
    "занимается", "занимаются", "знаешь", "известно", "какие",
    "какой", "какая", "работы", "работ", "услуги", "услуг",
    "что", "кто", "чем", "про", "для", "как", "все",
  ]);

  const cleanQuery = query.replace(/[?!.,;:()«»"']/g, "");
  const allWords = cleanQuery.split(/\s+/).filter((w) => w.length >= 3);
  const searchWords = allWords.filter(
    (w) => !CONTRACTOR_STOPWORDS.has(w.toLowerCase())
  );

  // If all words were stopwords, use the original words sorted by length desc
  const wordsForSearch = searchWords.length > 0
    ? searchWords
    : allWords.sort((a, b) => b.length - a.length).slice(0, 3);

  console.log("searchContractorCards: search words =", wordsForSearch.join(", "));

  // Step A: FTS search using ONLY the meaningful words (not full query)
  // Full query FTS uses AND semantics, so "подрядчик AND теплоизоляция"
  // would fail because "подрядчик" is not in card content.
  const ftsQuery = wordsForSearch.join(" ");
  const ftsPromises = wordsForSearch.slice(0, 3).map((word) =>
    supabase
      .from("chunks")
      .select("id, content, source_filename, chunk_index, tags, image_paths, embedding")
      .contains("tags", ["карточка контрагента"])
      .textSearch("fts", word, { type: "plain", config: "russian" })
      .limit(matchCount * 2)
  );

  // Step B: ILIKE search using stem-truncated words
  // Russian morphology: cut last 2-3 chars to approximate stem
  // "теплоизоляцию" → "теплоизоляц" matches "теплоизоляционные"
  function approximateStem(word: string): string {
    if (word.length <= 4) return word;
    // For words ending in common Russian suffixes, trim more aggressively
    if (/[аеёиоуыэюя]$/i.test(word)) return word.slice(0, -1);
    return word;
  }

  const ilikePromises = wordsForSearch.slice(0, 4).map((word) => {
    const stem = approximateStem(word);
    return supabase
      .from("chunks")
      .select("id, content, source_filename, chunk_index, tags, image_paths, embedding")
      .contains("tags", ["карточка контрагента"])
      .ilike("content", `%${stem}%`)
      .limit(matchCount * 2);
  });

  // Step C: filename search — card filenames contain the company name
  // e.g. "ТК АВТОПЛЮС, ООО.xlsx" → search by each meaningful word in filename
  const filenamePromises = wordsForSearch.slice(0, 4).map((word) => {
    const stem = approximateStem(word);
    return supabase
      .from("chunks")
      .select("id, content, source_filename, chunk_index, tags, image_paths, embedding")
      .contains("tags", ["карточка контрагента"])
      .ilike("source_filename", `%${stem}%`)
      .limit(matchCount * 2);
  });

  const [ftsResults, ilikeResults, filenameResults] = await Promise.all([
    Promise.all(ftsPromises),
    Promise.all(ilikePromises),
    Promise.all(filenamePromises),
  ]);

  // Merge FTS + all ILIKE results (dedup by id)
  type ChunkRow = { id: string; content: string; source_filename: string; chunk_index: number; tags: string[]; image_paths: string[] | null; embedding: string | number[] | null };
  const allChunks = new Map<string, ChunkRow>();
  for (const { data } of ftsResults) {
    for (const row of (data ?? [])) {
      if (!allChunks.has(row.id)) {
        allChunks.set(row.id, row as ChunkRow);
      }
    }
  }
  for (const { data } of ilikeResults) {
    for (const row of (data ?? [])) {
      if (!allChunks.has(row.id)) {
        allChunks.set(row.id, row as ChunkRow);
      }
    }
  }
  for (const { data } of filenameResults) {
    for (const row of (data ?? [])) {
      if (!allChunks.has(row.id)) {
        allChunks.set(row.id, row as ChunkRow);
      }
    }
  }

  if (allChunks.size === 0) {
    console.log("searchContractorCards: no results from FTS/ILIKE fallback");
    return [];
  }

  // Compute cosine similarity in the app
  function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
  }

  const results: SearchResult[] = [];
  for (const [, row] of allChunks) {
    let similarity = 0.5; // default if no embedding
    if (row.embedding) {
      const chunkEmb: number[] = typeof row.embedding === "string"
        ? JSON.parse(row.embedding)
        : row.embedding;
      similarity = cosineSimilarity(queryEmbedding, chunkEmb);
    }
    results.push({
      id: row.id,
      content: row.content,
      source_filename: row.source_filename,
      chunk_index: row.chunk_index,
      similarity,
      tags: row.tags ?? [],
      image_paths: row.image_paths ?? [],
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  console.log(
    "searchContractorCards: fallback returned",
    results.length,
    "results, top sim =",
    results[0]?.similarity?.toFixed(4) ?? "N/A"
  );

  return results.slice(0, matchCount);
}

/* ── Multi-query search ── */

export async function multiQuerySearch(
  query: string,
  matchCount: number = 20,
  filterTags: string[] | null = null
): Promise<SearchResult[]> {
  const variants = generateQueryVariants(query);

  if (variants.length === 1) {
    return hybridSearch(query, matchCount, filterTags);
  }

  const allResults = await Promise.all(
    variants.map((v) => hybridSearch(v, matchCount, filterTags))
  );

  const merged = new Map<string, SearchResult>();
  for (const results of allResults) {
    for (const r of results) {
      const existing = merged.get(r.id);
      if (!existing || r.similarity > existing.similarity) {
        merged.set(r.id, r);
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.similarity - a.similarity);
}

/* ── Intent-aware search ── */

export async function intentAwareSearch(
  query: string,
  intent: IntentResult,
  matchCount: number = 20
): Promise<SearchResult[]> {
  const tagSet = new Set<string>(intent.search_tags);

  if (intent.fz_type === "223") tagSet.add("223-фз");
  if (intent.fz_type === "non-223") tagSet.add("вне 223-фз");

  const INTENT_TAG_MAP: Partial<Record<QueryIntent, string[]>> = {
    pricing: ["ценообразование"],
    authority: ["матрица полномочий"],
    regulation: ["законодательство"],
    contract: ["договоры"],
    system: ["инструкции"],
    spu_search: ["реестр", "контрагенты", "карточка контрагента"],
  };
  const extraTags = INTENT_TAG_MAP[intent.intent];
  if (extraTags) extraTags.forEach((t) => tagSet.add(t));

  const filterTags =
    tagSet.size > 0 && intent.fz_type !== "both"
      ? Array.from(tagSet)
      : null;

  const variantSet = new Set<string>([query]);
  intent.query_variants.forEach((v) => variantSet.add(v));
  generateQueryVariants(query).forEach((v) => variantSet.add(v));
  const variants = Array.from(variantSet);

  console.log("intentAwareSearch:", {
    intent: intent.intent,
    fz_type: intent.fz_type,
    filterTags,
    variantCount: variants.length,
  });

  const allResults = await Promise.all(
    variants.map((v) => hybridSearch(v, matchCount, filterTags))
  );

  const totalResults = allResults.reduce((sum, r) => sum + r.length, 0);
  if (totalResults < 3 && filterTags && filterTags.length > 0) {
    console.log(
      "intentAwareSearch: too few results with tags, retrying unfiltered"
    );
    const unfilteredResults = await Promise.all(
      variants.map((v) => hybridSearch(v, matchCount, null))
    );
    allResults.push(...unfilteredResults);
  }

  const merged = new Map<string, SearchResult>();
  for (const results of allResults) {
    for (const r of results) {
      const existing = merged.get(r.id);
      if (!existing || r.similarity > existing.similarity) {
        merged.set(r.id, r);
      }
    }
  }

  const reranked = tierWeightedRerank(Array.from(merged.values()));

  console.log(
    "intentAwareSearch: merged =",
    merged.size,
    "→ top score =",
    reranked[0]?.similarity?.toFixed(4) ?? "N/A"
  );

  return reranked;
}

/* ── Section-aware direct chunk lookup ── */

/**
 * Fetches chunks from a specific document that contain a given section number.
 * This bypasses embedding search and uses direct text matching,
 * solving the problem where "пункт 61" has weak semantic similarity
 * to the actual content of section 61.
 */
export async function fetchChunksBySection(
  ref: SectionReference,
  maxChunks: number = 6
): Promise<SearchResult[]> {
  const supabase = createServiceClient();

  // Build filename filter if document hint is provided
  let query = supabase
    .from("chunks")
    .select("id, content, source_filename, chunk_index, tags, image_paths");

  if (ref.documentHint) {
    query = query.ilike("source_filename", `%${ref.documentHint}%`);
  }

  // We fetch more chunks then filter in JS for section number presence
  // because OR-ing many ILIKE patterns in Supabase is cumbersome
  const { data, error } = await query
    .order("chunk_index", { ascending: true })
    .limit(200);

  if (error) {
    console.error("fetchChunksBySection error:", error);
    return [];
  }

  if (!data || data.length === 0) return [];

  // Filter chunks that actually contain the section reference
  const sectionRegexes = ref.sections.map((s) => {
    const escaped = escapeRegExp(s);
    // Match: "61." "61 " "Пункт 61" at various positions
    return new RegExp(
      `(?:^|\\n|\\s)${escaped}[\\.\\s\\)]|` +        // "61." or "61 " or "61)" at boundaries
      `(?:пункт|п\\.|раздел|статья|ст\\.|глава|часть|приложение)\\s*${escaped}\\b`,
      "im"
    );
  });

  interface ChunkRow {
    id: string;
    content: string;
    source_filename: string;
    chunk_index: number;
    tags: string[] | null;
    image_paths: string[] | null;
  }

  const matched = (data as ChunkRow[]).filter((chunk) =>
    sectionRegexes.some((re) => re.test(chunk.content))
  );

  if (matched.length === 0) {
    console.log("fetchChunksBySection: no chunks matched for sections", ref.sections);
    return [];
  }

  // Return as SearchResult with a synthetic high similarity score
  // so these results survive relevance filtering
  const results: SearchResult[] = matched.slice(0, maxChunks).map((chunk: ChunkRow) => ({
    id: chunk.id,
    content: chunk.content,
    source_filename: chunk.source_filename,
    chunk_index: chunk.chunk_index,
    similarity: 0.85, // synthetic score — high enough to pass threshold
    tags: chunk.tags ?? [],
    image_paths: chunk.image_paths ?? [],
  }));

  console.log(
    `fetchChunksBySection: found ${results.length} chunks for sections [${ref.sections.join(", ")}]` +
    (ref.documentHint ? ` in docs matching "${ref.documentHint}"` : "")
  );

  return results;
}

/* ── Document-aware direct chunk lookup ── */

/**
 * Fetches chunks from a specific document referenced by name.
 * When searchQuery is provided, ranks chunks by keyword relevance to the query.
 * Otherwise returns representative chunks (first + evenly spaced).
 */
export async function fetchChunksByDocument(
  ref: DocumentReference,
  maxChunks: number = 8,
  searchQuery?: string
): Promise<SearchResult[]> {
  const supabase = createServiceClient();

  // First, find matching source filenames
  // Use OR logic: each hint matches independently, so multi-entity queries
  // like ["етгк", "кузбасс", "нтск"] find files for each organization
  const allFilenames = new Set<string>();
  const docTypeHint = ref.documentTypeHint;

  for (const hint of ref.filenameHints) {
    // When we have a document type hint (e.g. "критерии") AND entity hints,
    // first try to find files matching BOTH type+entity (targeted search).
    // If that fails, fall back to entity-only search.
    if (docTypeHint && docTypeHint !== hint) {
      const { data: targeted } = await supabase
        .from("sources")
        .select("filename")
        .ilike("filename", `%${docTypeHint}%`)
        .ilike("filename", `%${hint}%`)
        .limit(3);

      if (targeted && targeted.length > 0) {
        for (const s of targeted) {
          allFilenames.add((s as { filename: string }).filename);
        }
        continue; // found targeted matches, skip generic search for this hint
      }
    }

    // Fallback: entity-only search
    const { data: sources, error: srcError } = await supabase
      .from("sources")
      .select("filename")
      .ilike("filename", `%${hint}%`)
      .limit(3);

    if (!srcError && sources) {
      for (const s of sources) {
        allFilenames.add((s as { filename: string }).filename);
      }
    }
  }

  if (allFilenames.size === 0) {
    console.log("fetchChunksByDocument: no matching sources for hints", ref.filenameHints, "typeHint:", docTypeHint);
    return [];
  }

  const filenames = Array.from(allFilenames);
  console.log("fetchChunksByDocument: matched sources:", filenames, "typeHint:", docTypeHint);

  // Fetch all chunks from matched documents
  const { data: chunks, error: chunkError } = await supabase
    .from("chunks")
    .select("id, content, source_filename, chunk_index, tags, image_paths")
    .in("source_filename", filenames)
    .order("chunk_index", { ascending: true });

  if (chunkError || !chunks || chunks.length === 0) {
    console.log("fetchChunksByDocument: no chunks found for", filenames);
    return [];
  }

  interface DocChunkRow {
    id: string;
    content: string;
    source_filename: string;
    chunk_index: number;
    tags: string[] | null;
    image_paths: string[] | null;
  }

  const typedChunks = chunks as DocChunkRow[];

  // Group chunks by document for fair distribution across multiple entities
  const chunksByDoc = new Map<string, DocChunkRow[]>();
  for (const chunk of typedChunks) {
    const docChunks = chunksByDoc.get(chunk.source_filename) ?? [];
    docChunks.push(chunk);
    chunksByDoc.set(chunk.source_filename, docChunks);
  }

  const numDocs = chunksByDoc.size;

  // Select chunks: distribute maxChunks evenly across documents
  let selected: DocChunkRow[];
  if (typedChunks.length <= maxChunks) {
    selected = typedChunks;
  } else if (numDocs > 1) {
    // Multi-document: allocate chunks per document proportionally
    const perDoc = Math.max(2, Math.floor(maxChunks / numDocs));
    selected = [];

    for (const [docFilename, docChunks] of chunksByDoc) {
      const docLimit = Math.min(perDoc, docChunks.length);

      if (searchQuery) {
        // Keyword scoring within this document
        const keywords = searchQuery
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .map((w) => w.replace(/[.,!?;:()]/g, ""));

        const scored = docChunks.map((chunk: DocChunkRow) => {
          const lower = chunk.content.toLowerCase();
          let score = 0;
          for (const kw of keywords) {
            const regex = new RegExp(escapeRegExp(kw), "gi");
            const matches = lower.match(regex);
            if (matches) score += matches.length;
          }
          return { chunk, score };
        });
        scored.sort((a, b) => b.score - a.score);

        const firstChunk = docChunks[0];
        const topChunks = scored
          .filter((s) => s.score > 0 && s.chunk !== firstChunk)
          .slice(0, docLimit - 1)
          .map((s) => s.chunk);

        selected.push(firstChunk, ...topChunks);

        // Pad if needed
        if (1 + topChunks.length < docLimit) {
          const ids = new Set(selected.map((c) => c.id));
          const step = Math.floor(docChunks.length / (docLimit - selected.length + 1)) || 1;
          for (let i = step; i < docChunks.length && selected.length < selected.length + docLimit - 1 - topChunks.length; i += step) {
            if (!ids.has(docChunks[i].id)) {
              selected.push(docChunks[i]);
              ids.add(docChunks[i].id);
            }
          }
        }
      } else {
        // Representative sampling within document
        selected.push(docChunks[0]);
        if (docLimit > 1 && docChunks.length > 1) {
          const step = Math.floor((docChunks.length - 1) / (docLimit - 1)) || 1;
          for (let i = step; i < docChunks.length && selected.length < selected.length + docLimit - 1; i += step) {
            selected.push(docChunks[i]);
          }
        }
      }

      console.log(`fetchChunksByDocument: ${docFilename} → ${Math.min(docLimit, docChunks.length)} chunks`);
    }
  } else if (searchQuery) {
    // Single document with keyword scoring (original logic)
    const keywords = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .map((w) => w.replace(/[.,!?;:()]/g, ""));

    const scored = typedChunks.map((chunk: DocChunkRow) => {
      const lower = chunk.content.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        const regex = new RegExp(escapeRegExp(kw), "gi");
        const matches = lower.match(regex);
        if (matches) score += matches.length;
      }
      return { chunk, score };
    });

    scored.sort((a: { score: number }, b: { score: number }) => b.score - a.score);

    const firstChunk = typedChunks[0];
    const topChunks = scored
      .filter((s: { chunk: DocChunkRow; score: number }) => s.score > 0 && s.chunk !== firstChunk)
      .slice(0, maxChunks - 1)
      .map((s: { chunk: DocChunkRow }) => s.chunk);

    selected = [firstChunk, ...topChunks];

    if (selected.length < maxChunks) {
      const selectedIds = new Set(selected.map((c: DocChunkRow) => c.id));
      const step = Math.floor(typedChunks.length / (maxChunks - selected.length + 1));
      for (let i = step; i < typedChunks.length && selected.length < maxChunks; i += step) {
        if (!selectedIds.has(typedChunks[i].id)) {
          selected.push(typedChunks[i]);
        }
      }
    }

    console.log(`fetchChunksByDocument: keyword scoring found ${topChunks.length} relevant chunks`);
  } else {
    // Single document, no query — representative sampling
    selected = [typedChunks[0]];
    const step = Math.floor((typedChunks.length - 1) / (maxChunks - 1));
    for (let i = step; i < typedChunks.length && selected.length < maxChunks; i += step) {
      selected.push(typedChunks[i]);
    }
    if (selected[selected.length - 1] !== typedChunks[typedChunks.length - 1] && selected.length < maxChunks) {
      selected.push(typedChunks[typedChunks.length - 1]);
    }
  }

  const results: SearchResult[] = selected.map((chunk: {
    id: string;
    content: string;
    source_filename: string;
    chunk_index: number;
    tags: string[] | null;
    image_paths: string[] | null;
  }) => ({
    id: chunk.id,
    content: chunk.content,
    source_filename: chunk.source_filename,
    chunk_index: chunk.chunk_index,
    similarity: docTypeHint ? 0.90 : 0.80, // targeted matches get higher score to survive reranking
    tags: chunk.tags ?? [],
    image_paths: chunk.image_paths ?? [],
  }));

  console.log(
    `fetchChunksByDocument: returning ${results.length}/${typedChunks.length} chunks from "${filenames.join(", ")}"`
  );

  return results;
}

/* ── Catalog query: one representative chunk per matching source ── */

/**
 * For "list all documents of type X" queries.
 * Finds ALL sources matching the document type hint, then returns
 * the first chunk from each source (ensuring full coverage).
 * Optionally filters by regime tag (e.g. "223-фз").
 */
export async function fetchCatalogResults(
  catalog: CatalogQuery
): Promise<SearchResult[]> {
  const supabase = createServiceClient();

  // Find all sources whose filename matches the document type hint
  const { data: sources, error: srcError } = await supabase
    .from("sources")
    .select("filename")
    .ilike("filename", `%${catalog.documentTypeHint}%`)
    .limit(50);

  if (srcError || !sources || sources.length === 0) {
    console.log(`fetchCatalogResults: no sources for hint "${catalog.documentTypeHint}"`);
    return [];
  }

  const filenames = (sources as { filename: string }[]).map((s) => s.filename);

  // Fetch first 2 chunks per source (for context)
  const { data: chunks, error: chunkError } = await supabase
    .from("chunks")
    .select("id, content, source_filename, chunk_index, tags, image_paths")
    .in("source_filename", filenames)
    .order("chunk_index", { ascending: true });

  if (chunkError || !chunks || chunks.length === 0) {
    console.log(`fetchCatalogResults: no chunks for sources ${filenames.join(", ")}`);
    return [];
  }

  interface CatalogChunkRow {
    id: string;
    content: string;
    source_filename: string;
    chunk_index: number;
    tags: string[] | null;
    image_paths: string[] | null;
  }

  // Group by source, take first chunk per source
  const bySource = new Map<string, CatalogChunkRow>();
  for (const chunk of chunks as CatalogChunkRow[]) {
    // If regime tag filter is set, check chunk tags
    if (catalog.tagFilter) {
      const chunkTags = (chunk.tags ?? []).map((t) => t.toLowerCase());
      if (!chunkTags.includes(catalog.tagFilter.toLowerCase())) continue;
    }

    // Keep only the first chunk per source (lowest chunk_index)
    if (!bySource.has(chunk.source_filename)) {
      bySource.set(chunk.source_filename, chunk);
    }
  }

  const results: SearchResult[] = Array.from(bySource.values()).map((chunk) => ({
    id: chunk.id,
    content: chunk.content,
    source_filename: chunk.source_filename,
    chunk_index: chunk.chunk_index,
    similarity: 0.88, // synthetic score — high enough to survive filtering
    tags: chunk.tags ?? [],
    image_paths: chunk.image_paths ?? [],
  }));

  console.log(
    `fetchCatalogResults: found ${results.length} sources for "${catalog.documentTypeHint}"` +
    (catalog.tagFilter ? ` (tag: ${catalog.tagFilter})` : "")
  );

  return results;
}
