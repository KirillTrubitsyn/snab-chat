import { NextRequest, NextResponse } from "next/server";
import { validateInviteCode } from "@/app/lib/auth";
import { requestLoginApprovalSchema, parseBody } from "@/app/lib/validation";
import { createServiceClient } from "@/app/lib/supabase";
import { send2FAMessage } from "@/app/lib/telegram";
import { getMoscowTime } from "@/app/lib/date-utils";

function getClientIP(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * POST /api/auth/request-login-approval
 * Создаёт запрос на подтверждение входа и отправляет push-уведомление в Telegram.
 * Body: { code }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const { data, error } = parseBody(raw, requestLoginApprovalSchema);
    if (error) return error;

    const upperCode = data.code.toUpperCase();
    const invite = await validateInviteCode(upperCode);
    if (!invite) {
      return NextResponse.json({ error: "Неверный инвайт-код" }, { status: 401 });
    }

    const supabase = createServiceClient();
    const { data: codeData } = await supabase
      .from("invite_codes")
      .select("telegram_chat_id")
      .eq("id", invite.id)
      .single();

    if (!codeData?.telegram_chat_id) {
      return NextResponse.json({ error: "Telegram не привязан" }, { status: 400 });
    }

    // Истечь старые pending approvals
    await supabase
      .from("login_approvals")
      .update({ status: "denied", resolved_at: new Date().toISOString() })
      .eq("invite_code_id", invite.id)
      .eq("status", "pending");

    const ipAddress = getClientIP(req);
    const userAgent = req.headers.get("user-agent") || "";

    // Определить геолокацию по IP
    let location = "";
    try {
      const geoRes = await fetch(`https://ipwho.is/${ipAddress}?lang=ru`);
      if (geoRes.ok) {
        const geo = await geoRes.json();
        if (geo.success) {
          location = [geo.city, geo.country].filter(Boolean).join(", ");
        }
      }
    } catch { /* ignore geo errors */ }

    // Создать новый запрос на подтверждение
    const { data: approval, error: insertError } = await supabase
      .from("login_approvals")
      .insert({
        invite_code_id: invite.id,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .select("id")
      .single();

    if (insertError || !approval) {
      console.error("[request-login-approval] DB error:", insertError?.message);
      return NextResponse.json({ error: "Ошибка создания запроса" }, { status: 500 });
    }

    // Отправить уведомление в Telegram
    const locationLine = location ? `\n📍 ${escapeHtml(location)}` : "";
    const text =
      `🔐 <b>Вход в СнабЧат</b>\n\n` +
      `Кто-то входит в ваш аккаунт:\n` +
      `👤 <b>${escapeHtml(invite.name)}</b>\n` +
      `🌐 ${escapeHtml(ipAddress)}${locationLine}\n` +
      `🕐 ${getMoscowTime()}\n\n` +
      `Это вы?`;

    const replyMarkup = {
      inline_keyboard: [[
        { text: "\u2705 Да, это я", callback_data: `login_approve:${approval.id}` },
        { text: "\u274c Нет, не я", callback_data: `login_deny:${approval.id}` },
      ]],
    };

    const sent = await send2FAMessage(text, codeData.telegram_chat_id, replyMarkup);
    if (!sent) {
      return NextResponse.json(
        { error: "Ошибка отправки уведомления в Telegram" },
        { status: 500 }
      );
    }

    return NextResponse.json({ approval_id: approval.id });
  } catch {
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
