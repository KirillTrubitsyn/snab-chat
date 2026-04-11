import { NextRequest, NextResponse } from "next/server";
import { searchContractorCards } from "@/app/lib/retrieval";
import { classifyIntent } from "@/app/lib/intent-classifier";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q") ?? "ТК АВТОПЛЮС расскажи о компании";

  try {
    // Step 1: Classify intent
    const intent = await classifyIntent(query);

    // Step 2: Run contractor search
    const results = await searchContractorCards(query, 10);

    return NextResponse.json({
      query,
      intent: {
        intent: intent.intent,
        confidence: intent.confidence,
        search_tags: intent.search_tags,
      },
      contractorResults: results.slice(0, 5).map((r) => ({
        source_filename: r.source_filename,
        similarity: r.similarity,
        tags: r.tags.slice(0, 3),
        content_preview: r.content.slice(0, 200),
      })),
      totalResults: results.length,
    });
  } catch (error: unknown) {
    return NextResponse.json({
      error: String(error),
      query,
    }, { status: 500 });
  }
}
