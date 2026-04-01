import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { unauthorizedResponse, serverError, notFound, ok } from "@/app/lib/api-helpers";

export async function GET(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return unauthorizedResponse();
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    console.error("Supabase init error:", e); return serverError();
  }

  let query = supabase
    .from("conversations")
    .select("id, title, created_at, updated_at, summary, invite_code_id")
    .order("updated_at", { ascending: false })
    .limit(50);

  // Фильтрация: каждый видит только свои диалоги
  if (isAdminCode(invite.code)) {
    query = query.eq("admin_name", invite.name);
  } else {
    query = query.eq("invite_code_id", invite.id);
  }

  let data = null;
  let error = null;

  for (let attempt = 0; attempt <= 1; attempt++) {
    ({ data, error } = await query);
    if (!error) break;
    const msg = error.message ?? "";
    if (attempt === 0 && /fetch|network|ECONNR|timeout|socket/i.test(msg)) {
      console.warn("[conversations] GET transient error, retrying:", msg);
      await new Promise((r) => setTimeout(r, 1000));
      // Re-create query for retry
      query = supabase
        .from("conversations")
        .select("id, title, created_at, updated_at, summary, invite_code_id")
        .order("updated_at", { ascending: false })
        .limit(50);
      if (isAdminCode(invite.code)) {
        query = query.eq("admin_name", invite.name);
      } else {
        query = query.eq("invite_code_id", invite.id);
      }
      continue;
    }
    break;
  }

  if (error) {
    console.error("DB error:", error.message); return serverError();
  }

  return NextResponse.json(
    (data || []).map((c) => ({
      ...c,
      hasSummary: !!c.summary,
      summary: undefined,
    }))
  );
}

export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return unauthorizedResponse();
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    console.error("Supabase init error:", e); return serverError();
  }
  const body = await req.json().catch(() => ({}));
  const title = body.title || "Новый диалог";

  // Для админов invite_code_id = null (они не привязаны к инвайт-кодам в БД)
  const isAdmin = isAdminCode(invite.code);
  const inviteCodeId = isAdmin ? null : invite.id;

  let insertData: Record<string, unknown> = { title, invite_code_id: inviteCodeId };
  if (isAdmin) {
    insertData.admin_name = invite.name;
  }

  // Retry logic for transient Supabase errors (TypeError: fetch failed)
  let data = null;
  let error = null;
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    ({ data, error } = await supabase
      .from("conversations")
      .insert(insertData)
      .select("id, title, created_at, updated_at")
      .single());

    // If admin_name column doesn't exist yet, retry without it
    if (error && isAdmin && error.message?.includes("admin_name")) {
      ({ data, error } = await supabase
        .from("conversations")
        .insert({ title, invite_code_id: inviteCodeId })
        .select("id, title, created_at, updated_at")
        .single());
    }

    if (!error) break;

    // Retry only on transient network errors
    const msg = error.message ?? "";
    if (attempt < MAX_RETRIES && /fetch|network|ECONNR|timeout|socket/i.test(msg)) {
      console.warn(`[conversations] Transient DB error (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, msg);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    break;
  }

  if (error) {
    console.error("DB error:", error.message); return serverError();
  }

  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    return unauthorizedResponse();
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    console.error("Supabase init error:", e); return serverError();
  }
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const all = searchParams.get("all");

  // Delete all conversations
  if (all === "true") {
    if (isAdminCode(invite.code)) {
      // Админ может удалить всё
      await supabase.from("messages").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      const { error } = await supabase.from("conversations").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) {
        console.error("DB error:", error.message); return serverError();
      }
    } else {
      // Обычный пользователь удаляет только свои диалоги
      const { data: ownedConvs } = await supabase
        .from("conversations")
        .select("id")
        .eq("invite_code_id", invite.id);

      const ownedIds = (ownedConvs || []).map((c: { id: string }) => c.id);
      if (ownedIds.length > 0) {
        await supabase.from("messages").delete().in("conversation_id", ownedIds);
        const { error } = await supabase.from("conversations").delete().in("id", ownedIds);
        if (error) {
          console.error("DB error:", error.message); return serverError();
        }
      }
    }
    return ok();
  }

  // Bulk delete by ids in body
  if (!id) {
    try {
      const body = await req.json();
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        let idsToDelete = body.ids;

        // Для обычных пользователей — удаляем только свои диалоги
        if (!isAdminCode(invite.code)) {
          const { data: ownedConvs } = await supabase
            .from("conversations")
            .select("id")
            .in("id", body.ids)
            .eq("invite_code_id", invite.id);

          idsToDelete = (ownedConvs || []).map((c: { id: string }) => c.id);
          if (idsToDelete.length === 0) {
            return notFound("Диалоги не найдены");
          }
        }

        await supabase.from("messages").delete().in("conversation_id", idsToDelete);
        const { error } = await supabase.from("conversations").delete().in("id", idsToDelete);
        if (error) {
          console.error("DB error:", error.message); return serverError();
        }
        return ok();
      }
    } catch {
      // no body
    }
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Проверяем принадлежность диалога (если не админ)
  if (!isAdminCode(invite.code)) {
    const { data: conv } = await supabase
      .from("conversations")
      .select("invite_code_id")
      .eq("id", id)
      .single();

    if (!conv || conv.invite_code_id !== invite.id) {
      return notFound("Диалог не найден");
    }
  }

  // Delete messages first
  await supabase.from("messages").delete().eq("conversation_id", id);
  const { error } = await supabase.from("conversations").delete().eq("id", id);

  if (error) {
    console.error("DB error:", error.message); return serverError();
  }

  return NextResponse.json({ ok: true });
}
