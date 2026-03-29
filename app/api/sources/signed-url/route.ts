import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, validateInviteCode, isAdminCode, getAdminName, type InviteCode } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

/**
 * Returns a temporary signed URL for a document stored in Supabase Storage.
 * Used by Office Online viewer to access PPTX/DOCX files directly.
 * The signed URL is valid for 1 hour.
 */
export async function GET(req: NextRequest) {
  let invite = await getInviteCodeFromHeader(req);
  if (!invite) {
    const tokenParam = req.nextUrl.searchParams.get("token");
    if (tokenParam) {
      const code = decodeURIComponent(tokenParam);
      if (isAdminCode(code)) {
        invite = {
          id: `admin-${code.toUpperCase()}`,
          code: code.toUpperCase(),
          name: getAdminName(code) ?? "Админ",
          organization: "Админ",
          uses_remaining: null,
          device_limit: null,
          is_active: true,
          created_at: new Date().toISOString(),
        } as InviteCode;
      } else {
        invite = await validateInviteCode(code);
      }
    }
  }
  if (!invite) return unauthorizedResponse();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, filename, mime_type, storage_path")
    .eq("id", id)
    .single();

  if (sourceError || !source || !source.storage_path) {
    return NextResponse.json({ error: "Source not found or no original file" }, { status: 404 });
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from("documents")
    .createSignedUrl(source.storage_path, 3600); // 1 hour

  if (urlError || !urlData?.signedUrl) {
    console.error("Failed to create signed URL:", urlError);
    return NextResponse.json({ error: "Failed to create signed URL" }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: urlData.signedUrl });
}
