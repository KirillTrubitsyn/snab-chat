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

  const markdown = chunks.map((c) => c.content).join("\n\n");
  return NextResponse.json({ markdown });
}
