import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, isAdminCode } from "@/app/lib/auth";
import { verifyDownloadToken } from "@/app/lib/download-token";

export const runtime = "nodejs";

/**
 * Proxy endpoint for serving chunk images from private Supabase Storage.
 * Usage: GET /api/chunk-image?path=1541/img_0.png&token=signed_token
 * Auth: x-invite-code header OR ?token= query param (signed download token or invite code)
 */
export async function GET(req: NextRequest) {
  // Support auth via header or query param (img tags can't send headers)
  const tokenParam = req.nextUrl.searchParams.get("token") || "";
  let authorized = false;

  if (tokenParam) {
    // Сначала проверяем подписанный download-токен (новый формат)
    const verified = verifyDownloadToken(tokenParam);
    if (verified) {
      authorized = true;
    } else {
      // Fallback: обратная совместимость с инвайт-кодами
      const code = decodeURIComponent(tokenParam);
      if (isAdminCode(code)) {
        authorized = true;
      } else {
        const supabase = createServiceClient();
        const { data } = await supabase
          .from("invite_codes")
          .select("id")
          .eq("code", code)
          .eq("is_active", true)
          .single();
        if (data) authorized = true;
      }
    }
  }

  if (!authorized) {
    const invite = await getInviteCodeFromHeader(req);
    if (invite) authorized = true;
  }

  if (!authorized) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path || path.includes("..") || path.startsWith("/")) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.storage
      .from("chunk-images")
      .download(path);

    if (error || !data) {
      console.error("[chunk-image] Download error:", path, error?.message);
      return new NextResponse("Image not found", { status: 404 });
    }

    const arrayBuffer = await data.arrayBuffer();
    const ext = path.split(".").pop()?.toLowerCase() || "png";
    const mimeType =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "gif"
        ? "image/gif"
        : ext === "webp"
        ? "image/webp"
        : "image/png";

    return new NextResponse(arrayBuffer, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    console.error("[chunk-image] Error:", e);
    return new NextResponse("Internal error", { status: 500 });
  }
}
