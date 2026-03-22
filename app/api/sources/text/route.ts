import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data: source } = await supabase
      .from("sources")
      .select("filename, mime_type")
      .eq("id", id)
      .single();

    if (!source) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const { data: chunks, error } = await supabase
      .from("chunks")
      .select("chunk_index, content")
      .eq("source_id", id)
      .order("chunk_index", { ascending: true });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const fullText = (chunks || []).map((c) => c.content).join("\n\n");

    return NextResponse.json({
      filename: source.filename,
      mimeType: source.mime_type,
      text: fullText,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
