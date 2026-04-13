import { createServiceClient } from "./supabase.js";
import { embedQuery } from "./embeddings.js";
import { graphScopedSearch } from "./kg-search.js";
import type { IntentResult, QueryIntent } from "./intent-classifier.js";
import type { SectionReference, DocumentReference, CatalogQuery } from "./query-analyzer.js";

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
const CLIFF_RATIO = 0.6;          // Drop > 40% from previous = cut
const CLIFF_RATIO_RELAXED = 0.5;  // Drop > 50% from best = cut (relaxed mode)
const MAX_FROM_BEST_RATIO = 0.4;  // Must be >= 40% of best result's score
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

  const bestScore = sorted[0].similarity;
  const minFromBest = bestScore * MAX_FROM_BEST_RATIO;
  const filtered: SearchResult[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].similarity < SIMILARITY_THRESHOLD) break;
    if (sorted[i].similarity < sorted[i - 1].similarity * CLIFF_RATIO) break;
    // Additional guard: chunk must be at least 40% of the best result.
    // Prevents long tails of marginally-relevant chunks from leaking through
    // when scores decrease gradually (0.80, 0.78, 0.55, 0.40, 0.35...).
    if (sorted[i].similarity < minFromBest) break;
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
    entity_lookup: [],
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

/* ── Contractor card search (pre-filtered by tag "карточка контрагента") ── */

/** Helper: race a promise against a timeout (ms). Returns [] on timeout. */
function withTimeout<T>(promise: Promise<T[]>, ms: number, label: string): Promise<T[]> {
  return Promise.race([
    promise,
    new Promise<T[]>((resolve) =>
      setTimeout(() => {
        console.log(`searchContractorCards: ${label} timed out after ${ms}ms`);
        resolve([]);
      }, ms)
    ),
  ]);
}

/** Helper: generate fuzzy patterns for a keyword (single-char deletion variants).
 *  E.g. "кузбасс" → ["%кзбасс%", "%кубасс%", "%кузасс%", …, "%кузбас%"]
 *  Combined with the original "%кузбасс%" this catches most single-typo cases. */
function fuzzyPatterns(word: string): string[] {
  const patterns = [`%${word}%`];
  if (word.length >= 5) {
    // Deletion variants: remove each character one at a time
    for (let i = 0; i < word.length; i++) {
      const variant = word.slice(0, i) + word.slice(i + 1);
      patterns.push(`%${variant}%`);
    }
  }
  return patterns;
}

export async function searchContractorCards(
  query: string,
  matchCount: number = 10
): Promise<SearchResult[]> {
  const supabase = createServiceClient();

  // Step 0: INN detection — direct ILIKE bypass (numbers are invisible to FTS/embeddings)
  const innMatch = query.match(/\d{9,12}/);
  if (innMatch) {
    const inn = innMatch[0];
    console.log("searchContractorCards: detected INN =", inn);
    const { data: innData } = await supabase
      .from("chunks")
      .select("id, content, source_filename, chunk_index, tags, image_paths")
      .contains("tags", ["карточка контрагента"])
      .ilike("content", `%${inn}%`)
      .limit(matchCount);

    if (innData && innData.length > 0) {
      console.log("searchContractorCards: INN lookup found", innData.length, "results");
      return innData.map((r) => ({
        id: r.id,
        content: r.content,
        source_filename: r.source_filename,
        chunk_index: r.chunk_index,
        similarity: 0.95,
        tags: r.tags ?? [],
        image_paths: r.image_paths ?? [],
      }));
    }
  }

  // Extract meaningful keywords (drop stopwords and generic terms)
  const STOP_WORDS = new Set([
    "услуги", "работы", "компании", "компания", "организации", "организация",
    "фирмы", "фирма", "найди", "найти", "подбери", "покажи", "какие",
    "есть", "кто", "оказывает", "выполняет", "делает", "предоставляет",
    "нужны", "нужен", "для", "при", "все", "наши", "базе", "реестре",
    "контакты", "контакт", "телефон", "номер", "email", "почта", "адрес",
    "информация", "информацию", "сведения", "данные", "расскажи", "расскажите",
    "известно", "знаешь", "проверь", "проверить", "проверка",
    "контрагент", "контрагентов", "контрагента", "контрагенты",
    "подрядчик", "подрядчиков", "подрядчики", "подрядчика",
    "карточка", "карточку", "реестр", "реестре", "спу",
    "ооо", "зао", "пао", "ипп",  // legal form prefixes — noise in ILIKE
  ]);
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[.,!?;:()«»""]/g, ""))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  console.log("searchContractorCards: keywords =", keywords);

  // Step A: ILIKE search by each keyword — run ALL keywords in parallel (not sequential)
  // Each keyword searched independently, results merged with score by match count
  if (keywords.length > 0) {
    const allResults = new Map<string, { row: any; matchCount: number }>();

    // V24: Run keyword ILIKE queries in parallel instead of sequential loop
    const keywordResults = await Promise.all(
      keywords.map((kw) =>
        supabase
          .from("chunks")
          .select("id, content, source_filename, chunk_index, tags, image_paths")
          .contains("tags", ["карточка контрагента"])
          .ilike("content", `%${kw}%`)
          .limit(30)  // V24: cap per-keyword results to prevent huge scans
          .then(({ data }) => data ?? [])
      )
    );

    for (const data of keywordResults) {
      for (const row of data) {
        const existing = allResults.get(row.id);
        if (existing) {
          existing.matchCount++;
        } else {
          allResults.set(row.id, { row, matchCount: 1 });
        }
      }
    }

    if (allResults.size > 0) {
      // Sort by number of keyword matches (desc), take top N
      const sorted = Array.from(allResults.values())
        .sort((a, b) => b.matchCount - a.matchCount)
        .slice(0, matchCount);

      console.log("searchContractorCards: ILIKE found", allResults.size, "unique results,", sorted.length, "returned");
      return sorted.map(({ row, matchCount: mc }) => ({
        id: row.id,
        content: row.content,
        source_filename: row.source_filename,
        chunk_index: row.chunk_index,
        similarity: Math.min(0.70 + mc * 0.10, 0.95), // more keyword matches = higher score
        tags: row.tags ?? [],
        image_paths: row.image_paths ?? [],
      }));
    }

    // V24: Step A2 — Fuzzy ILIKE search (catches single-char typos like "кзбспожсрвс")
    // Only triggers when exact ILIKE returned nothing — generates deletion-variant patterns
    console.log("searchContractorCards: exact ILIKE empty, trying fuzzy patterns");
    const fuzzyResults = new Map<string, { row: any; matchCount: number }>();

    // Build fuzzy queries: for each keyword generate deletion variants, run in parallel
    const fuzzyQueries: Promise<any[]>[] = [];
    for (const kw of keywords) {
      const patterns = fuzzyPatterns(kw);
      // Skip the first pattern (exact match, already tried) — only deletion variants
      for (const pat of patterns.slice(1)) {
        fuzzyQueries.push(
          Promise.resolve(
            supabase
              .from("chunks")
              .select("id, content, source_filename, chunk_index, tags, image_paths")
              .contains("tags", ["карточка контрагента"])
              .ilike("content", pat)
              .limit(10)
              .then(({ data }: { data: any }) => data ?? [])
          )
        );
      }
    }

    if (fuzzyQueries.length > 0) {
      const fuzzyBatch = await withTimeout(
        Promise.all(fuzzyQueries).then((arrays) => arrays.flat()),
        8000,
        "fuzzy ILIKE"
      );

      for (const row of fuzzyBatch) {
        const existing = fuzzyResults.get(row.id);
        if (existing) {
          existing.matchCount++;
        } else {
          fuzzyResults.set(row.id, { row, matchCount: 1 });
        }
      }

      if (fuzzyResults.size > 0) {
        const sorted = Array.from(fuzzyResults.values())
          .sort((a, b) => b.matchCount - a.matchCount)
          .slice(0, matchCount);

        console.log("searchContractorCards: fuzzy ILIKE found", fuzzyResults.size, "unique results,", sorted.length, "returned");
        return sorted.map(({ row, matchCount: mc }) => ({
          id: row.id,
          content: row.content,
          source_filename: row.source_filename,
          chunk_index: row.chunk_index,
          similarity: Math.min(0.60 + mc * 0.08, 0.85), // lower confidence for fuzzy
          tags: row.tags ?? [],
          image_paths: row.image_paths ?? [],
        }));
      }
    }
  }

  // Step B: FTS with OR logic (broader than AND)
  if (keywords.length > 0) {
    const ftsQuery = keywords.join(" | ");
    const { data: ftsData } = await supabase
      .from("chunks")
      .select("id, content, source_filename, chunk_index, tags, image_paths")
      .contains("tags", ["карточка контрагента"])
      .textSearch("fts", ftsQuery, { type: "plain" })
      .limit(matchCount);

    if (ftsData && ftsData.length > 0) {
      console.log("searchContractorCards: FTS(OR) found", ftsData.length, "results");
      return ftsData.map((r) => ({
        id: r.id,
        content: r.content,
        source_filename: r.source_filename,
        chunk_index: r.chunk_index,
        similarity: 0.75,
        tags: r.tags ?? [],
        image_paths: r.image_paths ?? [],
      }));
    }
  }

  // Step C: fallback to hybrid search with tag filter
  // V24: wrap in 15s timeout to prevent blocking the entire request
  console.log("searchContractorCards: ILIKE+FTS empty, falling back to hybrid search");
  return withTimeout(
    hybridSearch(query, matchCount, ["карточка контрагента"]),
    15000,
    "hybrid fallback"
  );
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

/* ── Graph-Aware Search ── */

/**
 * Комбинирует результаты графа знаний с обычным гибридным поиском.
 * 1. Параллельно: graphScopedSearch + hybridSearch
 * 2. Чанки из графа ищутся через hybrid_search_scoped (scoped по chunk_id)
 * 3. Результаты графа получают бонус +0.15 к similarity
 * 4. Graceful fallback: если граф пуст или RPC недоступен — обычный поиск
 */
export async function graphAwareSearch(
  query: string,
  matchCount: number = 20,
  filterTags: string[] | null = null
): Promise<SearchResult[]> {
  const supabase = createServiceClient();

  const [graphResult, standardResults] = await Promise.all([
    graphScopedSearch(query, matchCount).catch(() => ({
      chunkIds: [] as number[],
      hasGraphResults: false,
    })),
    hybridSearch(query, matchCount, filterTags),
  ]);

  if (!graphResult.hasGraphResults || graphResult.chunkIds.length === 0) {
    console.log(`[graphAwareSearch] No graph results, falling back to standard (${standardResults.length} results)`);
    return standardResults;
  }

  console.log(`[graphAwareSearch] Graph returned ${graphResult.chunkIds.length} scoped chunk_ids`);

  // Scoped search по чанкам из графа
  let graphChunkResults: SearchResult[] = [];
  try {
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    const { data, error } = await supabase.rpc("hybrid_search_scoped", {
      query_text: query,
      query_embedding: embeddingStr,
      p_chunk_ids: graphResult.chunkIds,
      match_count: matchCount,
    });

    if (!error && data) {
      graphChunkResults = (data as SearchResult[]).map((r) => ({
        ...r,
        image_paths: r.image_paths ?? [],
      }));
    }
  } catch (err) {
    console.error("graphAwareSearch scoped search error:", err);
  }

  // Объединить: чанки из графа с бонусом + стандартные
  const GRAPH_BONUS = 0.15;
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of graphChunkResults) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push({ ...r, similarity: Math.min(r.similarity + GRAPH_BONUS, 1.0) });
    }
  }

  for (const r of standardResults) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push(r);
    }
  }

  merged.sort((a, b) => b.similarity - a.similarity);

  console.log(
    `graphAwareSearch: graph=${graphChunkResults.length}, standard=${standardResults.length}, merged=${merged.length}`
  );

  return merged.slice(0, matchCount);
}
