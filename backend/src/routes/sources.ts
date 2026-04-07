import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader, isAdminCode, requireAdmin, requireDocumentAdmin } from "../lib/auth.js";
import multer from "multer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/sources — list sources
router.get("/api/sources", async (req: Request, res: Response) => {
  try {
    const invite = await getInviteCodeFromHeader(req);
    const view = req.query.view as string;

    const supabase = createServiceClient();
    const PAGE = 1000;
    let allSources: Record<string, unknown>[] = [];
    let from = 0;

    if (view === "chat") {
      // Chat view: paginate all sources too (users need full list for KB)
      while (true) {
        const { data, error } = await supabase
          .from("sources")
          .select("id, filename, mime_type, folder_path, tags, content_preview, created_at, storage_path")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE - 1);

        if (error) return res.status(500).json({ error: error.message });
        allSources = allSources.concat(data || []);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
    } else {
      // Admin view: paginate to get ALL sources
      while (true) {
        const { data, error } = await supabase
          .from("sources")
          .select("id, filename, mime_type, folder_path, tags, content_preview, created_at, storage_path")
          .order("created_at", { ascending: false })
          .range(from, from + PAGE - 1);

        if (error) return res.status(500).json({ error: error.message });
        allSources = allSources.concat(data || []);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
    }

    return res.json({ sources: allSources });
  } catch (err) {
    console.error("[sources] GET error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// PATCH /api/sources — update source metadata
router.patch("/api/sources", async (req: Request, res: Response) => {
  try {
    const adminCheck = requireAdmin(req, res);
    if (!adminCheck) return;

    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const supabase = createServiceClient();
    const updates: Record<string, unknown> = {};

    const { tags, filename, content_preview, description, folder_path } = req.body;
    if (tags !== undefined) updates.tags = tags;
    if (filename !== undefined) updates.filename = filename;
    if (content_preview !== undefined) updates.content_preview = content_preview;
    if (description !== undefined) updates.description = description;
    if (folder_path !== undefined) updates.folder_path = folder_path;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const { error } = await supabase.from("sources").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[sources] PATCH error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// DELETE /api/sources — delete source(s)
router.delete("/api/sources", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    const supabase = createServiceClient();

    if (id) {
      // Single delete
      await supabase.from("chunks").delete().eq("source_filename",
        (await supabase.from("sources").select("filename").eq("id", id).single()).data?.filename
      );
      const { error } = await supabase.from("sources").delete().eq("id", id);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true });
    }

    // Bulk delete from body
    const { ids } = req.body || {};
    if (Array.isArray(ids) && ids.length > 0) {
      const docAdmin = requireDocumentAdmin(req, res);
      if (!docAdmin) return;

      const { data: sources } = await supabase.from("sources").select("id, filename").in("id", ids);
      if (sources) {
        const filenames = sources.map((s: { filename: string }) => s.filename);
        if (filenames.length > 0) {
          await supabase.from("chunks").delete().in("source_filename", filenames);
        }
        await supabase.from("sources").delete().in("id", ids);
      }
      return res.json({ ok: true, deleted: ids.length });
    }

    return res.status(400).json({ error: "Missing id or ids" });
  } catch (err) {
    console.error("[sources] DELETE error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/sources/content — get source content (markdown)
router.get("/api/sources/content", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const supabase = createServiceClient();
    const { data: chunks, error } = await supabase
      .from("chunks")
      .select("content, chunk_index")
      .eq("source_id", id)
      .order("chunk_index", { ascending: true });

    if (error || !chunks || chunks.length === 0) {
      return res.status(404).json({ error: "No content available" });
    }
    const markdown = chunks.map((c: { content: string }) => {
      const text = c.content;
      const preambleEnd = text.indexOf("\n\n");
      if (preambleEnd > 0 && preambleEnd < 300 && text.charCodeAt(0) > 127) {
        return text.slice(preambleEnd + 2);
      }
      return text;
    }).join("\n\n");
    return res.json({ markdown });
  } catch (err) {
    console.error("[sources/content] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/sources/text — plain text
router.get("/api/sources/text", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const supabase = createServiceClient();
    const { data: source } = await supabase.from("sources").select("filename").eq("id", id).single();
    if (!source) return res.status(404).json({ error: "Not found" });

    const { data: chunks } = await supabase
      .from("chunks")
      .select("content")
      .eq("source_filename", source.filename)
      .order("chunk_index", { ascending: true });

    const text = (chunks || []).map((c: { content: string }) => c.content).join("\n\n");
    return res.json({ text, filename: source.filename });
  } catch (err) {
    console.error("[sources/text] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/sources/download — download original file from storage
router.get("/api/sources/download", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    const token = req.query.token as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    // Auth via token query param or header
    let authorized = false;
    if (token) {
      const code = decodeURIComponent(token);
      if (isAdminCode(code)) authorized = true;
      else {
        const supabase = createServiceClient();
        const { data } = await supabase.from("invite_codes").select("id").eq("code", code.toUpperCase()).eq("is_active", true).single();
        if (data) authorized = true;
      }
    }
    if (!authorized) {
      const invite = await getInviteCodeFromHeader(req);
      if (invite) authorized = true;
    }
    if (!authorized) return res.status(401).json({ error: "Unauthorized" });

    const supabase = createServiceClient();
    const { data: source } = await supabase.from("sources").select("filename, mime_type, storage_path").eq("id", id).single();
    if (!source) return res.status(404).json({ error: "Not found" });

    const storagePath = source.storage_path || `documents/${source.filename}`;
    const { data, error } = await supabase.storage.from("documents").download(storagePath);
    if (error || !data) return res.status(404).json({ error: "File not found in storage" });

    const buffer = Buffer.from(await data.arrayBuffer());
    const action = req.query.action as string;

    res.setHeader("Content-Type", source.mime_type || "application/octet-stream");
    if (action === "download") {
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(source.filename)}`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(source.filename)}`);
    }
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    return res.send(buffer);
  } catch (err) {
    console.error("[sources/download] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// GET /api/sources/signed-url
router.get("/api/sources/signed-url", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const supabase = createServiceClient();
    const { data: source } = await supabase.from("sources").select("filename, storage_path").eq("id", id).single();
    if (!source) return res.status(404).json({ error: "Not found" });

    const storagePath = source.storage_path || `documents/${source.filename}`;
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(storagePath, 3600);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ signedUrl: data.signedUrl });
  } catch (err) {
    console.error("[sources/signed-url] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

// Stub routes for less common endpoints — to be fully implemented
router.get("/api/sources/download-docx", async (_req: Request, res: Response) => {
  // TODO: Implement DOCX download conversion
  return res.status(501).json({ error: "Not yet implemented in backend" });
});

router.get("/api/sources/excel-data", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const supabase = createServiceClient();
    const { data: source } = await supabase.from("sources").select("id, filename, storage_path").eq("id", id).single();
    if (!source) return res.status(404).json({ error: "Not found" });

    interface ExcelSheet {
      name: string;
      rows: string[][];
      merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
      colWidths: number[];
    }

    if (source.storage_path) {
      const { data: fileData, error: downloadError } = await supabase.storage.from("documents").download(source.storage_path);
      if (!downloadError && fileData) {
        const ExcelJS = await import("exceljs");
        const buffer = Buffer.from(await fileData.arrayBuffer());
        const workbook = new ExcelJS.default.Workbook();
        try {
          await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
        } catch {
          // fall through to markdown fallback
        }
        const sheets: ExcelSheet[] = [];

        for (const ws of workbook.worksheets) {
          const totalCols = ws.columnCount;
          if (ws.rowCount === 0 || totalCols === 0) continue;

          const rows: string[][] = [];
          ws.eachRow({ includeEmpty: false }, (row) => {
            const vals: string[] = [];
            for (let c = 1; c <= totalCols; c++) {
              const cell = row.getCell(c);
              let cellText = "";
              try {
                cellText = cell.text ?? String(cell.value ?? "");
              } catch {
                try { cellText = String(cell.value ?? ""); } catch { cellText = ""; }
              }
              vals.push(cellText);
            }
            rows.push(vals);
          });

          if (rows.length === 0) continue;

          const merges: ExcelSheet["merges"] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const wsAny = ws as any;
          if (wsAny._merges) {
            for (const key of Object.keys(wsAny._merges)) {
              const m = wsAny._merges[key].model;
              merges.push({ s: { r: m.top - 1, c: m.left - 1 }, e: { r: m.bottom - 1, c: m.right - 1 } });
            }
          }

          const colWidths: number[] = [];
          for (let i = 1; i <= totalCols; i++) {
            const col = ws.getColumn(i);
            colWidths.push(col.width ? Math.round(col.width) : 0);
          }

          const maxCols = Math.max(...rows.map((r) => r.length), 0);
          sheets.push({
            name: ws.name,
            rows: rows.map((row) => Array.from({ length: maxCols }, (_, i) => String(row[i] ?? ""))),
            merges,
            colWidths,
          });
        }

        return res.json({ sheets, filename: source.filename });
      }
    }

    // Fallback: parse markdown table from chunks
    const { parseMarkdownTables } = await import("../lib/markdown-tables");
    const { data: chunks } = await supabase
      .from("chunks")
      .select("content, chunk_index")
      .eq("source_id", source.id)
      .order("chunk_index", { ascending: true });

    if (!chunks || chunks.length === 0) {
      return res.status(404).json({ error: "No content" });
    }

    const markdown = chunks.map((c: { content: string }) => c.content).join("\n\n");
    const parsed = parseMarkdownTables(markdown, source.filename);
    const excelSheets: ExcelSheet[] = parsed.map((s) => ({ ...s, merges: [], colWidths: [] }));
    return res.json({ sheets: excelSheets, filename: source.filename });
  } catch (err) {
    console.error("[sources/excel-data] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.get("/api/sources/pptx-slides", async (_req: Request, res: Response) => {
  // TODO: Implement PPTX slides extraction
  return res.status(501).json({ error: "Not yet implemented in backend" });
});

router.get("/api/sources/docx-html", async (_req: Request, res: Response) => {
  // TODO: Implement DOCX to HTML conversion
  return res.status(501).json({ error: "Not yet implemented in backend" });
});

router.get("/api/sources/resolve", async (req: Request, res: Response) => {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "Missing id" });

    const supabase = createServiceClient();
    const { data, error } = await supabase.from("sources").select("*").eq("id", id).single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    return res.json({ source: data });
  } catch (err) {
    console.error("[sources/resolve] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/api/sources/upload-original", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const docAdmin = requireDocumentAdmin(req, res);
    if (!docAdmin) return;

    const file = req.file;
    const sourceId = req.body.sourceId as string;
    if (!file || !sourceId) return res.status(400).json({ error: "Missing file or sourceId" });

    const supabase = createServiceClient();
    const storagePath = `documents/${sourceId}_${file.originalname}`;

    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    await supabase.from("sources").update({ storage_path: storagePath }).eq("id", sourceId);
    return res.json({ ok: true, storagePath });
  } catch (err) {
    console.error("[sources/upload-original] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
