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

  // If original file exists in storage, serve it
  if (source.storage_path) {
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(source.storage_path);

    if (downloadError || !fileData) {
      console.error("Storage download error:", downloadError);
      return NextResponse.json(
        { error: "Failed to download file" },
        { status: 500 }
      );
    }

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

  // Fallback: reconstruct markdown from chunks for old documents
  const { data: chunks, error: chunksError } = await supabase
    .from("chunks")
    .select("content, chunk_index")
    .eq("source_id", source.id)
    .order("chunk_index", { ascending: true });

  if (chunksError || !chunks || chunks.length === 0) {
    return NextResponse.json(
      { error: "No content available" },
      { status: 404 }
    );
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
