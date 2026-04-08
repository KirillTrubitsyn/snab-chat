import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";

/**
 * GET /api/infographics — list infographics for the current user
 * Returns lightweight list (no image_base64) for sidebar cards.
 */
export async function GET(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const isAdmin = isAdminCode(invite.code);

  // For admins, we get infographics from conversations owned by this admin.
  // For users, filter by invite_code_id directly.
  let query = supabase
    .from("infographics")
    .select("id, topic, style, aspect_ratio, description, created_at, conversation_id")
    .order("created_at", { ascending: false })
    .limit(100);

  if (isAdmin) {
    query = query.is("invite_code_id", null);
  } else {
    query = query.eq("invite_code_id", invite.id);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Infographics GET error:", error.message);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }

  return NextResponse.json({ infographics: data || [] });
}

/**
 * GET single infographic with image_base64 by id (for viewing)
 * Uses searchParam ?id=xxx
 */
export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await req.json();
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const isAdmin = isAdminCode(invite.code);

    let viewQuery = supabase
      .from("infographics")
      .select("id, topic, style, aspect_ratio, description, image_base64, created_at")
      .eq("id", id);
    if (!isAdmin) {
      viewQuery = viewQuery.eq("invite_code_id", invite.id);
    }
    const { data, error } = await viewQuery.single();

    if (error || !data) {
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    }

    return NextResponse.json({ infographic: data });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}

/**
 * DELETE /api/infographics?id=xxx — delete one infographic
 */
export async function DELETE(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = isAdminCode(invite.code);
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  let delQuery = supabase.from("infographics").delete().eq("id", id);
  if (!isAdmin) {
    delQuery = delQuery.eq("invite_code_id", invite.id);
  }
  const { error } = await delQuery;

  if (error) {
    console.error("Infographics DELETE error:", error.message);
    return NextResponse.json({ error: "Ошибка удаления" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/infographics — rename an infographic
 */
export async function PATCH(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = isAdminCode(invite.code);
  const { id, topic } = await req.json();
  if (!id || !topic || typeof topic !== "string") {
    return NextResponse.json({ error: "Missing id or topic" }, { status: 400 });
  }

  const supabase = createServiceClient();

  let patchQuery = supabase
    .from("infographics")
    .update({ topic: topic.trim().slice(0, 200) })
    .eq("id", id);
  if (!isAdmin) {
    patchQuery = patchQuery.eq("invite_code_id", invite.id);
  }
  const { error } = await patchQuery;

  if (error) {
    console.error("Rename infographic error:", error.message);
    return NextResponse.json({ error: "Ошибка переименования" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
