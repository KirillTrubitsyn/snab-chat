import { NextRequest, NextResponse } from "next/server";
import { parseToMarkdown } from "@/app/lib/parser";
import { autoTag } from "@/app/lib/tagging";
import { chunkMarkdown } from "@/app/lib/chunking";
import { requireAuth } from "@/app/lib/auth";
import { logError } from "@/app/lib/error-logger";

export async function POST(req: NextRequest) {
  const authCheck = await requireAuth(req);
  if (authCheck instanceof NextResponse) return authCheck;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const folderPath = (formData.get("folderPath") as string) || null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Файл слишком большой (макс. 50 МБ)" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const markdown = await parseToMarkdown(buffer, file.type, file.name);
    const tags = await autoTag(markdown, file.name, folderPath);
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
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Parse error:", err);
    logError({ type: "parse", message: errMsg, endpoint: "/api/parse" }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to parse file" },
      { status: 500 }
    );
  }
}
