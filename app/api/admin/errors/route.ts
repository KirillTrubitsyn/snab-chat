import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10);
  const type = req.nextUrl.searchParams.get("type"); // chat, parse, ingest, client
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let query = supabase
    .from("error_logs")
    .select("id, error_type, error_message, endpoint, user_name, organization, metadata, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);

  if (type && type !== "all") query = query.eq("error_type", type);

  const { data, error } = await query;
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  return NextResponse.json({ errors: data ?? [] });
}

export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id обязателен" }, { status: 400 });

  const supabase = createServiceClient();
  const { error } = await supabase.from("error_logs").delete().eq("id", id);
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
