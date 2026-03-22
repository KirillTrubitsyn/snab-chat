import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Требуется инвайт-код" }, { status: 401 });
  }

  const supabase = createServiceClient();

  // Проверяем принадлежность диалога (если не админ)
  if (!isAdminCode(invite.code)) {
    const { data: conv } = await supabase
      .from("conversations")
      .select("invite_code_id")
      .eq("id", id)
      .single();

    if (!conv || conv.invite_code_id !== invite.id) {
      return NextResponse.json({ error: "Диалог не найден" }, { status: 404 });
    }
  }

  const [messagesResult, convResult] = await Promise.all([
    supabase
      .from("messages")
      .select("id, role, content, created_at")
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
