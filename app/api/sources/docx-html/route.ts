import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import mammoth from "mammoth";

export async function GET(req: NextRequest) {
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

  if (sourceError || !source) {
        return NextResponse.json({ error: "Source not found" }, { status: 404 });
  }

  if (!source.storage_path) {
        return NextResponse.json(
          { error: "Original file not available" },
          { status: 404 }
              );
  }

  const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(source.storage_path);

  if (downloadError || !fileData) {
        return NextResponse.json(
          { error: "Failed to download file" },
          { status: 500 }
              );
  }

  const buffer = Buffer.from(await fileData.arrayBuffer());

  try {
        const result = await mammoth.convertToHtml(
          { buffer },
          {
                    styleMap: [
                                "p[style-name='Heading 1'] => h1:fresh",
                                "p[style-name='Heading 2'] => h2:fresh",
                                "p[style-name='Heading 3'] => h3:fresh",
                                "p[style-name='Title'] => h1.doc-title:fresh",
                              ],
          }
              );

      return NextResponse.json({
              html: result.value,
              messages: result.messages
                .filter((m) => m.type === "warning")
                .map((m) => m.message),
      });
  } catch (err) {
        console.error("Mammoth conversion error:", err);
        return NextResponse.json(
          { error: "Failed to convert document" },
          { status: 500 }
              );
  }
}
