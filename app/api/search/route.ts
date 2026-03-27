import { NextRequest, NextResponse } from "next/server";
import { hybridSearch } from "@/app/lib/retrieval";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

export async function POST(req: NextRequest) {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return unauthorizedResponse();

    const { query, topK = 20, tags = null } = await req.json();

    if (!query) {
      return NextResponse.json(
        { error: "Query is required" },
        { status: 400 }
      );
    }

    const results = await hybridSearch(query, topK, tags);
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500 }
    );
  }
}
