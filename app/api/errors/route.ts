import { NextRequest, NextResponse } from "next/server";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";
import { unauthorizedResponse } from "@/app/lib/api-helpers";
import { errorLogSchema, parseBody } from "@/app/lib/validation";

export async function POST(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

  const raw = await req.json();
  const { data, error: valError } = parseBody(raw, errorLogSchema);
  if (valError) return valError;

  await logError({
    type: data.error_type ?? "client",
    message: data.error_message,
    endpoint: data.endpoint,
    userName: invite.name,
    organization: invite.organization ?? null,
    inviteCodeId: invite.id,
  });

  return NextResponse.json({ success: true });
}
