/**
 * Document Relationships Module
 *
 * Parses metadata headers in markdown content to extract structured
 * parent-child relationships between documents, and expands search
 * results by fetching related documents from Supabase.
 *
 * Relationship schema (JSONB in sources.relationships):
 * {
 *   parent_id?: number,          // ID родительского документа
 *   parent_hint?: string,        // текстовая подсказка для поиска родителя
 *   children_ids?: number[],     // ID дочерних документов
 *   related_ids?: number[],      // ID связанных документов (двусторонняя связь)
 *   type?: string                // тип связи: "приложение", "приказ", "матрица" и т.д.
 * }
 */

import { createServiceClient } from "./supabase";
import type { SearchResult } from "./retrieval";

/* ── Types ── */

export interface DocumentRelationship {
  parent_id?: number;
  parent_hint?: string;
  children_ids?: number[];
  related_ids?: number[];
  type?: string;
}

/* ── Parse relationships from markdown metadata headers ── */

/**
 * Extracts relationship metadata from markdown content.
 * Looks for patterns like:
 *   [Документ: Приложение 1 к Приказу от 16.10.2025 № 355-од/НМГРЭС]
 *   [Применяется к: Новомосковская ГРЭС (НАК Азот / ЕвроХим)]
 *   Родительский документ: ...
 *   Денормализовано: ...
 */
export function parseRelationshipHints(
  markdown: string,
  filename: string
): { parentHint: string | null; type: string | null } {
  const lines = markdown.slice(0, 2000).split("\n");
  let parentHint: string | null = null;
  let type: string | null = null;

  for (const line of lines) {
    // [Документ: Приложение 1 к Приказу от 16.10.2025 № 355-од/НМГРЭС]
    const docMatch = line.match(
      /\[Документ:\s*(?:Приложение\s+\d+\s+к\s+)?(.+?)\]/i
    );
    if (docMatch) {
      parentHint = docMatch[1].trim();
      // Determine type from context
      if (/приложение/i.test(line)) {
        type = "приложение";
      }
    }

    // Денормализовано: filename
    const denormMatch = line.match(/Денормализовано:\s*(.+)/i);
    if (denormMatch) {
      parentHint = denormMatch[1].trim();
      type = "денормализация";
    }

    // Родительский документ: ...
    const parentMatch = line.match(/Родительский документ:\s*(.+)/i);
    if (parentMatch) {
      parentHint = parentMatch[1].trim();
    }
  }

  // Infer from filename patterns:
  // "Прил_1_(к_Приказу_НМГРЭС-355_от_16.10.2025)_..." → parent is the Приказ
  if (!parentHint) {
    const fnMatch = filename.match(
      /Прил(?:ожение)?[_\s]*\d*[_\s]*\((?:к[_\s]+)?([^)]+)\)/i
    );
    if (fnMatch) {
      parentHint = fnMatch[1].replace(/_/g, " ").trim();
      type = type || "приложение";
    }
  }

  return { parentHint, type };
}

/* ── Resolve parent hint to actual source ID ── */

export async function resolveParentByHint(
  hint: string
): Promise<number | null> {
  const supabase = createServiceClient();

  // Normalize hint: extract key identifiers (numbers, dates, org names)
  const keywords = hint
    .replace(/[_]/g, " ")
    .split(/[\s,;]+/)
    .filter((w) => w.length > 2)
    .map((w) => w.toLowerCase());

  // Fetch candidate sources and score them
  const { data: sources } = await supabase
    .from("sources")
    .select("id, filename")
    .limit(500);

  if (!sources || sources.length === 0) return null;

  let bestMatch: { id: number; score: number } | null = null;

  for (const src of sources as { id: number; filename: string }[]) {
    const fnLower = src.filename.toLowerCase().replace(/_/g, " ");
    let score = 0;
    for (const kw of keywords) {
      if (fnLower.includes(kw)) score++;
    }
    // Require at least 3 keyword matches for confidence
    if (score >= 3 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { id: src.id, score };
    }
  }

  return bestMatch?.id ?? null;
}

/* ── Expand search results by fetching related documents ── */

/**
 * After primary search, checks if found documents have relationships
 * and fetches chunks from related (parent/child) documents.
 *
 * Bidirectional: if we found a parent, fetch its children.
 * If we found a child, fetch its parent and siblings.
 */
export async function expandByRelationships(
  chunks: SearchResult[],
  searchQuery: string,
  maxExpansionChunks: number = 6
): Promise<SearchResult[]> {
  if (chunks.length === 0) return chunks;

  const supabase = createServiceClient();

  // Collect unique source filenames from search results
  const foundFilenames = [...new Set(chunks.map((c) => c.source_filename))];

  // Look up relationships for found sources
  const { data: foundSources } = await supabase
    .from("sources")
    .select("id, filename, relationships")
    .in("filename", foundFilenames);

  if (!foundSources || foundSources.length === 0) return chunks;

  // Collect IDs of candidate related documents, separated by relationship type
  const parentIds = new Set<number>(); // direct parents — always highest priority
  const childIds = new Set<number>(); // children of found docs
  const relatedIds = new Set<number>(); // explicitly linked
  const existingSourceIds = new Set(
    (foundSources as { id: number }[]).map((s) => s.id)
  );

  for (const src of foundSources as {
    id: number;
    filename: string;
    relationships: DocumentRelationship | null;
  }[]) {
    const rel = src.relationships;
    if (!rel) continue;

    // Always add parent (1 document, always relevant context)
    if (rel.parent_id && !existingSourceIds.has(rel.parent_id)) {
      parentIds.add(rel.parent_id);
    }

    // Add children only from documents that are actual parents (have children_ids)
    // This avoids pulling children from documents found by keyword coincidence
    if (rel.children_ids && rel.children_ids.length > 0) {
      for (const childId of rel.children_ids) {
        if (!existingSourceIds.has(childId)) {
          childIds.add(childId);
        }
      }
    }

    // Add related (explicitly linked, always relevant)
    if (rel.related_ids) {
      for (const relId of rel.related_ids) {
        if (!existingSourceIds.has(relId)) {
          relatedIds.add(relId);
        }
      }
    }
  }

  const candidateIds = new Set([...parentIds, ...childIds, ...relatedIds]);

  if (candidateIds.size === 0) {
    console.log("[relationships] No related documents to expand");
    return chunks;
  }

  // ── Pre-filter: score candidate sources by relevance BEFORE loading chunks ──
  // This prevents loading chunks from all 20 appendices when only 1-2 are relevant.
  const { data: candidateSources } = await supabase
    .from("sources")
    .select("id, filename, tags")
    .in("id", [...candidateIds]);

  if (!candidateSources || candidateSources.length === 0) return chunks;

  // Build query keywords for source-level filtering
  const queryLower = searchQuery.toLowerCase();
  const queryKeywords = queryLower
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map((w) => w.replace(/[.,!?;:()]/g, ""));

  // Score each candidate source by: filename keywords + tag overlap with query
  interface CandidateSource {
    id: number;
    filename: string;
    tags: string[] | null;
    relevanceScore: number;
  }

  const scoredSources: CandidateSource[] = (
    candidateSources as { id: number; filename: string; tags: string[] | null }[]
  ).map((src) => {
    let score = 0;
    const fnLower = src.filename.toLowerCase().replace(/_/g, " ");
    const tagsLower = (src.tags || []).map((t) => t.toLowerCase());

    // Score by query keyword matches in filename
    for (const kw of queryKeywords) {
      if (fnLower.includes(kw)) score += 2;
    }

    // Score by tag matches with query
    for (const tag of tagsLower) {
      if (queryLower.includes(tag)) score += 3;
      for (const kw of queryKeywords) {
        if (tag.includes(kw) || kw.includes(tag)) score += 1;
      }
    }

    // Parent documents get a very high bonus — they provide essential context
    // for any appendix found in search. Must outweigh keyword matches from
    // unrelated children (which can score 8-10 on generic terms like "схема").
    const isParent = parentIds.has(src.id);
    if (isParent) score += 20;

    // Explicitly linked via related_ids (manual curation)
    const isExplicitlyRelated = relatedIds.has(src.id);
    if (isExplicitlyRelated) score += 10;

    return { ...src, relevanceScore: score };
  });

  // Sort by relevance, take top sources.
  // Parents always get guaranteed slots, remaining filled by score.
  scoredSources.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const MAX_RELATED_SOURCES = 4;
  const guaranteedParents = scoredSources.filter((s) => parentIds.has(s.id));
  const otherCandidates = scoredSources
    .filter((s) => !parentIds.has(s.id) && s.relevanceScore > 0)
    .slice(0, MAX_RELATED_SOURCES - guaranteedParents.length);
  const relevantSources = [...guaranteedParents, ...otherCandidates].slice(
    0,
    MAX_RELATED_SOURCES
  );

  if (relevantSources.length === 0) {
    console.log(
      `[relationships] ${candidateIds.size} candidates found but none relevant to query "${searchQuery.slice(0, 60)}"`
    );
    return chunks;
  }

  const filteredIds = relevantSources.map((s) => s.id);
  console.log(
    `[relationships] Pre-filtered ${candidateIds.size} candidates → ${relevantSources.length} relevant: ${relevantSources.map((s) => `${s.id}(score=${s.relevanceScore})`).join(", ")}`
  );

  // ── Fetch chunks only from pre-filtered relevant sources ──
  const { data: relatedChunks } = await supabase
    .from("chunks")
    .select("id, content, source_filename, chunk_index, tags, image_paths")
    .in("source_id", filteredIds)
    .order("chunk_index", { ascending: true });

  if (!relatedChunks || relatedChunks.length === 0) return chunks;

  // Score related chunks by keyword relevance to the search query
  interface RelChunkRow {
    id: string;
    content: string;
    source_filename: string;
    chunk_index: number;
    tags: string[] | null;
    image_paths: string[] | null;
  }

  const scored = (relatedChunks as RelChunkRow[]).map((chunk) => {
    const lower = chunk.content.toLowerCase();
    let score = 0;
    for (const kw of queryKeywords) {
      if (lower.includes(kw)) score++;
    }
    return { chunk, score };
  });

  // Sort by relevance, take top N
  scored.sort((a, b) => b.score - a.score);

  // Always include at least first chunk per unique source (for context), plus top scoring
  const selectedChunks: RelChunkRow[] = [];
  const seenSources = new Set<string>();
  const existingChunkIds = new Set(chunks.map((c) => c.id));

  // First pass: one best chunk per related source
  for (const { chunk } of scored) {
    if (existingChunkIds.has(chunk.id)) continue;
    if (seenSources.has(chunk.source_filename)) continue;
    seenSources.add(chunk.source_filename);
    selectedChunks.push(chunk);
    existingChunkIds.add(chunk.id);
    if (selectedChunks.length >= maxExpansionChunks) break;
  }

  // Second pass: fill remaining slots with highest-scoring chunks
  if (selectedChunks.length < maxExpansionChunks) {
    for (const { chunk, score } of scored) {
      if (existingChunkIds.has(chunk.id)) continue;
      if (score === 0) break; // no point adding irrelevant chunks
      selectedChunks.push(chunk);
      existingChunkIds.add(chunk.id);
      if (selectedChunks.length >= maxExpansionChunks) break;
    }
  }

  // Convert to SearchResult with a synthetic score
  const expansionResults: SearchResult[] = selectedChunks.map((chunk) => ({
    id: chunk.id,
    content: chunk.content,
    source_filename: chunk.source_filename,
    chunk_index: chunk.chunk_index,
    similarity: 0.55, // synthetic: high enough to pass threshold, low enough to rank after direct hits
    tags: chunk.tags ?? [],
    image_paths: chunk.image_paths ?? [],
  }));

  console.log(
    `[relationships] Added ${expansionResults.length} chunks from ${seenSources.size} related documents: ${[...seenSources].join(", ")}`
  );

  return [...chunks, ...expansionResults];
}
