import { NextRequest, NextResponse } from "next/server";
import { searchContractorCards } from "@/app/lib/retrieval";
import { classifyIntent } from "@/app/lib/intent-classifier";
import { createServiceClient } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") ?? "ТК АВТОПЛЮС расскажи о компании";

  try {
    const debug: Record<string, unknown> = {};

    // Check env vars (only show first/last chars for security)
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    debug.env = {
      url_set: !!url,
      url_preview: url.slice(0, 30) + "...",
      key_set: !!key,
      key_length: key.length,
      key_start: key.slice(0, 10) + "...",
      key_end: "..." + key.slice(-10),
      google_key_set: !!process.env.GOOGLE_API_KEY,
    };

    // Step 1: Classify intent
    const intent = await classifyIntent(query);
    debug.intent = { intent: intent.intent, confidence: intent.confidence, tags: intent.search_tags };

    // Step 2: Direct Supabase test (simple query, no RPC)
    const supabase = createServiceClient();
    const { data: simpleTest, error: simpleErr } = await supabase
      .from("chunks")
      .select("id, source_filename")
      .ilike("source_filename", "%АВТОПЛЮС%")
      .limit(3);
    debug.simple_query = {
      count: simpleTest?.length ?? 0,
      error: simpleErr?.message ?? null,
      errorCode: simpleErr?.code ?? null,
      files: simpleTest?.map((r: { source_filename: string }) => r.source_filename),
    };

    // Step 3: Same with tag filter
    const { data: tagTest, error: tagErr } = await supabase
      .from("chunks")
      .select("id, source_filename")
      .contains("tags", ["карточка контрагента"])
      .ilike("source_filename", "%АВТОПЛЮС%")
      .limit(3);
    debug.tag_query = {
      count: tagTest?.length ?? 0,
      error: tagErr?.message ?? null,
      files: tagTest?.map((r: { source_filename: string }) => r.source_filename),
    };

    // Step 4: Run full searchContractorCards
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
