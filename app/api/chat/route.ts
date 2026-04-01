import { NextRequest, NextResponse } from "next/server";
import { type CoreMessage } from "ai";
import { GoogleGenAI } from "@google/genai";
import { multiQuerySearch, hybridSearch, filterByRelevance, intentAwareRerank, fetchChunksBySection, fetchChunksByDocument, type SearchResult } from "@/app/lib/retrieval";
import { llmRerank } from "@/app/lib/reranker";
import { classifyIntent } from "@/app/lib/intent-classifier";
import { loadConversationContext, saveMessage } from "@/app/lib/memory";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { createServiceClient } from "@/app/lib/supabase";
import { unauthorizedResponse, notFound } from "@/app/lib/api-helpers";
import { classifyOffTopic, CATEGORY_LABELS, type OffTopicCategory } from "@/app/lib/off-topic-classifier";
import { notifyOffTopic } from "@/app/lib/telegram";
import { logError } from "@/app/lib/error-logger";
import { extractSearchHints, detectSectionReference, detectDocumentReference } from "@/app/lib/query-analyzer";
import { isComplexQuery, createAgenticContext, runAgenticSearch, finalizeAgenticResults } from "@/app/lib/agentic-rag";
import { expandByRelationships } from "@/app/lib/relationships";

export const runtime = "nodejs";

const MAX_UPLOADED_DOC_CHARS = 50000;
const MAX_CHUNK_IMAGES = 3; // Max images to include per chunk in prompt
const MAX_TOTAL_IMAGES = 12; // Max total images in entire prompt

export async function POST(req: NextRequest) {
 try {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return unauthorizedResponse();
  }

  const { messages, conversationId, attachedDocuments } = await req.json();

  if (conversationId && !isAdminCode(invite.code)) {
    const supabase = createServiceClient();
    const { data: conv } = await supabase
      .from("conversations")
      .select("invite_code_id")
      .eq("id", conversationId)
      .single();

    if (!conv || conv.invite_code_id !== invite.id) {
      return notFound("Диалог не найден");
    }
  }

  const userMessage = messages[messages.length - 1];
  const hasAttachments = Array.isArray(attachedDocuments) && attachedDocuments.length > 0;

  let searchQuery = userMessage.content;
  if (hasAttachments && searchQuery.length < 60) {
    const docPreview = attachedDocuments
      .map((d: { filename: string; markdown: string }) => d.markdown.slice(0, 300))
      .join(" ");
    searchQuery = `${searchQuery} ${docPreview}`.slice(0, 1000);
  }

  const searchHints = extractSearchHints(userMessage.content);
  const sectionRef = detectSectionReference(userMessage.content);
  const docRef = detectDocumentReference(userMessage.content);

  // Phase 1: Run intent classification + non-search tasks in parallel
  const [, contextResult, intentResult, offTopicResult] = await Promise.all([
    conversationId
      ? saveMessage(conversationId, "user", userMessage.content)
      : Promise.resolve(),
    conversationId
      ? loadConversationContext(conversationId).catch((e) => {
          console.error("[chat] loadConversationContext failed (continuing without context):", e);
          return null;
        })
      : Promise.resolve(null),
    classifyIntent(searchQuery),
    classifyOffTopic(userMessage.content, messages.slice(0, -1)),
  ]);

  // Off-topic: notify admin via TG but DO NOT block the user — let the model answer
  if (offTopicResult.isOffTopic && !isAdminCode(invite.code)) {
    const supabase = createServiceClient();
    const inviteCodeId = invite.id.startsWith("admin-") ? null : invite.id;
    const categoryLabel = CATEGORY_LABELS[offTopicResult.category as OffTopicCategory] ?? offTopicResult.category;

    console.log(`[OffTopic] Detected off-topic query (not blocking): "${userMessage.content.slice(0, 80)}" (${offTopicResult.category})`);

    // Fire-and-forget: log + notify, don't await
    Promise.all([
      supabase.from("off_topic_queries").insert({
        invite_code_id: inviteCodeId,
        user_name: invite.name,
        organization: invite.organization ?? null,
        category: offTopicResult.category,
        query_text: userMessage.content.slice(0, 5000),
      }).then(({ error }) => {
        if (error) console.error("[OffTopic] DB insert error:", error.message);
      }),
      notifyOffTopic(invite.name, userMessage.content, offTopicResult.category, categoryLabel, invite.organization),
    ]).catch((e) => console.error("[OffTopic] notify error:", e));
  }

  const contextMessages: { role: string; content: string }[] =
    contextResult?.messages ?? [];

  // ── Determine retrieval strategy: agentic (complex) vs deterministic (simple) ──
  const useAgenticRag = isComplexQuery(userMessage.content, intentResult);
  let relevantChunks: SearchResult[];
  let lowConfidence: boolean;

  if (useAgenticRag) {
    // ═══ AGENTIC PATH: LLM decides what to search (via @google/genai) ═══
    console.log(`[chat] Using AGENTIC RAG for complex query (intent=${intentResult.intent}, fz_type=${intentResult.fz_type})`);

    const agenticCtx = createAgenticContext();

    const agenticPrompt = `Ты — поисковый агент базы знаний Дирекции по закупкам СГК.
Твоя задача — найти ВСЕ документы, необходимые для полного ответа на вопрос пользователя.

ПРАВИЛА:
1. Проанализируй вопрос и определи, какие документы нужны
2. Вызывай инструменты поиска столько раз, сколько нужно для полного покрытия
3. Если вопрос касается ОБОИХ режимов (223-ФЗ и вне 223-ФЗ) — обязательно ищи по каждому отдельно
4. Если результатов мало — переформулируй запрос и попробуй снова
5. Если упоминается конкретный пункт/раздел — используй lookup_section
6. Если упоминается конкретный документ — используй lookup_document
7. Когда собрал достаточно информации — просто ответь "Поиск завершён"

ВОПРОС ПОЛЬЗОВАТЕЛЯ:
${userMessage.content}

КОНТЕКСТ КЛАССИФИКАЦИИ:
- Интент: ${intentResult.intent}
- Режим ФЗ: ${intentResult.fz_type}
- Теги для поиска: ${intentResult.search_tags.join(", ") || "нет"}
- Варианты запроса: ${intentResult.query_variants.join(" | ") || "нет"}`;

    try {
      await runAgenticSearch(agenticCtx, agenticPrompt, 6);

      console.log(`[chat] Agentic search complete: ${agenticCtx.searchCount} searches, ${agenticCtx.chunks.size} chunks collected`);

      const filtered = await finalizeAgenticResults(agenticCtx, userMessage.content);
      relevantChunks = filtered.results;
      lowConfidence = filtered.lowConfidence;
    } catch (agenticError) {
      console.error("[chat] Agentic RAG failed, falling back to deterministic:", agenticError);
      // Fallback: run a simple hybrid search
      const fallbackResults = await hybridSearch(searchQuery, 20, searchHints);
      const reranked = intentAwareRerank(fallbackResults, intentResult);
      const llmReranked = await llmRerank(userMessage.content, reranked);
      const filtered = filterByRelevance(llmReranked);
      relevantChunks = filtered.results;
      lowConfidence = filtered.lowConfidence;
    }
  } else {
    // ═══ DETERMINISTIC PATH: fast fixed pipeline (existing logic) ═══
    console.log(`[chat] Using DETERMINISTIC RAG (intent=${intentResult.intent})`);

  // Phase 2: Use intent query_variants in search for better coverage
  // Build search variants: original query + LLM-generated reformulations
  const searchVariants = new Set<string>([searchQuery]);
  if (intentResult.query_variants) {
    for (const v of intentResult.query_variants.slice(0, 2)) {
      if (v.length > 5 && v !== searchQuery) searchVariants.add(v);
    }
  }

  // Run all search tasks in parallel (now enriched with intent variants)
  const searchPromises = Array.from(searchVariants).map((q) =>
    hybridSearch(q, 20, searchHints)
  );
  const [sectionResults, docResults, ...variantResults] = await Promise.all([
    sectionRef ? fetchChunksBySection(sectionRef) : Promise.resolve([]),
    docRef ? fetchChunksByDocument(docRef, docRef.filenameHints.length > 2 ? 15 : 8, userMessage.content) : Promise.resolve([]),
    ...searchPromises,
  ]);

  // Merge variant search results (dedup, keep highest similarity)
  const mergedSearch = new Map<string, SearchResult>();
  for (const results of variantResults) {
    for (const r of results) {
      const existing = mergedSearch.get(r.id);
      if (!existing || r.similarity > existing.similarity) {
        mergedSearch.set(r.id, r);
      }
    }
  }
  const searchResults = Array.from(mergedSearch.values())
    .sort((a, b) => b.similarity - a.similarity);

  // Merge section-lookup and document-lookup results with search results (dedup by id)
  let combinedResults = searchResults;
  const existingIds = new Set(searchResults.map((r) => r.id));

  if (sectionResults.length > 0) {
    const newSectionResults = sectionResults.filter((r) => !existingIds.has(r.id));
    for (const r of newSectionResults) existingIds.add(r.id);
    combinedResults = [...newSectionResults, ...combinedResults];
    console.log(`[chat] Section lookup added ${newSectionResults.length} new chunks`);
  }

  if (docResults.length > 0) {
    const newDocResults = docResults.filter((r) => !existingIds.has(r.id));
    for (const r of newDocResults) existingIds.add(r.id);
    combinedResults = [...combinedResults, ...newDocResults];
    console.log(`[chat] Document lookup added ${newDocResults.length} new chunks`);
  }

  // ── Intent-aware supplementary search ──
  {
    const supplementSearches: Promise<SearchResult[]>[] = [];

    const count223 = combinedResults.filter((r) => r.tags.some((t) => t.toLowerCase() === "223-фз")).length;
    const countNon223 = combinedResults.filter((r) => r.tags.some((t) => t.toLowerCase() === "вне 223-фз")).length;
    const MIN_REGIME_CHUNKS = 3;

    const regimeSearchQueries = [searchQuery];
    if (intentResult.query_variants) {
      const firstVariant = intentResult.query_variants.find((v) => v.length > 5 && v !== searchQuery);
      if (firstVariant) regimeSearchQueries.push(firstVariant);
    }

    const addRegimeSearches = (tags: string[]) => {
      for (const q of regimeSearchQueries) {
        supplementSearches.push(hybridSearch(q, 10, tags));
      }
    };

    if (intentResult.fz_type === "223" && count223 === 0) {
      addRegimeSearches(["223-фз"]);
    } else if (intentResult.fz_type === "non-223" && countNon223 === 0) {
      addRegimeSearches(["вне 223-фз"]);
    } else if (intentResult.fz_type === "both") {
      if (count223 < MIN_REGIME_CHUNKS) addRegimeSearches(["223-фз"]);
      if (countNon223 < MIN_REGIME_CHUNKS) addRegimeSearches(["вне 223-фз"]);
    } else if (intentResult.fz_type === "unknown" && intentResult.confidence >= 0.4) {
      if (count223 === 0 && countNon223 === 0) {
        addRegimeSearches(["223-фз"]);
        addRegimeSearches(["вне 223-фз"]);
      } else if (countNon223 === 0) {
        addRegimeSearches(["вне 223-фз"]);
      } else if (count223 === 0) {
        addRegimeSearches(["223-фз"]);
      }
    }

    // 2. Intent-specific tag coverage
    const intentTagMap: Record<string, string[]> = {
      pricing: ["ценообразование"],
      authority: ["матрица полномочий"],
      regulation: ["законодательство"],
      contract: ["договоры"],
      system: ["инструкции"],
    };
    const intentTags = intentTagMap[intentResult.intent];
    if (intentTags && intentResult.confidence >= 0.5) {
      const hasIntentTag = combinedResults.some((r) =>
        r.tags.some((t) => intentTags.includes(t.toLowerCase()))
      );
      if (!hasIntentTag) {
        supplementSearches.push(hybridSearch(searchQuery, 10, intentTags));
      }
    }

    // 2b. Training course coverage: for procedure/general/regulation questions,
    // ensure training materials from BOTH regimes are present (not just one)
    const trainingIntents = ["procedure", "general", "regulation", "authority", "pricing"];
    if (trainingIntents.includes(intentResult.intent)) {
      const trainingChunks = combinedResults.filter((r) =>
        r.tags.some((t) => t.toLowerCase() === "обучение")
      );

      if (trainingChunks.length === 0) {
        // No training at all — search broadly
        supplementSearches.push(hybridSearch(searchQuery, 5, ["обучение"]));
      }

      // For comparative queries, ensure training from BOTH regimes
      if (intentResult.fz_type === "both" || intentResult.fz_type === "unknown") {
        const training223 = trainingChunks.some((r) =>
          r.tags.some((t) => t.toLowerCase() === "223-фз") ||
          r.source_filename.toLowerCase().includes("223")
        );
        const trainingNon223 = trainingChunks.some((r) =>
          r.tags.some((t) => t.toLowerCase() === "вне 223-фз") ||
          r.source_filename.toLowerCase().includes("вне")
        );
        if (!training223) {
          supplementSearches.push(hybridSearch(searchQuery, 5, ["обучение", "223-фз"]));
        }
        if (!trainingNon223) {
          supplementSearches.push(hybridSearch(searchQuery, 5, ["обучение", "вне 223-фз"]));
        }
      }
    }

    // 3. Use intent query_variants (broader semantic coverage)
    if (intentResult.query_variants.length > 0) {
      for (const variant of intentResult.query_variants.slice(0, 2)) {
        if (variant !== searchQuery && variant.length > 5) {
          supplementSearches.push(hybridSearch(variant, 10, null));
        }
      }
    }

    // 4. Source diversity check: if all results come from ≤2 sources, broaden search
    const uniqueSources = new Set(combinedResults.map((r) => r.source_filename));
    if (uniqueSources.size <= 2 && combinedResults.length >= 5 && intentResult.search_tags.length > 0) {
      supplementSearches.push(hybridSearch(searchQuery, 10, intentResult.search_tags));
    }

    if (supplementSearches.length > 0) {
      const allSupplementary = await Promise.all(supplementSearches);
      let addedCount = 0;
      for (const results of allSupplementary) {
        const newResults = results.filter((r) => !existingIds.has(r.id));
        for (const r of newResults) existingIds.add(r.id);
        combinedResults = [...combinedResults, ...newResults];
        addedCount += newResults.length;
      }
      if (addedCount > 0) {
        console.log(`[chat] Intent supplementary search added ${addedCount} new chunks from ${supplementSearches.length} queries`);
      }
    }
  }

  // Rerank and filter
  const rerankedResults = intentAwareRerank(combinedResults, intentResult);
  const llmReranked = await llmRerank(userMessage.content, rerankedResults);
  const filtered = filterByRelevance(llmReranked);
  relevantChunks = filtered.results;
  lowConfidence = filtered.lowConfidence;

  } // end deterministic path

  // ── Ensure original source documents are included alongside denormalized files ──
  // Denormalized files store the original document name in the sources.content_preview
  // field as "Денормализовано: <original_filename>". We look up these originals
  // and add a representative chunk so users can preview/download them.
  {
    const denormFilenames = [...new Set(
      relevantChunks
        .filter((r) => r.tags.some((t) => t.toLowerCase() === "денормализовано") || r.source_filename.endsWith(".md"))
        .map((r) => r.source_filename)
    )];

    if (denormFilenames.length > 0) {
      const supabaseForDocs = createServiceClient();

      // Look up content_preview in sources table to get original document names
      const { data: denormSources } = await supabaseForDocs
        .from("sources")
        .select("filename, content_preview")
        .in("filename", denormFilenames);

      if (denormSources && denormSources.length > 0) {
        // Extract original document names from "Денормализовано: <name>"
        const originalDocNames = new Set<string>();
        for (const src of denormSources as { filename: string; content_preview: string | null }[]) {
          const preview = src.content_preview ?? "";
          const match = preview.match(/Денормализовано:\s*(.+)/i);
          if (match) {
            originalDocNames.add(match[1].trim());
          }
        }

        if (originalDocNames.size > 0) {
          const existingFilenames = new Set(relevantChunks.map((r) => r.source_filename));
          // Remove already-present originals
          for (const fn of existingFilenames) originalDocNames.delete(fn);

          if (originalDocNames.size > 0) {
            // Find these original documents by exact or fuzzy filename match
            const { data: allSources } = await supabaseForDocs
              .from("sources")
              .select("filename")
              .neq("mime_type", "application/x-denormalized");

            const matchedOriginals: string[] = [];
            if (allSources) {
              for (const origName of originalDocNames) {
                const origLower = origName.toLowerCase().replace(/\s+/g, "_");
                const found = (allSources as { filename: string }[]).find((s) =>
                  s.filename.toLowerCase().includes(origLower) ||
                  origLower.includes(s.filename.toLowerCase().replace(/\.[^.]+$/, ""))
                );
                if (found && !existingFilenames.has(found.filename)) {
                  matchedOriginals.push(found.filename);
                  existingFilenames.add(found.filename);
                }
              }
            }

            if (matchedOriginals.length > 0) {
              const { data: origChunks } = await supabaseForDocs
                .from("chunks")
                .select("id, content, source_filename, chunk_index, tags, image_paths")
                .in("source_filename", matchedOriginals)
                .order("chunk_index", { ascending: true })
                .limit(matchedOriginals.length * 2);

              if (origChunks && origChunks.length > 0) {
                const seen = new Set<string>();
                const chunkIds = new Set(relevantChunks.map((r) => r.id));
                for (const chunk of origChunks) {
                  if (seen.has(chunk.source_filename) || chunkIds.has(chunk.id)) continue;
                  seen.add(chunk.source_filename);
                  relevantChunks.push({
                    id: chunk.id,
                    content: chunk.content,
                    source_filename: chunk.source_filename,
                    chunk_index: chunk.chunk_index,
                    similarity: 0.40,
                    tags: chunk.tags ?? [],
                    image_paths: chunk.image_paths ?? [],
                  });
                }
                console.log(`[chat] Added ${seen.size} original source documents: ${[...seen].join(", ")}`);
              }
            }
          }
        }
      }
    }
  }

  // ── Expand results by document relationships (parent ↔ children) ──
  try {
    relevantChunks = await expandByRelationships(
      relevantChunks,
      userMessage.content,
      6
    );
  } catch (relErr) {
    console.error("[chat] Relationship expansion failed (non-fatal):", relErr);
  }

  // ── Load chunk images from Supabase Storage ──
  const supabase = createServiceClient();
  let totalImagesIncluded = 0;

  interface ChunkWithImages {
    content: string;
    source_filename: string;
    chunk_index: number;
    similarity: number;
    imageBase64: Array<{ base64: string; mimeType: string }>;
  }

  const chunksWithImages: ChunkWithImages[] = await Promise.all(
    relevantChunks.map(async (chunk) => {
      const imageBase64: Array<{ base64: string; mimeType: string }> = [];

      if (chunk.image_paths && chunk.image_paths.length > 0 && totalImagesIncluded < MAX_TOTAL_IMAGES) {
        const pathsToLoad = chunk.image_paths.slice(0, MAX_CHUNK_IMAGES);

        for (const path of pathsToLoad) {
          if (totalImagesIncluded >= MAX_TOTAL_IMAGES) break;

          try {
            const { data, error } = await supabase.storage
              .from("chunk-images")
              .download(path);

            if (error || !data) {
              console.error(`[chat] Failed to download image ${path}:`, error);
              continue;
            }

            const arrayBuffer = await data.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString("base64");
            const ext = (path.split(".").pop() || "png").toLowerCase();
            const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;

            // Gemini only supports: png, jpeg, webp, gif, heic, heif
            const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);
            if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
              console.warn(`[chat] Skipping unsupported image format: ${mimeType} (${path})`);
              continue;
            }

            imageBase64.push({ base64, mimeType });
            totalImagesIncluded++;
          } catch (e) {
            console.error(`[chat] Error loading image ${path}:`, e);
          }
        }
      }

      return {
        content: chunk.content,
        source_filename: chunk.source_filename,
        chunk_index: chunk.chunk_index,
        similarity: chunk.similarity,
        imageBase64,
      };
    })
  );

  console.log(`[chat] Loaded ${totalImagesIncluded} images for ${chunksWithImages.length} chunks`);

  // ── Build RAG context with text (images will be in multimodal messages) ──
  const ragContext = chunksWithImages.length
    ? `<documents>\n${chunksWithImages
        .map(
          (r, i) =>
            `<document id="${i + 1}" filename="${r.source_filename}" chunk="${r.chunk_index}" similarity="${r.similarity.toFixed(2)}" has_screenshots="${r.imageBase64.length > 0 ? "yes" : "no"}">\n${r.content}\n</document>`
        )
        .join("\n")}\n</documents>`
    : "";

  // Uploaded documents context (unchanged)
  let uploadedDocsContext = "";
  if (hasAttachments) {
    const docs = attachedDocuments.map(
      (d: { filename: string; markdown: string }, i: number) => {
        const content = d.markdown.length > MAX_UPLOADED_DOC_CHARS
          ? d.markdown.slice(0, MAX_UPLOADED_DOC_CHARS) + "\n\n[... документ обрезан ...]"
          : d.markdown;
        return `<uploaded_document id="${i + 1}" filename="${d.filename}">\n${content}\n</uploaded_document>`;
      }
    );
    uploadedDocsContext = `<uploaded_documents>\n${docs.join("\n")}\n</uploaded_documents>`;
  }

  const lowConfidenceWarning = lowConfidence
    ? `\n\n⚠️ ВНИМАНИЕ: Найденные документы имеют НИЗКУЮ релевантность к вопросу пользователя. Скорее всего, ответа в базе знаний нет. Сообщи об этом пользователю явно.`
    : "";

  // Detect if results contain both fz-type regimes
  const chunkTags = relevantChunks.flatMap((r) => r.tags.map((t) => t.toLowerCase()));
  const has223Chunks = chunkTags.includes("223-фз");
  const hasNon223Chunks = chunkTags.includes("вне 223-фз");
  const dualRegimeHint = (has223Chunks && hasNon223Chunks)
    ? `\n\n⚠️ ВАЖНО: Среди предоставленных документов есть материалы ПО ОБОИМ РЕЖИМАМ (223-ФЗ и вне 223-ФЗ). Ты ОБЯЗАН структурировать ответ двумя отдельными блоками: «## По 223-ФЗ» и «## Вне 223-ФЗ (ООО «СГК»)». НЕ смешивай их.`
    : (has223Chunks && !hasNon223Chunks && intentResult.fz_type !== "223")
      ? `\n\nПРИМЕЧАНИЕ: Среди найденных документов есть только материалы по 223-ФЗ. Если вопрос может относиться к обоим режимам, укажи, что информация по режиму вне 223-ФЗ в текущих документах не найдена.`
      : (!has223Chunks && hasNon223Chunks && intentResult.fz_type !== "non-223")
        ? `\n\nПРИМЕЧАНИЕ: Среди найденных документов есть только материалы вне 223-ФЗ. Если вопрос может относиться к обоим режимам, укажи, что информация по 223-ФЗ в текущих документах не найдена.`
        : "";

  const uploadedDocsInstructions = hasAttachments
    ? `

РЕЖИМ ПРОВЕРКИ ДОКУМЕНТОВ:
Пользователь загрузил ${attachedDocuments.length} документ(ов) для проверки. Эти документы находятся в секции <uploaded_documents>.
Регламенты, стандарты и нормативные документы из базы знаний находятся в секции <documents>.

ТВОЯ ЗАДАЧА:
1. Тщательно проанализировать загруженные документы (<uploaded_documents>)
2. Сравнить их содержание с регламентами и стандартами из базы знаний (<documents>)
3. Выявить:
   - Соответствия и несоответствия требованиям регламентов
   - Отсутствующие обязательные пункты или разделы
   - Нарушения процедур, сроков, форматов
   - Возможные противоречия с законодательством (если применимо)
4. Ссылайся на конкретные пункты/разделы как загруженного документа, так и регламентов из базы знаний
5. Если в базе знаний не найдено подходящих регламентов — сообщи об этом явно
6. Структурируй ответ: сначала общая оценка, затем детальный анализ по пунктам

ФОРМАТ ОТВЕТА ПРИ ПРОВЕРКЕ:
- Начни с краткого резюме (соответствует / частично соответствует / не соответствует)
- Используй разделы: "Соответствия", "Несоответствия", "Рекомендации"
- Приводи дословные цитаты из обоих источников для обоснования`
    : "";

  // ── NEW: Screenshot instructions for the model ──
  const screenshotInstructions = totalImagesIncluded > 0
    ? `

СКРИНШОТЫ ИЗ ИНСТРУКЦИЙ:
К некоторым документам приложены скриншоты интерфейса CRM-системы. Они идут после текста соответствующего документа как изображения.
- Если скриншот помогает ответить на вопрос — опиши, что на нём изображено (какие кнопки, меню, поля)
- Ссылайся на скриншоты в ответе: «Как показано на скриншоте из документа N...»
- Не описывай скриншоты, если они не относятся к вопросу пользователя`
    : "";

  const systemPrompt = `Ты СнабЧат — ИИ-ассистент Дирекции по закупкам. Ты помогаешь сотрудникам с вопросами о закупках, снабжении, договорах, нормативных документах и внутренних процедурах.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА (ОБЯЗАТЕЛЬНЫ К ИСПОЛНЕНИЮ):
1. Ты ДОЛЖЕН отвечать ИСКЛЮЧИТЕЛЬНО на основе предоставленных ниже документов (<documents>). Это твой ЕДИНСТВЕННЫЙ источник информации.
2. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать свои общие знания, обучающие данные или делать предположения для дополнения ответа. Даже если ты "знаешь" что-то по теме — НЕ используй это.
3. Если информации в документах НЕДОСТАТОЧНО — прямо укажи это. НЕ пытайся заполнить пробелы.
4. Если вопрос частично покрыт документами — ответь только на покрытую часть и явно укажи, что остальное в документах отсутствует.
5. При цитировании — приводи ДОСЛОВНЫЕ цитаты из документов.
6. Перед каждым утверждением мысленно проверь: есть ли для него ПРЯМОЕ подтверждение в <documents>? Если нет — НЕ включай его в ответ.
7. НЕ вставляй ссылки на источники вида [doc:N] в текст ответа. Источники отображаются отдельно в интерфейсе.

УТОЧНЯЮЩИЕ ВОПРОСЫ:
Если запрос пользователя слишком общий, неоднозначный или может относиться к нескольким темам — ЗАДАЙ уточняющий вопрос, прежде чем давать ответ. Примеры ситуаций:
- «Как провести закупку?» → уточни: какой тип товаров/услуг, примерная сумма, какой объект/юрлицо
- «Какие сроки?» → уточни: сроки чего именно (подачи заявок, рассмотрения, поставки, оплаты)
- «Расскажи про переторжку» → можно ответить общо, но предложить уточнить режим (223-ФЗ / вне 223-ФЗ)
- Однословные запросы («НМЦД», «ЗКО», «аукцион») → уточни, что конкретно интересует
При этом НЕ задавай уточняющих вопросов, если запрос достаточно конкретный для полноценного ответа. Если можешь дать полезный ответ — дай его, а уточняющий вопрос добавь в конце как предложение для углубления темы.

ФОРМАТ ОТВЕТА:
- Используй Markdown для форматирования
- Для дословных цитат используй формат: > "цитата"
- Деловой, но дружелюбный тон
- НЕ добавляй [doc:1], [doc:2] и подобные ссылки в текст
- Когда пользователь просит составить таблицу с расчётами, итогами или формулами — используй стандартные Excel-формулы прямо в ячейках markdown-таблицы. Например: =SUM(B2:B10), =A2*B2, =AVERAGE(C2:C5), =B2/C2*100. Формулы должны ссылаться на правильные ячейки Excel (колонки A, B, C... и строки 1, 2, 3..., где строка 1 — заголовок). Пользователь сможет скачать таблицу в Excel с рабочими формулами.

ТАБЛИЦЫ — ПОДРОБНЫЕ ПРАВИЛА:
Пользователь может скачать любую таблицу из ответа в Excel. Каждый заголовок ## становится отдельным листом Excel. Поэтому:

1. СРАВНИТЕЛЬНЫЕ ТАБЛИЦЫ (когда просят сравнить):
   - Всегда используй markdown-таблицу с колонками: Параметр | Режим 1 | Режим 2
   - Включай ВСЕ параметры сравнения из документов, не сокращай
   - Пример структуры для сравнения 223-ФЗ / вне 223-ФЗ:
   | Параметр | По 223-ФЗ | Вне 223-ФЗ (ООО «СГК») |
   | Нормативный документ | Положение о закупках | Стандарт С-ГК-В5-03 |
   | Способы закупок | Конкурс, аукцион, ... | Простая закупка, ЗЦ, ЗП, ... |
   ...и т.д. по ВСЕМ различающимся параметрам.

2. МАТРИЦЫ ПОЛНОМОЧИЙ / ПОРОГОВЫЕ ТАБЛИЦЫ:
   - Используй строки = диапазоны сумм, колонки = категории/роли
   - Включай ВСЕ пороги из документов
   - Если данные есть по нескольким компаниям — создай ОТДЕЛЬНУЮ таблицу (## заголовок) для каждой компании

3. РЕЕСТРЫ И СПИСКИ:
   - Для списков > 5 элементов ВСЕГДА используй таблицу, а не буллеты
   - Стандартные колонки: №, Наименование, Описание/Значение

4. ФОРМУЛЫ И РАСЧЁТЫ:
   - Для расчётных таблиц используй Excel-формулы: =SUM(), =A2*B2, =AVERAGE()
   - Итоговая строка обязательна для числовых данных
   - Формулы ссылаются на ячейки Excel (A, B, C... и строки 1, 2, 3... где строка 1 = заголовок)

5. ОБЩИЕ ПРАВИЛА:
   - Заголовок каждой таблицы оформляй как ## (это станет именем листа в Excel)
   - НЕ оставляй пустые ячейки — пиши «—» или «Не применимо»
   - Если данных слишком много для одной таблицы — разбивай на несколько с разными ## заголовками
   - Ячейки не должны содержать символ | (используй / или ; вместо)

ОБЪЁМ И ПОЛНОТА ОТВЕТА:
- Давай РАЗВЁРНУТЫЕ, подробные ответы. Не ограничивайся 2-3 предложениями — раскрой тему максимально полно на основе доступных документов.
- Если в документах есть пошаговые процедуры — опиши ВСЕ шаги, не сокращай.
- Если есть таблицы с порогами, сроками, ролями — приведи их полностью.
- Используй структуру: заголовки, нумерованные списки, таблицы — для удобства чтения.
- Приводи дословные цитаты из документов для подтверждения ключевых утверждений.

ПРЕДЛОЖЕНИЯ ДЛЯ ДАЛЬНЕЙШЕГО ИЗУЧЕНИЯ:
В конце каждого ответа добавь блок «💡 **Вам также может быть полезно:**» с 2-3 связанными вопросами, которые пользователь может задать для углубления темы. Формулируй их как готовые вопросы, которые можно скопировать и задать. Примеры:
- Если ответ о процедуре закупки → предложи: «Какие документы нужны для этой процедуры?», «Кто согласовывает результаты?»
- Если ответ о порогах → предложи: «Какие полномочия у ЗКО по этим суммам?», «Чем отличается порядок для другого режима?»
- Если ответ о роли участника → предложи: «Какие ещё роли задействованы?», «Какой порядок взаимодействия между участниками?»

ПРИМЕР ОТВЕТА:
Вопрос: Какой срок рассмотрения заявок?
Ответ: Согласно регламенту, срок рассмотрения заявок составляет **10 рабочих дней** с даты окончания приёма. При этом комиссия вправе продлить срок на 5 дней при наличии обоснования.

> "Заявки участников рассматриваются в течение 10 (десяти) рабочих дней с даты окончания приёма"

Если по результатам рассмотрения ни одна заявка не соответствует требованиям, процедура может быть признана несостоявшейся, и заказчик вправе объявить повторную процедуру.

💡 **Вам также может быть полезно:**
- Какие документы входят в состав заявки участника?
- Какие основания для продления срока рассмотрения?
- Кто принимает решение по итогам рассмотрения заявок?

ПРИМЕР ОТКАЗА (когда информации нет):
Вопрос: Какова средняя зарплата в отделе закупок?
Ответ: В загруженных документах отсутствует информация о зарплатах сотрудников. Доступные документы содержат информацию о процедурах закупок и нормативных требованиях. Для получения данных о зарплатах рекомендую обратиться в отдел кадров.${uploadedDocsInstructions}${screenshotInstructions}${lowConfidenceWarning}${dualRegimeHint}
${intentResult.intent === "spu_search" ? `
=== РЕЕСТР СПУ (Список Потенциальных Участников) ===

В базе знаний загружен файл «Реестр СПУ контрагенты виды работ объекты». Это реестр потенциальных участников закупочных процедур СГК, содержащий 874 уникальных контрагента по 68 видам работ на 32 объектах трёх бизнес-единиц (Енисейская ТГК, Кузбассэнерго, СГК-Алтай).

КОГДА ИСПОЛЬЗОВАТЬ:
Обращайся к реестру СПУ, если пользователь спрашивает о подрядчиках, поставщиках, исполнителях, контрагентах, участниках закупки, организациях, которые выполняют определённые виды работ, или кто может выполнить работу на конкретном объекте.

КАК РАБОТАТЬ С ДАННЫМИ:
1. Определи из запроса: вид работ/услуг, объект (ГРЭС/ТЭЦ/теплосеть), бизнес-единицу.
2. Найди в реестре записи, соответствующие этим параметрам.
3. Фильтрация по статусу:
   РЕЖИМ ПО УМОЛЧАНИЮ: Если пользователь просто ищет подрядчиков/контрагентов — показывай ТОЛЬКО записи со статусами «ТКП», «ТКП MIN», «ТКП Инициатора».
   РАСШИРЕННЫЙ РЕЖИМ: Если пользователь явно просит показать компании без статуса, отказавшихся, не ответивших, или использует формулировки вроде «все компании», «кто отказался», «без ТКП», «не подтвердившие», «с отказом», «не обладающие статусом» — покажи ВСЕ записи из реестра, разделив на два блока:
     Блок 1 (основной): контрагенты со статусами ТКП / ТКП MIN / ТКП Инициатора.
     Блок 2 (дополнительный, с предупреждением): контрагенты со статусами ОТКАЗ, Нет ответа, Недозвон, Отмена запроса. Перед этим блоком выведи пояснение: «Следующие компании числятся в реестре, но не подтвердили готовность к участию в закупке:».
4. Ранжируй результаты: внутри каждого блока — сначала ТКП, затем ТКП MIN, затем ТКП Инициатора; во втором блоке — по алфавиту.
5. Для каждого контрагента указывай: наименование, ИНН, вид работ, объект, статус.

ФОРМАТ ОТВЕТА:
Если найдено 1–5 контрагентов, перечисли всех с полными данными.
Если найдено 6–15, сгруппируй по статусу (ТКП / ТКП MIN / ТКП Инициатора) и укажи количество.
Если найдено >15, укажи общее количество, покажи топ-5 и предложи уточнить запрос.
В расширенном режиме: сначала покажи основной блок (ТКП) по обычным правилам, затем отдельной секцией — компании без подтверждённого статуса с указанием причины (ОТКАЗ / Нет ответа / Недозвон / Отмена запроса).
Если ничего не найдено, сообщи об этом и предложи расширить поиск: другой вид работ, другой объект, другая БЕ.

НЕЧЁТКОЕ СООТВЕТСТВИЕ ВИДОВ РАБОТ:
Пользователи используют свободные формулировки. Сопоставляй их с категориями справочника:
«ремонт бульдозеров» / «бульдозерная техника» → Ремонт бульдозеров
«насосы» / «насосное оборудование» → Монтаж / ремонт насосного оборудования
«электрика» / «электромонтаж» → Электромонтажные работы
«проект» / «ПИР» → Проектирование
«обслуживание» / «ТО» / «сервис» → Техническое обслуживание
«строительство» / «СМР» → Общестроительные работы
«КИП» / «КИПиА» / «автоматика» → Монтаж / ремонт КИПиА
«котлы» / «котельное» → Монтаж / ремонт котлов
«турбины» / «турбинное» → Монтаж / ремонт турбинного оборудования

ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ:
Если пользователь указывает сумму закупки и объект, определи режим закупки (223-ФЗ или не 223-ФЗ) по листу «структура СГК» из того же файла и дополни ответ этой информацией.

ВАЖНО: Контактные данные (телефон, email) выводи только по прямому запросу пользователя. В обычном списке достаточно наименования, ИНН и статуса.
` : ""}
=== РАЗГРАНИЧЕНИЕ 223-ФЗ / НЕ 223-ФЗ ===

В базе знаний есть документы двух режимов закупок:
1) Закупки по 223-ФЗ — для АО (акционерных обществ) группы СГК, зарегистрированных в реестре ЕИС.
2) Закупки не по 223-ФЗ — ТОЛЬКО для ООО «СГК» (головной офис) и его филиалов (Красноярский, Кузбасский, Алтайский, Новосибирский), ОСП «СибЭМ» и других ООО.

КАК ОПРЕДЕЛИТЬ РЕЖИМ ДОКУМЕНТА:
- Смотри на теги документа в атрибутах XML (tags в <document>). Если есть тег «223-фз» — это документ по 223-ФЗ. Если «вне 223-фз» — это документ вне 223-ФЗ.
- «Положения о закупках» (АО «СГК-Алтай», АО «СГК-Новосибирск», АО «Енисейская ТГК», АО «Кузбассэнерго» и другие АО) — это документы ПО 223-ФЗ, принятые в соответствии с законом.
- «Стандарт закупок ТРУ вне 223-ФЗ» (С-ГК-В5-03) — это документ для ООО «СГК», вне 223-ФЗ.
- Не путай: «Положение о закупках» ≠ «Стандарт закупок». Положения — по 223-ФЗ, Стандарт ООО СГК — вне.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА РАЗГРАНИЧЕНИЯ:
1. Если пользователь указывает конкретный объект или юрлицо — определи режим закупки по листу «структура СГК» из файла реестра СПУ и отвечай ТОЛЬКО по этому режиму.
2. Если пользователь НЕ указывает конкретный объект и из вопроса НЕ ясно, о каком режиме идёт речь — ты ОБЯЗАН ответить ПО ОБОИМ РЕЖИМАМ. Структурируй ответ двумя блоками:

## По 223-ФЗ
[ответ на основе Положений о закупках АО и федерального закона]

## Вне 223-ФЗ (ООО «СГК»)
[ответ на основе Стандарта закупок ТРУ ООО СГК]

3. Если в предоставленных документах есть информация только по одному режиму — ответь по нему и ЯВНО укажи: «По второму режиму (223-ФЗ / вне 223-ФЗ) информация в загруженных документах не найдена».
4. НИКОГДА не смешивай правила двух режимов в одном абзаце без указания, к какому режиму относится каждое утверждение.

Раздел 03 базы знаний (Закупки по ФЗ) содержит документы для 223-ФЗ.
Раздел 04 базы знаний (Закупки не по ФЗ) содержит документы для режима вне 223-ФЗ.

=== ПРИОРИТЕТ ИСТОЧНИКОВ ===

При формировании ответа соблюдай иерархию источников:
Уровень 1 (высший): Законодательство (раздел 01: 223-ФЗ, подзаконные акты).
Уровень 2: Стандарты СГК (раздел 02), Положения о закупках (разделы 03, 04, 05).
Уровень 3: Инструкции и методики (раздел 06).
Уровень 4: Справочные материалы (разделы 07–12, включая реестр СПУ).

Если информация из разных уровней противоречит друг другу, приоритет у более высокого уровня.
При ответе указывай источник: «Согласно Положению о закупках…», «В соответствии с Инструкцией…».

=== УЧЕБНЫЕ КУРСЫ ===

В базе знаний загружены учебные курсы:
1) «Закупки по 223-ФЗ» — способы закупок, пороги, роли, ЗКО, НМЦД
2) «Закупки вне 223-ФЗ» — стандарт СГК 2.0, матрица полномочий, 12 фаз закупки
3) «Планирование закупок» — SAP-коды, сроки, ценообразование

КОГДА ИСПОЛЬЗОВАТЬ:
- Когда пользователь спрашивает «как провести закупку», «какой порядок», «с чего начать»
- Когда вопрос касается обучения новых сотрудников или onboarding
- Когда нужно объяснить разницу между способами закупок
Сочетай информацию из курсов с цитатами из нормативных документов.

${ragContext || "В базе знаний не найдено релевантных документов по данному запросу. Сообщи пользователю, что по его вопросу документы не найдены."}

${uploadedDocsContext}`;

  // ── Build multimodal messages for the model ──
  // System prompt goes as system, then we build user/assistant messages
  // with images interleaved

  const modelMessages: CoreMessage[] = [];

  // Add context messages
  const ctxMsgs = contextMessages.filter((m) => m.role !== "system");
  if (ctxMsgs.length > 0) {
    for (const m of ctxMsgs) {
      if (m.role === "user") {
        modelMessages.push({ role: "user" as const, content: m.content as string });
      } else if (m.role === "assistant") {
        modelMessages.push({ role: "assistant" as const, content: m.content as string });
      }
    }
  } else {
    // Use messages from request (excluding last, we'll add it with images)
    for (let k = 0; k < messages.length - 1; k++) {
      const msg = messages[k];
      if (msg.role === "user") {
        modelMessages.push({ role: "user" as const, content: msg.content as string });
      } else if (msg.role === "assistant") {
        modelMessages.push({ role: "assistant" as const, content: msg.content as string });
      }
    }
  }

  // Build the final user message with multimodal content (text + chunk images)
  if (totalImagesIncluded > 0) {
    // Multimodal message: text + images from relevant chunks
    const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];

    // User's question text
    parts.push({ type: "text", text: userMessage.content });

    // Append chunk images with labels
    for (let ci = 0; ci < chunksWithImages.length; ci++) {
      const cw = chunksWithImages[ci];
      if (cw.imageBase64.length > 0) {
        parts.push({
          type: "text",
          text: `\n[Скриншоты из документа "${cw.source_filename}", чанк ${cw.chunk_index}]:`,
        });
        for (const img of cw.imageBase64) {
          parts.push({
            type: "image",
            image: `data:${img.mimeType};base64,${img.base64}`,
          });
        }
      }
    }

    modelMessages.push({
      role: "user",
      content: parts,
    });
  } else {
    // Plain text message (no images in chunks)
    const lastModel = modelMessages[modelMessages.length - 1];
    if (
      !lastModel ||
      lastModel.role !== "user" ||
      lastModel.content !== userMessage.content
    ) {
      modelMessages.push({
        role: "user",
        content: userMessage.content,
      });
    }
  }

  // Filter out only "ugly" denormalized files (per-line tagged technical artifacts)
  // from source citations. Well-formatted denormalized .md files (table descriptions,
  // matrices, etc.) remain visible — users can open and read them.
  const HIDDEN_DENORM_TAGS = ["ценообразование", "инструкция", "индексы", "схемы"];
  const sourceFilenames = [...new Set(
    relevantChunks
      .filter((r) => {
        const tags = r.tags.map((t: string) => t.toLowerCase());
        const isDenorm = tags.includes("денормализовано");
        if (!isDenorm) return true;
        // Denormalized file — hide only if it has a technical-folder tag
        return !tags.some((t: string) => HIDDEN_DENORM_TAGS.includes(t));
      })
      .map((r) => r.source_filename)
  )];

  // ── Build proxy URLs for chunk images to pass to frontend ──
  interface ChunkImageUrl {
    url: string;
    source: string;
    chunk: number;
  }
  const chunkImageUrls: ChunkImageUrl[] = [];
  for (const cw of chunksWithImages) {
    if (cw.imageBase64.length === 0) continue;
    const originalChunk = relevantChunks.find(
      (c) => c.source_filename === cw.source_filename && c.chunk_index === cw.chunk_index
    );
    if (!originalChunk?.image_paths) continue;
    const pathsToProxy = originalChunk.image_paths.slice(0, MAX_CHUNK_IMAGES);
    for (const path of pathsToProxy) {
      chunkImageUrls.push({
        url: `/api/chunk-image?path=${encodeURIComponent(path)}&token=${encodeURIComponent(invite.code)}`,
        source: cw.source_filename,
        chunk: cw.chunk_index,
      });
    }
  }

  // ── Generate response via @google/genai directly ──
  // @ai-sdk/google cannot parse thought_signature tokens from Gemini 3.x,
  // so we call @google/genai SDK and stream using the AI SDK data protocol.
  const modelId = "gemini-3-flash-preview";
  const genaiClient = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });

  // Convert CoreMessage[] → @google/genai Content format
  type GenAIPart = { text: string } | { inlineData: { mimeType: string; data: string } };
  const genaiContents: Array<{ role: string; parts: GenAIPart[] }> = [];
  for (const msg of modelMessages) {
    const role = msg.role === "assistant" ? "model" : "user";
    if (typeof msg.content === "string") {
      genaiContents.push({ role, parts: [{ text: msg.content }] });
    } else if (Array.isArray(msg.content)) {
      const parts: GenAIPart[] = [];
      for (const part of msg.content as Array<{ type: string; text?: string; image?: string }>) {
        if (part.type === "text" && part.text) {
          parts.push({ text: part.text });
        } else if (part.type === "image" && part.image) {
          const m = (part.image as string).match(/^data:([^;]+);base64,(.+)$/);
          if (m) {
            parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
          }
        }
      }
      if (parts.length > 0) genaiContents.push({ role, parts });
    }
  }

  const genaiStream = await genaiClient.models.generateContentStream({
    model: modelId,
    contents: genaiContents,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0,
    },
  });

  // Pipe @google/genai stream → AI SDK data stream protocol
  // Protocol: "0:" prefix = text delta (JSON-encoded), "e:" = finish step, "d:" = finish message
  let fullText = "";
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of genaiStream) {
          const text = chunk.text ?? "";
          if (text) {
            fullText += text;
            controller.enqueue(encoder.encode(`0:${JSON.stringify(text)}\n`));
          }
        }
        // Finish signals expected by useChat on the frontend
        const finish = JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 }, isContinued: false });
        controller.enqueue(encoder.encode(`e:${finish}\n`));
        controller.enqueue(encoder.encode(`d:${finish}\n`));
        controller.close();

        // Save assistant message to DB (fire-and-forget)
        if (conversationId) {
          const metadata: Record<string, unknown> = { model: modelId };
          if (sourceFilenames.length > 0) metadata.sources = sourceFilenames;
          if (lowConfidence) metadata.lowConfidence = true;
          if (totalImagesIncluded > 0) metadata.imagesUsed = totalImagesIncluded;
          if (chunkImageUrls.length > 0) metadata.chunkImages = chunkImageUrls;
          saveMessage(conversationId, "assistant", fullText,
            Object.keys(metadata).length > 0 ? metadata : undefined
          ).catch((e) => console.error("[chat] Failed to save assistant message:", e));
        }
      } catch (err) {
        console.error("[chat] Generation stream error:", err);
        const errStr = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`3:${JSON.stringify(errStr)}\n`));
        controller.close();
      }
    },
  });

  const responseHeaders: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Sources": encodeURIComponent(JSON.stringify(sourceFilenames)),
  };
  if (chunkImageUrls.length > 0) {
    responseHeaders["X-Chunk-Images"] = encodeURIComponent(JSON.stringify(chunkImageUrls));
  }

  return new Response(readable, { headers: responseHeaders });
 } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logError({
      type: "chat",
      message: errMsg,
      endpoint: "/api/chat",
    }).catch(() => {});

    // Return specific status codes so the frontend can show targeted messages
    if (/429|too many requests|rate.?limit|quota/i.test(errMsg)) {
      return NextResponse.json({ error: "Превышен лимит запросов к ИИ" }, { status: 429 });
    }
    if (/503|unavailable|overloaded/i.test(errMsg)) {
      return NextResponse.json({ error: "Сервис ИИ временно недоступен" }, { status: 503 });
    }
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
 }
}
