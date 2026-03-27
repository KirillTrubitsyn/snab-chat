import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: queries, error } = await supabase
    .from("off_topic_queries")
    .select("id, user_name, organization, category, query_text, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  const items = queries ?? [];

  // Stats
  const byCategory: Record<string, number> = {};
  const byUser: Record<string, { count: number; lastQuery: string; lastDate: string }> = {};
  for (const q of items) {
    byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
    if (!byUser[q.user_name]) {
      byUser[q.user_name] = { count: 0, lastQuery: q.query_text, lastDate: q.created_at };
    }
    byUser[q.user_name].count++;
  }

  return NextResponse.json({
    queries: items,
    stats: { total: items.length, by_category: byCategory, by_user: byUser },
  });
}

export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id обязателен" }, { status: 400 });

  const supabase = createServiceClient();
  const { error } = await supabase.from("off_topic_queries").delete().eq("id", id);
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
