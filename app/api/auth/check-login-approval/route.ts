import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

/**
 * GET /api/auth/check-login-approval?id=xxx
 * Проверяет статус запроса на подтверждение входа (поллинг с фронтенда).
 */
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "ID не указан" }, { status: 400 });
    }

    const supabase = createServiceClient();
    const { data: approval, error } = await supabase
      .from("login_approvals")
      .select("id, invite_code_id, status, expires_at")
      .eq("id", id)
      .single();

    if (error || !approval) {
      return NextResponse.json({ error: "Запрос не найден" }, { status: 404 });
    }

    // Проверить таймаут
    if (approval.status === "pending" && new Date(approval.expires_at) < new Date()) {
      return NextResponse.json({ status: "expired" });
    }

    if (approval.status === "approved") {
      // Вернуть данные пользователя для завершения входа
      const { data: invite } = await supabase
        .from("invite_codes")
        .select("id, code, name")
        .eq("id", approval.invite_code_id)
        .single();

      return NextResponse.json({
        status: "approved",
        inviteCodeId: invite?.id,
        name: invite?.name,
        code: invite?.code,
      });
    }

    return NextResponse.json({ status: approval.status });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
