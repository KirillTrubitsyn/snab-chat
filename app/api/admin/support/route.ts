import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin, getAdminNumber } from "@/app/lib/auth";
import { notifySupportReply } from "@/app/lib/telegram";
import { supportReplySchema, parseBody } from "@/app/lib/validation";
import { logAuditEvent } from "@/app/lib/audit-log";

export async function GET(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const supabase = createServiceClient();
  const status = req.nextUrl.searchParams.get("status"); // open, answered, closed

  let query = supabase
    .from("support_messages")
    .select("id, user_name, organization, message, admin_reply, admin_number, status, created_at, replied_at")
    .order("created_at", { ascending: false })
    .limit(500);

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  const items = data ?? [];
  const stats = {
    total: items.length,
    open: items.filter((m) => m.status === "open").length,
    answered: items.filter((m) => m.status === "answered").length,
    closed: items.filter((m) => m.status === "closed").length,
  };

  return NextResponse.json({ messages: items, stats });
}

export async function PATCH(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const rawCode = decodeURIComponent(req.headers.get("x-admin-code") ?? "");
  const adminNumber = getAdminNumber(rawCode);
  const { adminName } = adminCheck;

  const raw = await req.json();
  const { data: body, error: valError } = parseBody(raw, supportReplySchema);
  if (valError) return valError;
  const { id, reply, status: newStatus } = body;

  const supabase = createServiceClient();
  const update: Record<string, unknown> = {};

  if (reply && typeof reply === "string") {
    update.admin_reply = reply.trim().slice(0, 5000);
    update.admin_number = adminNumber;
    update.status = "answered";
    update.replied_at = new Date().toISOString();
  }

  if (newStatus && ["open", "answered", "closed"].includes(newStatus)) {
    update.status = newStatus;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Нечего обновлять" }, { status: 400 });
  }

  const { error } = await supabase.from("support_messages").update(update).eq("id", id);
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  // Notify other admins about the reply
  if (reply) {
    const { data: msg } = await supabase
      .from("support_messages")
      .select("user_name")
      .eq("id", id)
      .single();
    const userName = msg?.user_name;
    if (userName) {
      notifySupportReply(adminName, userName, reply).catch(() => {});
    }
  }

  logAuditEvent({ action: reply ? "support.reply" : "support.status_change", adminName: adminCheck.adminName, targetId: id, details: { newStatus, hasReply: !!reply } });
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id обязателен" }, { status: 400 });

  const supabase = createServiceClient();
  const { error } = await supabase.from("support_messages").delete().eq("id", id);
  if (error) {
    console.error("DB error:", error.message);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }

  logAuditEvent({ action: "support.delete", adminName: adminCheck.adminName, targetId: id });
  return NextResponse.json({ deleted: true });
}
