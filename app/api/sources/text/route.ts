import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

export async function GET(req: NextRequest) {
  try {
    const invite = await getInviteCodeFromHeader(req);
    if (!invite) return unauthorizedResponse();

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
      console.error("DB error:", error.message);
      return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
    }

    const fullText = (chunks || []).map((c) => c.content).join("\n\n");

    return NextResponse.json({
      filename: source.filename,
      mimeType: source.mime_type,
      text: fullText,
    });
  } catch (err: unknown) {
    console.error("Sources text error:", err);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
