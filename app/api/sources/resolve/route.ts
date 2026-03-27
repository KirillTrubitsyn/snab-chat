import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

/**
 * Resolves a denormalized source to its original (with storage_path).
 * If the source is not denormalized or no original exists, returns null.
 *
 * GET /api/sources/resolve?id=123
 */
export async function GET(req: NextRequest) {
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

  const id = req.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Get the requested source
  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, filename, mime_type, storage_path")
    .eq("id", id)
    .single();

  if (sourceError || !source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // If source already has a storage_path or is not denormalized, no resolution needed
  if (source.storage_path || source.mime_type !== "application/x-denormalized") {
    return NextResponse.json({ original: null });
  }

  // Find original source with the same filename that has storage_path
  const { data: original, error: origError } = await supabase
    .from("sources")
    .select("id, filename, mime_type, storage_path")
    .eq("filename", source.filename)
    .not("storage_path", "is", null)
    .neq("mime_type", "application/x-denormalized")
    .limit(1)
    .single();

  if (origError || !original) {
    return NextResponse.json({ original: null });
  }

  return NextResponse.json({ original });
}
