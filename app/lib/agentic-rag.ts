import { tool } from "ai";
import { z } from "zod";
import { hybridSearch, filterByRelevance, type SearchResult } from "./retrieval";
import { fetchChunksBySection, fetchChunksByDocument } from "./retrieval";
import { llmRerank } from "./reranker";
import type { SectionReference, DocumentReference } from "./query-analyzer";
import type { IntentResult } from "./intent-classifier";

/**
 * Agentic RAG: provides search tools to the LLM so it can decide
 * what to search, how many times, and when it has enough context.
 *
 * Used for complex queries (comparisons, multi-document, multi-regime).
 * Simple queries still use the fast deterministic pipeline.
 */

/** Accumulated chunks from all tool calls within one request */
export interface AgenticContext {
  chunks: Map<string, SearchResult>;
  searchCount: number;
}

export function createAgenticContext(): AgenticContext {
  return { chunks: new Map(), searchCount: 0 };
}

const MAX_AGENT_SEARCHES = 8;

export function createRagTools(ctx: AgenticContext) {
  return {
    search_knowledge_base: tool({
      description:
        "Поиск по базе знаний закупочных документов. Используй для поиска нормативных документов, положений, регламентов, инструкций. " +
        "Можно фильтровать по тегам: '223-фз', 'вне 223-фз', 'ценообразование', 'матрица полномочий', 'законодательство', 'договоры', 'инструкции', 'обучение', 'реестр'. " +
        "Вызывай несколько раз с разными запросами/тегами, если нужна информация из разных источников.",
      parameters: z.object({
        query: z.string().describe("Поисковый запрос на русском языке"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Фильтр по тегам документов (опционально)"),
      }),
      execute: async ({ query, tags }) => {
        if (ctx.searchCount >= MAX_AGENT_SEARCHES) {
          return { status: "limit", message: "Достигнут лимит поисковых запросов. Используй уже найденные документы для ответа." };
        }
        ctx.searchCount++;
        const filterTags = tags && tags.length > 0 ? tags : null;
        const results = await hybridSearch(query, 15, filterTags);

        let added = 0;
        for (const r of results) {
          if (!ctx.chunks.has(r.id)) {
            ctx.chunks.set(r.id, r);
            added++;
          }
        }

        const topPreviews = results.slice(0, 5).map((r, i) => ({
          i,
          file: r.source_filename,
          score: r.similarity.toFixed(3),
          preview: r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""),
          tags: r.tags,
        }));

        console.log(`[agentic] search_knowledge_base: "${query.slice(0, 60)}" tags=${JSON.stringify(filterTags)} → ${results.length} found, ${added} new`);

        return {
          status: "ok",
          found: results.length,
          new_chunks: added,
          total_accumulated: ctx.chunks.size,
          top_results: topPreviews,
        };
      },
    }),

    lookup_section: tool({
      description:
        "Прямой поиск конкретного пункта, раздела, статьи или приложения в документе. " +
        "Используй когда пользователь ссылается на конкретный номер пункта (например 'пункт 61', 'раздел 5', 'приложение 3'). " +
        "Эффективнее чем search_knowledge_base для точечных ссылок.",
      parameters: z.object({
        sections: z
          .array(z.string())
          .describe("Номера пунктов/разделов для поиска, например ['61', '61.1', '5']"),
        document_hint: z
          .string()
          .optional()
          .describe("Часть названия документа для сужения поиска, например 'положен' или 'стандарт'"),
      }),
      execute: async ({ sections, document_hint }) => {
        if (ctx.searchCount >= MAX_AGENT_SEARCHES) {
          return { status: "limit", message: "Достигнут лимит поисковых запросов." };
        }
        ctx.searchCount++;
        const ref: SectionReference = {
          sections,
          documentHint: document_hint ?? null,
        };
        const results = await fetchChunksBySection(ref);

        let added = 0;
        for (const r of results) {
          if (!ctx.chunks.has(r.id)) {
            ctx.chunks.set(r.id, r);
            added++;
          }
        }

        console.log(`[agentic] lookup_section: sections=${sections.join(",")} hint=${document_hint ?? "none"} → ${results.length} found, ${added} new`);

        return {
          status: "ok",
          found: results.length,
          new_chunks: added,
          results: results.slice(0, 4).map((r) => ({
            file: r.source_filename,
            preview: r.content.slice(0, 400) + (r.content.length > 400 ? "…" : ""),
          })),
        };
      },
    }),

    lookup_document: tool({
      description:
        "Получить содержимое конкретного документа по названию. " +
        "Используй когда пользователь упоминает конкретный документ ('Положение о закупках', 'Стандарт СГК') " +
        "или когда нужно загрузить весь документ, а не отдельные фрагменты.",
      parameters: z.object({
        filename_hints: z
          .array(z.string())
          .describe("Части названия файла для поиска, например ['положение', 'закупк'] или ['стандарт', 'СГК']"),
        query: z
          .string()
          .optional()
          .describe("Запрос для ранжирования чанков внутри документа"),
      }),
      execute: async ({ filename_hints, query }) => {
        if (ctx.searchCount >= MAX_AGENT_SEARCHES) {
          return { status: "limit", message: "Достигнут лимит поисковых запросов." };
        }
        ctx.searchCount++;
        const ref: DocumentReference = { filenameHints: filename_hints };
        const results = await fetchChunksByDocument(ref, 8, query);

        let added = 0;
        for (const r of results) {
          if (!ctx.chunks.has(r.id)) {
            ctx.chunks.set(r.id, r);
            added++;
          }
        }

        console.log(`[agentic] lookup_document: hints=${filename_hints.join(",")} → ${results.length} found, ${added} new`);

        return {
          status: "ok",
          found: results.length,
          new_chunks: added,
          filenames: [...new Set(results.map((r) => r.source_filename))],
          previews: results.slice(0, 3).map((r) => ({
            file: r.source_filename,
            chunk: r.chunk_index,
            preview: r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""),
          })),
        };
      },
    }),
  };
}

/**
 * Determine if a query is "complex" and should use the agentic path.
 * Complex queries: comparisons between regimes, multi-document questions,
 * explicit section references combined with comparisons, etc.
 */
export function isComplexQuery(
  query: string,
  intent: IntentResult
): boolean {
  const lower = query.toLowerCase();

  // 1. Comparative queries (both regimes)
  if (intent.fz_type === "both") return true;

  // 2. Explicit comparison keywords
  if (/сравни|отлича|разниц|в\s+чём\s+отличи|чем\s+отличает|различи|сопостав/i.test(lower)) {
    return true;
  }

  // 3. Multi-aspect questions (multiple question words or multiple topics)
  const questionMarkers = lower.match(/(?:как|что|кто|какой|какие|каков|где|когда|зачем|почему|сколько)\s/g);
  if (questionMarkers && questionMarkers.length >= 3) return true;

  // 4. Long complex questions with multiple clauses
  const clauses = query.split(/[,;]\s+/).length;
  if (clauses >= 4 && query.length > 150) return true;

  // 5. Questions mentioning multiple documents or sections
  const sectionMentions = lower.match(/(?:пункт|раздел|статья|глава|приложение)\s+\d/g);
  if (sectionMentions && sectionMentions.length >= 2) return true;

  return false;
}

/**
 * After the agentic loop finishes, finalize the accumulated chunks:
 * rerank and filter for relevance.
 */
export async function finalizeAgenticResults(
  ctx: AgenticContext,
  query: string
): Promise<{ results: SearchResult[]; lowConfidence: boolean }> {
  const allChunks = Array.from(ctx.chunks.values());

  if (allChunks.length === 0) {
    return { results: [], lowConfidence: true };
  }

  const reranked = await llmRerank(query, allChunks);
  return filterByRelevance(reranked);
}
