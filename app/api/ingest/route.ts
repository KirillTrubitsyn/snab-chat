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

      // Use raw SQL via rpc to bypass PostgREST schema cache issues
      for (let j = 0; j < batch.length; j++) {
        const { error: chunkError } = await supabase.rpc("insert_chunk", {
          p_source_id: source.id,
          p_source_filename: filename,
          p_chunk_index: batch[j].index,
          p_content: batch[j].content,
          p_embedding: JSON.stringify(embeddings[j]),
          p_tags: tags,
        });

        if (chunkError) {
          console.error("Chunk insert error:", chunkError);
          return NextResponse.json(
            { error: `Failed to insert chunk ${batch[j].index}` },
            { status: 500 }
          );
        }
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
