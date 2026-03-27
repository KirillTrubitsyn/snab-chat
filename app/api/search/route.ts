import { NextRequest, NextResponse } from "next/server";
import { hybridSearch } from "@/app/lib/retrieval";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";
import { searchSchema, parseBody } from "@/app/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return unauthorizedResponse();

    const raw = await req.json();
    const { data, error: valError } = parseBody(raw, searchSchema);
    if (valError) return valError;

    const results = await hybridSearch(data.query, data.topK ?? 20, data.tags ?? null);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500 }
    );
  }
}
