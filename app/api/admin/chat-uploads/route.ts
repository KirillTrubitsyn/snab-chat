import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin, getInviteCodeFromHeader, ADMIN_NAMES_BY_NUMBER } from "@/app/lib/auth";
import { badRequest, ok } from "@/app/lib/api-helpers";

function resolveAdminName(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const m = stored.match(/^Админ (\d+)$/);
  if (m) return ADMIN_NAMES_BY_NUMBER[parseInt(m[1], 10)] ?? stored;
  return stored;
}

// POST /api/admin/chat-uploads
// Вызывается из Chat.tsx когда пользователь прикрепляет документ — логирует в audit_log
export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  const rawFilenames = body.filenames;
  const filenames: string[] = Array.isArray(rawFilenames)
    ? rawFilenames.filter((f): f is string => typeof f === "string").slice(0, 20)
    : [];

  if (filenames.length === 0) return ok();

  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : null;

  const supabase = createServiceClient();
  await supabase.from("audit_log").insert(
    filenames.map((filename) => ({
      action: "document.chat_upload",
      admin_name: invite.name || "Пользователь",
      target_id: conversationId,
      details: {
        filename,
        organization: invite.organization ?? null,
        invite_code: invite.code,
      },
    }))
  );

  return NextResponse.json({ ok: true });
}

// GET /api/admin/chat-uploads
// Для AdminPanel — возвращает историю загрузок документов в чат
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("audit_log")
    .select("id, admin_name, details, created_at")
    .eq("action", "document.chat_upload")
    .order("created_at", { ascending: false })
    .limit(300);

  const items = (data || []).map((row) => {
    const details = (row.details || {}) as Record<string, unknown>;
    return {
      id: row.id,
      type: "document" as const,
      user_name: resolveAdminName(row.admin_name) || "Пользователь",
      organization: (details.organization as string | null) ?? null,
      content: (details.filename as string) || "Документ",
      model: null as string | null,
      created_at: row.created_at,
    };
  });

  return NextResponse.json({ uploads: items });
}
