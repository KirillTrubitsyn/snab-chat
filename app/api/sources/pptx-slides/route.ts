import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { getInviteCodeFromHeader, validateInviteCode, isAdminCode, getAdminName, type InviteCode } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";
import JSZip from "jszip";

interface SlideData {
  number: number;
  paragraphs: string[];
  images: { base64: string; mimeType: string }[];
}

/**
 * Extracts slide-by-slide data (text + images) from a PPTX stored in Supabase.
 * Returns structured JSON for client-side slide rendering.
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

  const { data: fileData, error: downloadError } = await supabase.storage
    .from("documents")
    .download(source.storage_path);

  if (downloadError || !fileData) {
    return NextResponse.json({ error: "Failed to download file" }, { status: 500 });
  }

  try {
    const buffer = Buffer.from(await fileData.arrayBuffer());
    const zip = await JSZip.loadAsync(buffer);

    // Collect slide files
    const slideFiles = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/i)?.[1] || "0", 10);
        const nb = parseInt(b.match(/slide(\d+)/i)?.[1] || "0", 10);
        return na - nb;
      });

    // Build media cache
    const mediaCache = new Map<string, { data: Buffer; mime: string }>();
    for (const key of Object.keys(zip.files)) {
      if (/^ppt\/media\//i.test(key) && !zip.files[key].dir) {
        const ext = key.split(".").pop()?.toLowerCase() || "png";
        const mime =
          ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "gif"
              ? "image/gif"
              : ext === "emf"
                ? "image/x-emf"
                : ext === "wmf"
                  ? "image/x-wmf"
                  : `image/${ext}`;
        const data = Buffer.from(await zip.files[key].async("arraybuffer"));
        mediaCache.set(key, { data, mime });
      }
    }

    const slides: SlideData[] = [];

    for (const slideFile of slideFiles) {
      const slideNum = parseInt(slideFile.match(/slide(\d+)/i)?.[1] || "0", 10);
      const slideXml = await zip.files[slideFile].async("text");

      // Extract text
      const paragraphs: string[] = [];
      const pParts = slideXml.split(/<a:p[\s>]/);
      for (const pp of pParts) {
        const textRuns: string[] = [];
        const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
        let m;
        while ((m = tRegex.exec(pp)) !== null) {
          const t = m[1]
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();
          if (t) textRuns.push(t);
        }
        if (textRuns.length > 0) {
          paragraphs.push(textRuns.join(" "));
        }
      }

      // Extract images from slide rels
      const relsPath = slideFile.replace(
        /ppt\/slides\/(slide\d+\.xml)/i,
        "ppt/slides/_rels/$1.rels"
      );
      const slideImages: { base64: string; mimeType: string }[] = [];

      if (zip.files[relsPath]) {
        const relsXml = await zip.files[relsPath].async("text");
        const relRegex = /<Relationship[^>]+Target="([^"]*)"[^>]+Type="[^"]*\/image"[^>]*\/?>/gi;
        const relRegex2 = /<Relationship[^>]+Type="[^"]*\/image"[^>]+Target="([^"]*)"[^>]*\/?>/gi;

        const targets = new Set<string>();
        let rm;
        while ((rm = relRegex.exec(relsXml)) !== null) targets.add(rm[1]);
        while ((rm = relRegex2.exec(relsXml)) !== null) targets.add(rm[1]);

        for (const target of targets) {
          const mediaPath = target.startsWith("../")
            ? `ppt/${target.slice(3)}`
            : target.startsWith("/")
              ? target.slice(1)
              : `ppt/slides/${target}`;
          const media = mediaCache.get(mediaPath);
          if (media && media.data.length >= 2048 && media.mime !== "image/x-emf" && media.mime !== "image/x-wmf") {
            slideImages.push({
              base64: media.data.toString("base64"),
              mimeType: media.mime,
            });
          }
        }
      }

      if (paragraphs.length > 0 || slideImages.length > 0) {
        slides.push({ number: slideNum, paragraphs, images: slideImages });
      }
    }

    return NextResponse.json({ slides });
  } catch (e) {
    console.error("PPTX slide extraction error:", e);
    return NextResponse.json({ error: "Failed to extract slides" }, { status: 500 });
  }
}
