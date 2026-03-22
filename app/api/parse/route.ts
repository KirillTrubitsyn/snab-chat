import { NextRequest, NextResponse } from "next/server";
import { parseToMarkdown } from "@/app/lib/parser";
import { autoTag } from "@/app/lib/tagging";
import { chunkMarkdown } from "@/app/lib/chunking";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const markdown = await parseToMarkdown(buffer, file.type, file.name);
    const tags = await autoTag(markdown, file.name);
    const chunks = chunkMarkdown(markdown);

    return NextResponse.json({
      filename: file.name,
      mimeType: file.type,
      markdown,
      tags,
      chunks: chunks.map((c) => ({
        index: c.index,
        preview: c.content.slice(0, 200),
        length: c.content.length,
      })),
      totalChunks: chunks.length,
    });
  } catch (err) {
    console.error("Parse error:", err);
    return NextResponse.json(
      { error: "Failed to parse file" },
      { status: 500 }
    );
  }
}
