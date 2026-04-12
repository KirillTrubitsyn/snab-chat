import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { getInviteCodeFromHeader, isAdminCode, requireAdmin } from "../lib/auth.js";

const router = Router();

/**
 * GET /api/chunk-image — proxy chunk images from private Supabase Storage.
 * Auth: x-invite-code header OR ?token= query param (for <img src>)
 */
router.get("/api/chunk-image", async (req: Request, res: Response) => {
  try {
    // N4 fix: prefer header auth; token query param allowed ONLY with valid Referer from our domain
    let authorized = false;

    const invite = await getInviteCodeFromHeader(req);
    if (invite) {
      authorized = true;
    } else {
      const tokenParam = (req.query.token as string) || "";
      if (tokenParam) {
        // Only allow token param if Referer matches our domain (img tags in our app send Referer)
        const referer = req.headers.referer || "";
        const allowedReferers = [
          "snabchat.app",
          "snabchat.ru",
          "vercel.app",
        ];
        const refererValid = allowedReferers.some(d => {
          try { return new URL(referer).hostname.endsWith(d); }
          catch { return false; }
        });
        if (!refererValid) {
          return res.status(403).send("Forbidden");
        }
        const code = decodeURIComponent(tokenParam);
        if (isAdminCode(code)) {
          authorized = true;
        } else {
          const supabase = createServiceClient();
          const { data } = await supabase
            .from("invite_codes")
            .select("id")
            .eq("code", code)
            .eq("is_active", true)
            .single();
          if (data) authorized = true;
        }
      }
    }

    if (!authorized) {
      return res.status(401).send("Unauthorized");
    }

    const path = req.query.path as string;
    if (!path) {
      return res.status(400).send("Missing path parameter");
    }

    const supabase = createServiceClient();
    const { data, error } = await supabase.storage
      .from("chunk-images")
      .download(path);

    if (error || !data) {
      console.error("[chunk-image] Download error:", path, error?.message);
      return res.status(404).send("Image not found");
    }

    const arrayBuffer = await data.arrayBuffer();
    const ext = path.split(".").pop()?.toLowerCase() || "png";
    const mimeType =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "gif"
        ? "image/gif"
        : ext === "webp"
        ? "image/webp"
        : "image/png";

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error("[chunk-image] Error:", e);
    return res.status(500).send("Internal error");
  }
});

/**
 * POST /api/migrate — run database migrations.
 */
router.post("/api/migrate", async (req: Request, res: Response) => {
  try {
    const admin = requireAdmin(req, res);
    if (!admin) return;

    const supabase = createServiceClient();

    // Add storage_path and folder_path columns if they don't exist
    const { error: alterError } = await supabase.rpc("exec_sql", {
      sql: `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'sources' AND column_name = 'storage_path'
          ) THEN
            ALTER TABLE sources ADD COLUMN storage_path text;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'sources' AND column_name = 'folder_path'
          ) THEN
            ALTER TABLE sources ADD COLUMN folder_path text;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'conversations' AND column_name = 'admin_name'
          ) THEN
            ALTER TABLE conversations ADD COLUMN admin_name text;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'infographics' AND column_name = 'admin_name'
          ) THEN
            ALTER TABLE infographics ADD COLUMN admin_name text;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'infographics' AND column_name = 'ip_address'
          ) THEN
            ALTER TABLE infographics ADD COLUMN ip_address text;
          END IF;
        END $$;
      `,
    });

    // Fallback: try direct SQL if rpc doesn't exist
    if (alterError) {
      console.log("exec_sql rpc not available:", alterError.message);
    }

    // Create storage bucket
    const { error: bucketError } = await supabase.storage.createBucket(
      "documents",
      { public: false }
    );

    // R3 fix: log details server-side, return generic response
    if (bucketError) console.warn("[migrate] Bucket error:", bucketError.message);
    return res.json({
      success: true,
      message: "Migration completed",
      bucketCreated: !bucketError,
      columnNote: alterError
        ? "Could not auto-add columns. Run migration manually in Supabase SQL Editor."
        : "Columns added successfully",
    });
  } catch (err) {
    console.error("Migration error:", err);
    return res.status(500).json({
      error: "Migration failed",
    });
  }
});

/**
 * GET /api/debug-chunks — debug chunk retrieval (admin only)
 */
router.get("/api/debug-chunks", async (req: Request, res: Response) => {
  try {
    const adminCheck = requireAdmin(req, res);
    if (!adminCheck) return;

    const filename = (req.query.filename as string) || "SRM";

    const supabase = createServiceClient();

    // 1. Check sources
    const { data: sources, error: srcErr } = await supabase
      .from("sources")
      .select("id, filename, tags, created_at, storage_path, folder_path")
      .ilike("filename", `%${filename}%`)
      .order("created_at", { ascending: false })
      .limit(10);

    // 2. Check chunks for those sources
    const { data: chunks, error: chunkErr } = await supabase
      .from("chunks")
      .select("id, source_id, source_filename, chunk_index, tags, image_paths, created_at")
      .ilike("source_filename", `%${filename}%`)
      .order("created_at", { ascending: false })
      .limit(50);

    // 3. Check if embeddings exist (embedding is not null)
    const { data: embCheck, error: embErr } = await supabase
      .rpc("check_embeddings", { filename_pattern: `%${filename}%` })
      .single();

    // Fallback: raw count query if RPC doesn't exist
    let embeddingInfo = embCheck;
    if (embErr) {
      // Direct query: count chunks with/without embeddings
      const { count: totalCount } = await supabase
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .ilike("source_filename", `%${filename}%`);

      embeddingInfo = {
        total_chunks: totalCount || 0,
        rpc_error: embErr.message,
      };
    }

    // 4. Test hybrid_search with a simple query
    const { data: searchResults, error: searchErr } = await supabase.rpc("hybrid_search", {
      query_text: filename,
      query_embedding: `[${new Array(1536).fill(0).join(",")}]`, // zero vector just to test
      match_count: 10,
      vector_weight: 0.0, // only FTS for diagnostic
      fts_weight: 1.0,
      filter_tags: null, // no filter
    });

    // 5. Test with SRM tag filter
    const { data: filteredResults, error: filteredErr } = await supabase.rpc("hybrid_search", {
      query_text: filename,
      query_embedding: `[${new Array(1536).fill(0).join(",")}]`,
      match_count: 10,
      vector_weight: 0.0,
      fts_weight: 1.0,
      filter_tags: ["SRM"],
    });

    return res.json({
      sources: sources || [],
      sourcesError: srcErr?.message || null,
      chunks: (chunks || []).map((c: Record<string, unknown>) => ({
        ...c,
        image_paths_count: Array.isArray(c.image_paths) ? (c.image_paths as string[]).length : 0,
      })),
      chunksError: chunkErr?.message || null,
      embeddingInfo,
      searchUnfiltered: {
        results: (searchResults || []).map((r: Record<string, unknown>) => ({
          id: r.id,
          source_filename: r.source_filename,
          chunk_index: r.chunk_index,
          similarity: r.similarity,
          tags: r.tags,
          image_paths: r.image_paths,
        })),
        error: searchErr?.message || null,
      },
      searchWithSRMTag: {
        results: (filteredResults || []).map((r: Record<string, unknown>) => ({
          id: r.id,
          source_filename: r.source_filename,
          chunk_index: r.chunk_index,
          similarity: r.similarity,
          tags: r.tags,
        })),
        error: filteredErr?.message || null,
      },
    });
  } catch (err) {
    console.error("[debug-chunks] Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
