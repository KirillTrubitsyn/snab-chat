import { NextRequest, NextResponse } from "next/server";

// Self-registration is paused until further notice.
// Only administrators can create invite codes via the admin panel.
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: "Регистрация временно приостановлена. Обратитесь к администратору для получения кода доступа." },
    { status: 403 }
  );
}
