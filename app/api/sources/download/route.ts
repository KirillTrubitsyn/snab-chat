import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, validateInviteCode, isAdminCode, getAdminName, type InviteCode } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

export async function GET(req: NextRequest) {
  // Support invite code from query param (for window.open / iframe which can't send headers)
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
  const action = req.nextUrl.searchParams.get("action") || "download";

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Get source metadata
  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select("id, filename, mime_type, storage_path")
    .eq("id", id)
    .single();

  if (sourceError || !source) {
    return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  // Serve original file from storage if available (both download and view)
  if (source.storage_path) {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(source.storage_path);

    if (!downloadError && fileData) {
      const disposition =
        action === "view"
          ? `inline; filename="${encodeURIComponent(source.filename)}"`
          : `attachment; filename="${encodeURIComponent(source.filename)}"`;
      return new NextResponse(fileData, {
        headers: {
          "Content-Type": source.mime_type || "application/octet-stream",
          "Content-Disposition": disposition,
        },
      });
    }
    console.error("Storage download error:", downloadError);
  }

  // For view action (or download fallback): reconstruct readable text from chunks
  const { data: chunks, error: chunksError } = await supabase
    .from("chunks")
    .select("content, chunk_index")
    .eq("source_id", source.id)
    .order("chunk_index", { ascending: true });

  if (chunksError || !chunks || chunks.length === 0) {
    // Last resort for download: try storage
    if (action === "download" || !source.storage_path) {
      return NextResponse.json(
        { error: "No content available" },
        { status: 404 }
      );
    }
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(source.storage_path);
    if (downloadError || !fileData) {
      return NextResponse.json({ error: "No content available" }, { status: 404 });
    }
    return new NextResponse(fileData, {
      headers: {
        "Content-Type": source.mime_type || "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(source.filename)}"`,
      },
    });
  }

  const markdown = chunks.map((c) => c.content).join("\n\n");
  const mdFilename = source.filename.replace(/\.[^.]+$/, ".md");

  const disposition =
    action === "view"
      ? `inline; filename="${encodeURIComponent(mdFilename)}"`
      : `attachment; filename="${encodeURIComponent(mdFilename)}"`;

  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": disposition,
    },
  });
}
