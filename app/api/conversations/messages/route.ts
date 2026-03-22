import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const [messagesResult, convResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id, role, content, metadata, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("conversations")
      .select("id, title, summary")
      .eq("id", id)
      .single(),
  ]);

  if (messagesResult.error) {
    return NextResponse.json(
      { error: messagesResult.error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    messages: messagesResult.data,
    conversation: convResult.data
      ? {
          ...convResult.data,
          hasSummary: !!convResult.data.summary,
          summary: undefined,
        }
      : null,
  });
}
