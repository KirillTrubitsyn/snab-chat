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

  // Collect IDs of related documents to fetch
  const relatedIds = new Set<number>();
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

    // Add parent
    if (rel.parent_id && !existingSourceIds.has(rel.parent_id)) {
      relatedIds.add(rel.parent_id);
    }

    // Add children
    if (rel.children_ids) {
      for (const childId of rel.children_ids) {
        if (!existingSourceIds.has(childId)) {
          relatedIds.add(childId);
        }
      }
    }

    // Add related
    if (rel.related_ids) {
      for (const relId of rel.related_ids) {
        if (!existingSourceIds.has(relId)) {
          relatedIds.add(relId);
        }
      }
    }
  }

  // Also check reverse: find sources that list our found sources as parent
  const foundSourceIds = [...existingSourceIds];
  if (foundSourceIds.length > 0) {
    // Search for children that reference our found documents as parent
    // Using containedBy/contains operators via raw filter
    for (const srcId of foundSourceIds) {
      const { data: children } = await supabase
        .from("sources")
        .select("id")
        .filter("relationships->>parent_id", "eq", String(srcId))
        .limit(10);

      if (children) {
        for (const child of children as { id: number }[]) {
          if (!existingSourceIds.has(child.id)) {
            relatedIds.add(child.id);
          }
        }
      }
    }
  }

  if (relatedIds.size === 0) {
    console.log("[relationships] No related documents to expand");
    return chunks;
  }

  console.log(
    `[relationships] Expanding with ${relatedIds.size} related documents: [${[...relatedIds].join(", ")}]`
  );

  // Fetch chunks from related documents
  const { data: relatedChunks } = await supabase
    .from("chunks")
    .select("id, content, source_filename, chunk_index, tags, image_paths")
    .in("source_id", [...relatedIds])
    .order("chunk_index", { ascending: true });

  if (!relatedChunks || relatedChunks.length === 0) return chunks;

  // Score related chunks by keyword relevance to the search query
  const keywords = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .map((w) => w.replace(/[.,!?;:()]/g, ""));

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
    for (const kw of keywords) {
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

  // First pass: one chunk per related source (intro/context)
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
    `[relationships] Added ${expansionResults.length} chunks from related documents: ${[...new Set(expansionResults.map((r) => r.source_filename))].join(", ")}`
  );

  return [...chunks, ...expansionResults];
}
