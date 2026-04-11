import { NextRequest, NextResponse } from "next/server";
import { searchContractorCards } from "@/app/lib/retrieval";
import { classifyIntent } from "@/app/lib/intent-classifier";
import { createServiceClient } from "@/app/lib/supabase";
import { embedQuery } from "@/app/lib/embeddings";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") ?? "ТК АВТОПЛЮС расскажи о компании";

  try {
    const supabase = createServiceClient();
    const debug: Record<string, unknown> = {};

    // Step 1: Classify intent
    const intent = await classifyIntent(query);
    debug.intent = { intent: intent.intent, confidence: intent.confidence, tags: intent.search_tags };

    // Step 2: Test RPC
    const embedding = await embedQuery(query);
    const embeddingStr = `[${embedding.join(",")}]`;
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "search_contractor_cards",
      { query_text: query, query_embedding: embeddingStr, match_count: 5 }
    );
    debug.rpc = { error: rpcError?.message ?? null, count: rpcData?.length ?? 0 };

    // Step 3: Test FTS directly
    const { data: fts1, error: ftsErr1 } = await supabase
      .from("chunks")
      .select("id, source_filename")
      .contains("tags", ["карточка контрагента"])
      .textSearch("fts", "АВТОПЛЮС", { type: "plain", config: "russian" })
      .limit(5);
    debug.fts_АВТОПЛЮС = { count: fts1?.length ?? 0, error: ftsErr1?.message ?? null, files: fts1?.map((r: { source_filename: string }) => r.source_filename) };

    // Step 4: Test ILIKE directly
    const { data: ilike1, error: ilikeErr1 } = await supabase
      .from("chunks")
      .select("id, source_filename")
      .contains("tags", ["карточка контрагента"])
      .ilike("content", "%АВТОПЛЮС%")
      .limit(5);
    debug.ilike_content = { count: ilike1?.length ?? 0, error: ilikeErr1?.message ?? null, files: ilike1?.map((r: { source_filename: string }) => r.source_filename) };

    // Step 5: Test filename ILIKE
    const { data: fn1, error: fnErr1 } = await supabase
      .from("chunks")
      .select("id, source_filename")
      .contains("tags", ["карточка контрагента"])
      .ilike("source_filename", "%АВТОПЛЮС%")
      .limit(5);
    debug.ilike_filename = { count: fn1?.length ?? 0, error: fnErr1?.message ?? null, files: fn1?.map((r: { source_filename: string }) => r.source_filename) };

    // Step 6: Run full searchContractorCards
    const results = await searchContractorCards(query, 10);
    debug.searchContractorCards = {
      totalResults: results.length,
      top3: results.slice(0, 3).map((r) => ({
        file: r.source_filename,
        sim: r.similarity,
      })),
    };

    return NextResponse.json(debug);
  } catch (error: unknown) {
    return NextResponse.json({ error: String(error), query }, { status: 500 });
  }
}
