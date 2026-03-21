import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { chunkMarkdown } from "@/app/lib/chunking";
import { embedDocuments } from "@/app/lib/embeddings";

export async function POST(req: NextRequest) {
  try {
    const { filename, mimeType, markdown, tags } = await req.json();
    const supabase = createServiceClient();

    // Create source entry
    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .insert({
        filename,
        mime_type: mimeType,
        tags,
        content_preview: markdown.slice(0, 500),
      })
      .select("id")
      .single();

    if (sourceError) {
      console.error("Source insert error:", sourceError);
      return NextResponse.json(
        { error: "Failed to create source" },
        { status: 500 }
      );
    }

    const chunks = chunkMarkdown(markdown);

    // Embed in batches of 5
    const batchSize = 5;
    let insertedCount = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await embedDocuments(texts);

      const rows = batch.map((chunk, j) => ({
        source_id: source.id,
        source_filename: filename,
        chunk_index: chunk.index,
        content: chunk.content,
        embedding: JSON.stringify(embeddings[j]),
        tags,
      }));

      const { error: chunkError } = await supabase.from("chunks").insert(rows);

      if (chunkError) {
        console.error("Chunk insert error:", chunkError);
        return NextResponse.json(
          { error: `Failed to insert chunk batch starting at ${i}` },
          { status: 500 }
        );
      }

      insertedCount += batch.length;
    }

    return NextResponse.json({
      sourceId: source.id,
      chunksInserted: insertedCount,
      filename,
    });
  } catch (err) {
    console.error("Ingest error:", err);
    return NextResponse.json(
      { error: "Failed to ingest document" },
      { status: 500 }
    );
  }
}
