import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: chunks, error } = await supabase
    .from("chunks")
    .select("content, chunk_index")
    .eq("source_id", id)
    .order("chunk_index", { ascending: true });

  if (error || !chunks || chunks.length === 0) {
    return NextResponse.json(
      { error: "No content available" },
      { status: 404 }
    );
  }

  const markdown = chunks
    .map((c) => {
      // Strip metadata preamble (\uD83D\uDCC4 \u0414\u043E\u043A\u0443\u043C\u0435\u043D\u0442: ... | ...)
      const text = c.content;
      const preambleEnd = text.indexOf("\n\n");
      if (preambleEnd > 0 && preambleEnd < 300 && text.charCodeAt(0) > 127) {
        return text.slice(preambleEnd + 2);
      }
      return text;
    })
    .join("\n\n");
  return NextResponse.json({ markdown });
}
