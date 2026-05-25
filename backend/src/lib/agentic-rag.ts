import { GoogleGenAI, Type, FunctionCallingConfigMode, type Content, type FunctionDeclaration } from "@google/genai";
import { hybridSearch, filterByRelevance, intentAwareRerank, type SearchResult } from "./retrieval.js";
import { fetchChunksBySection, fetchChunksByDocument } from "./retrieval.js";
import { rerank } from "./reranker.js";
import { withGoogleApiLimit } from "./google-ai.js";
import { logError } from "./error-logger.js";
import type { SectionReference, DocumentReference } from "./query-analyzer.js";
import type { IntentResult } from "./intent-classifier.js";

/**
 * Agentic RAG: provides search tools to the LLM so it can decide
 * what to search, how many times, and when it has enough context.
 *
 * Uses @google/genai directly (not Vercel AI SDK) because Gemini 3.x
 * requires thought_signature in multi-step tool calls, and the AI SDK
 * doesn't preserve them between steps.
 */

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
const AGENTIC_MODEL = "gemini-2.5-flash";

/** Accumulated chunks from all tool calls within one request */
export interface AgenticContext {
  chunks: Map<string, SearchResult>;
  searchCount: number;
}

export function createAgenticContext(): AgenticContext {
  return { chunks: new Map(), searchCount: 0 };
}

const MAX_AGENT_SEARCHES = 8;

/* ── Tool definitions in Google API format ── */

const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "search_knowledge_base",
    description:
      "Поиск по базе знаний закупочных документов. Используй для поиска нормативных документов, положений, регламентов, инструкций. " +
      "Можно фильтровать по тегам: '223-фз', 'вне 223-фз', 'ценообразование', 'матрица полномочий', 'законодательство', 'договоры', 'инструкции', 'обучение', 'реестр'. " +
      "Вызывай несколько раз с разными запросами/тегами, если нужна информация из разных источников.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Поисковый запрос на русском языке" },
        tags: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Фильтр по тегам документов (опционально)" },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_section",
    description:
      "Прямой поиск конкретного пункта, раздела, статьи или приложения в документе. " +
      "Используй когда пользователь ссылается на конкретный номер пункта (например 'пункт 61', 'раздел 5', 'приложение 3'). " +
      "Эффективнее чем search_knowledge_base для точечных ссылок.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        sections: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Номера пунктов/разделов для поиска, например ['61', '61.1', '5']" },
        document_hint: { type: Type.STRING, description: "Часть названия документа для сужения поиска, например 'положен' или 'стандарт'" },
      },
      required: ["sections"],
    },
  },
  {
    name: "lookup_document",
    description:
      "Получить содержимое конкретного документа по названию. " +
      "Используй когда пользователь упоминает конкретный документ ('Положение о закупках', 'Стандарт СГК') " +
      "или когда нужно загрузить весь документ, а не отдельные фрагменты. " +
      "ВАЖНО: document_type_hint сужает поиск до конкретного типа документа (например 'критерии' для критериев выбора способа закупки, 'стандарт' для стандарта закупок).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename_hints: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Части названия файла для поиска, например ['положение', 'закупк'] или ['стандарт', 'СГК']" },
        query: { type: Type.STRING, description: "Запрос для ранжирования чанков внутри документа" },
        document_type_hint: { type: Type.STRING, description: "Тип документа для сужения поиска: 'критерии', 'стандарт', 'положен', 'инструкци', 'методик', 'регламент', 'перечень_единственных', 'матрица_полномочий' и т.д." },
      },
      required: ["filename_hints"],
    },
  },
];

/* ── Tool execution ── */

async function executeTool(
  ctx: AgenticContext,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (ctx.searchCount >= MAX_AGENT_SEARCHES) {
    return { status: "limit", message: "Достигнут лимит поисковых запросов." };
  }
  ctx.searchCount++;

  switch (name) {
    case "search_knowledge_base": {
      const query = args.query as string;
      const tags = (args.tags as string[] | undefined);
      const filterTags = tags && tags.length > 0 ? tags : null;
      const results = await hybridSearch(query, 15, filterTags);

      let added = 0;
      for (const r of results) {
        if (!ctx.chunks.has(r.id)) { ctx.chunks.set(r.id, r); added++; }
      }

      console.log(`[agentic] search_knowledge_base: "${query.slice(0, 60)}" tags=${JSON.stringify(filterTags)} → ${results.length} found, ${added} new`);

      return {
        status: "ok",
        found: results.length,
        new_chunks: added,
        total_accumulated: ctx.chunks.size,
        top_results: results.slice(0, 5).map((r, i) => ({
          i, file: r.source_filename, score: r.similarity.toFixed(3),
          preview: r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""),
          tags: r.tags,
        })),
      };
    }

    case "lookup_section": {
      const sections = args.sections as string[];
      const documentHint = (args.document_hint as string) ?? null;
      const ref: SectionReference = { sections, documentHint };
      const results = await fetchChunksBySection(ref);

      let added = 0;
      for (const r of results) {
        if (!ctx.chunks.has(r.id)) { ctx.chunks.set(r.id, r); added++; }
      }

      console.log(`[agentic] lookup_section: sections=${sections.join(",")} hint=${documentHint ?? "none"} → ${results.length} found, ${added} new`);

      return {
        status: "ok",
        found: results.length,
        new_chunks: added,
        results: results.slice(0, 4).map((r) => ({
          file: r.source_filename,
          preview: r.content.slice(0, 400) + (r.content.length > 400 ? "…" : ""),
        })),
      };
    }

    case "lookup_document": {
      const filenameHints = args.filename_hints as string[];
      const query = (args.query as string) ?? undefined;
      const documentTypeHint = (args.document_type_hint as string) ?? undefined;
      const ref: DocumentReference = { filenameHints, documentTypeHint };
      const results = await fetchChunksByDocument(ref, 8, query);

      let added = 0;
      for (const r of results) {
        if (!ctx.chunks.has(r.id)) { ctx.chunks.set(r.id, r); added++; }
      }

      console.log(`[agentic] lookup_document: hints=${filenameHints.join(",")} → ${results.length} found, ${added} new`);

      return {
        status: "ok",
        found: results.length,
        new_chunks: added,
        filenames: [...new Set(results.map((r) => r.source_filename))],
        previews: results.slice(0, 3).map((r) => ({
          file: r.source_filename, chunk: r.chunk_index,
          preview: r.content.slice(0, 300) + (r.content.length > 300 ? "…" : ""),
        })),
      };
    }

    default:
      return { status: "error", message: `Unknown tool: ${name}` };
  }
}

/* ── Agentic search loop using @google/genai ── */

/**
 * Result of an agentic loop execution.
 *
 * `bestEffort: true` signals, что цикл был прерван ошибкой (Gemini 429,
 * таймаут Supabase, невалидный JSON и т.п.) до того, как модель сказала
 * «поиск завершён». Накопленные в ctx.chunks результаты сохраняются и
 * могут быть использованы вызывающим кодом вместе с fallback-поиском,
 * а итоговый ответ помечается низкой уверенностью.
 */
export interface AgenticRunResult {
  bestEffort: boolean;
  error?: string;
  failedStep?: number;
  completedSteps: number;
}

export async function runAgenticSearch(
  ctx: AgenticContext,
  prompt: string,
  maxSteps: number = 6
): Promise<AgenticRunResult> {
  const history: Content[] = [
    { role: "user", parts: [{ text: prompt }] },
  ];

  for (let step = 0; step < maxSteps; step++) {
    // C03: обернуть каждый шаг в try/catch. Любая единичная ошибка
    // (Gemini 429, невалидный JSON от tool-call, таймаут Supabase) больше
    // не валит весь запрос в 500. Вместо этого цикл останавливается,
    // а накопленные чанки отдаются вызывающему как best-effort результат.
    try {
      const response = await withGoogleApiLimit(() =>
        client.models.generateContent({
          model: AGENTIC_MODEL,
          contents: history,
          config: {
            tools: [{ functionDeclarations: toolDeclarations }],
            toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
            temperature: 0,
          },
        })
      );

      const candidate = response.candidates?.[0];

      // Add full model response to history (preserves thought_signature)
      if (candidate?.content) {
        history.push(candidate.content);
      }

      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        // Model finished — no more tool calls
        console.log(`[agentic] Loop finished after ${step + 1} steps, ${ctx.chunks.size} chunks collected`);
        return { bestEffort: false, completedSteps: step + 1 };
      }

      // Execute all function calls and build response parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responseParts: any[] = [];
      for (const call of functionCalls) {
        // Per-tool isolation: ошибка одного tool-call возвращается модели как
        // status=error, чтобы она могла попробовать другой инструмент, а не
        // валила весь цикл.
        try {
          const result = await executeTool(ctx, call.name!, call.args ?? {});
          responseParts.push({
            functionResponse: {
              name: call.name,
              response: result,
              ...(call.id ? { id: call.id } : {}),
            },
          });
        } catch (toolErr) {
          const toolMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
          console.error(`[agentic] Tool ${call.name} failed at step ${step + 1}:`, toolErr);
          responseParts.push({
            functionResponse: {
              name: call.name,
              response: {
                status: "error",
                message: toolMsg.slice(0, 200),
              },
              ...(call.id ? { id: call.id } : {}),
            },
          });
        }
      }

      // Send tool results back to model
      history.push({ role: "user", parts: responseParts });
    } catch (stepErr) {
      const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);
      console.error(
        `[agentic] Step ${step + 1}/${maxSteps} failed; preserving ${ctx.chunks.size} chunks:`,
        stepErr
      );
      // Fire-and-forget: не блокируем ответ пользователю.
      logError({
        type: "chat.agentic",
        message: `Agentic step ${step + 1} failed: ${errMsg}`.slice(0, 500),
        endpoint: "/api/chat",
        metadata: {
          step: step + 1,
          maxSteps,
          chunksAccumulated: ctx.chunks.size,
          searchCount: ctx.searchCount,
        },
      }).catch(() => {});
      return {
        bestEffort: true,
        error: errMsg.slice(0, 200),
        failedStep: step + 1,
        completedSteps: step,
      };
    }
  }
  return { bestEffort: false, completedSteps: maxSteps };
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
  const reasons: string[] = [];
  let score = 0;

  if (query.trim().length < 25) {
    return false;
  }

  // 1. Comparative queries (both regimes)
  if (intent.fz_type === "both") {
    score += 3;
    reasons.push("both-regimes");
  }

  // 2. Explicit comparison keywords
  if (/сравни|отлича|разниц|в\s+чём\s+отличи|чем\s+отличает|различи|сопостав/i.test(lower)) {
    score += 2;
    reasons.push("comparison-keywords");
  }

  // 3. Multi-aspect questions (multiple question words or multiple topics)
  const questionMarkers = lower.match(/(?:как|что|кто|какой|какие|каков|где|когда|зачем|почему|сколько)\s/g);
  if (questionMarkers && questionMarkers.length >= 3) {
    score += 1;
    reasons.push("multi-question");
  }

  // 4. Long complex questions with multiple clauses
  const clauses = query.split(/[,;]\s+/).length;
  if (clauses >= 4 && query.length > 150) {
    score += 1;
    reasons.push("long-multi-clause");
  }

  // 5. Questions mentioning multiple documents or sections
  const sectionMentions = lower.match(/(?:пункт|раздел|статья|глава|приложение)\s+\d/g);
  if (sectionMentions && sectionMentions.length >= 2) {
    score += 2;
    reasons.push("multi-section");
  }

  // Low-confidence intent often benefits from deterministic fallback.
  if (intent.confidence < 0.35) {
    score -= 1;
    reasons.push("low-intent-confidence");
  }

  const useAgentic = score >= 3;
  console.log(`[agentic] complexity score=${score} useAgentic=${useAgentic} reasons=${reasons.join(",") || "none"}`);
  return useAgentic;
}

/**
 * After the agentic loop finishes, finalize the accumulated chunks:
 * rerank and filter for relevance.
 *
 * When entityHints are provided (multi-entity comparative queries),
 * ensures balanced representation: each entity gets a minimum share
 * of the final chunk budget, preventing one entity from dominating.
 */
export async function finalizeAgenticResults(
  ctx: AgenticContext,
  query: string,
  entityHints?: string[],
  intent?: IntentResult,
  entityNames?: string[]
): Promise<{ results: SearchResult[]; lowConfidence: boolean }> {
  const allChunks = Array.from(ctx.chunks.values());

  if (allChunks.length === 0) {
    return { results: [], lowConfidence: true };
  }

  // Apply intent-aware reranking (FZ-type boost/penalty + intent tag boost + tier weights)
  const intentReranked = intent ? intentAwareRerank(allChunks, intent, query) : allChunks;

  // For multi-entity queries, SKIP the LLM reranker — it suppresses chunks
  // it considers "about another organization" and destroys entity balance.
  const reranked = (entityNames && entityNames.length >= 2)
    ? intentReranked
    : await rerank(query, intentReranked, entityNames);

  // ── Entity-balanced selection for multi-entity queries ──
  // Without balancing, one entity can dominate the top-N results,
  // leaving the other entity with zero or minimal representation.
  if (entityHints && entityHints.length >= 2) {
    const MAX_BALANCED = 12;
    const minPerEntity = Math.max(2, Math.floor(MAX_BALANCED / entityHints.length));
    const sorted = [...reranked].sort((a, b) => b.similarity - a.similarity);

    // Classify each chunk by entity (based on source_filename)
    const entityChunks = new Map<string, SearchResult[]>();
    const unclassified: SearchResult[] = [];

    for (const chunk of sorted) {
      const fname = (chunk.source_filename ?? "").toLowerCase();
      let matched = false;
      for (const hint of entityHints) {
        if (fname.includes(hint.toLowerCase())) {
          if (!entityChunks.has(hint)) entityChunks.set(hint, []);
          entityChunks.get(hint)!.push(chunk);
          matched = true;
          break;
        }
      }
      if (!matched) unclassified.push(chunk);
    }

    // Build balanced result: guaranteed minimum per entity, then fill with best remaining
    const selectedIds = new Set<string>();
    const balanced: SearchResult[] = [];

    // Phase 1: guarantee minimum per entity
    for (const hint of entityHints) {
      const chunks = entityChunks.get(hint) ?? [];
      let added = 0;
      for (const c of chunks) {
        if (added >= minPerEntity) break;
        if (!selectedIds.has(c.id)) {
          balanced.push(c);
          selectedIds.add(c.id);
          added++;
        }
      }
    }

    // Phase 2: fill remaining budget with highest-scoring unselected chunks.
    //
    // CRITICAL: rank candidates by the ORIGINAL pre-boost similarity, not by
    // the boosted value. Pre-seed sites in chat.ts inflate similarity to 0.75
    // for org-registry, catalog, per-entity and graph-aware hits. If we sort
    // by `similarity` here, every boosted registry chunk (originalSimilarity
    // ≈ 0.05–0.25, boosted to 0.75) outranks a genuinely relevant content
    // chunk at 0.55, even though the registry has nothing to do with the
    // user's question. That is exactly the failure mode observed on the
    // ЕТГК↔НТСК comparison: 17 retrieved sources with "Перечень компаний",
    // "Матрица полномочий" and "Схема взаимодействия" displacing the actual
    // Положение о закупках НТСК (sources.id=1421).
    //
    // We also apply a soft relevance threshold to unclassified candidates so
    // that low-quality boosted chunks (originalSimilarity well below the
    // entity chunks we already selected in Phase-1) do not get pulled in at
    // all. Pre-seeded chunks that survive Phase-1 (e.g. NMGRES authority
    // matrix routed via entityHints / intentAwareRerank) are unaffected —
    // this only filters the Phase-2 *fill* pool.
    const PHASE2_MIN_SCORE = 0.30;
    const scoreFor = (c: SearchResult) => c.originalSimilarity ?? c.similarity;
    const remaining = sorted
      .filter((c) => !selectedIds.has(c.id))
      .filter((c) => scoreFor(c) >= PHASE2_MIN_SCORE)
      .sort((a, b) => scoreFor(b) - scoreFor(a));
    for (const c of remaining) {
      if (balanced.length >= MAX_BALANCED) break;
      balanced.push(c);
    }

    // Re-sort by similarity for consistent ordering in the final result list.
    // The boosted similarity is still useful as a presentational signal
    // (it carries the regime / intent boost), but ranking decisions above
    // used the honest originalSimilarity.
    balanced.sort((a, b) => b.similarity - a.similarity);

    console.log(`[agentic] Entity-balanced: ${entityHints.map(h => {
      const count = balanced.filter(c => (c.source_filename ?? "").toLowerCase().includes(h.toLowerCase())).length;
      return `${h}=${count}`;
    }).join(", ")}, unclassified=${balanced.filter(c => {
      const fname = (c.source_filename ?? "").toLowerCase();
      return !entityHints.some(h => fname.includes(h.toLowerCase()));
    }).length}, total=${balanced.length}`);

    const lowConfidence = balanced.length === 0 || balanced[0].similarity < 0.35;
    return { results: balanced, lowConfidence };
  }

  return filterByRelevance(reranked);
}
