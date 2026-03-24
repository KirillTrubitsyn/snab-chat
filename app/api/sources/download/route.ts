import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

export async function GET(req: NextRequest) {
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

  // For download action, serve original file from storage if available
  if (action === "download" && source.storage_path) {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(source.storage_path);

    if (!downloadError && fileData) {
      return new NextResponse(fileData, {
        headers: {
          "Content-Type": source.mime_type || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(source.filename)}"`,
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
