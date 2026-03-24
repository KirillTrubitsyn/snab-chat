import { NextRequest, NextResponse } from "next/server";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";

export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return NextResponse.json({ error: "Требуется инвайт-код" }, { status: 401 });

  const { error_message, error_type, endpoint } = await req.json();
  if (!error_message || typeof error_message !== "string") {
    return NextResponse.json({ error: "error_message обязателен" }, { status: 400 });
  }

  await logError({
    type: error_type ?? "client",
    message: error_message.slice(0, 5000),
    endpoint: endpoint ?? null,
    userName: invite.name,
    organization: invite.organization ?? null,
    inviteCodeId: invite.id,
  });

  return NextResponse.json({ success: true });
}
