import { Router, Request, Response } from "express";
import { createServiceClient } from "../lib/supabase.js";
import { requireAdmin } from "../lib/auth.js";
import { verifyChunkImageToken } from "../lib/chunk-image-token.js";

const router = Router();

/**
 * GET /api/chunk-image — proxy chunk images from private Supabase Storage.
 *
 * V25 deep-research HIGH-1 fix. Auth model:
 *   - The query string carries a SIGNED token, not a bearer credential.
 *   - Token = HMAC-SHA256("chunk-image-v1|<path>|<exp>", AUTH_TOKEN_SECRET).
 *   - Token unlocks the EXACT path it was signed for, expires after 1 hour.
 *   - No Referer-trust fallback; no shared invite/admin code reuse.
 *   - Cache-Control: private — proxies/CDN do not cache; browser may cache
 *     locally for the remainder of the session.
 *
 * Token is produced server-side by chat.ts when a response references an
 * image, so a leaked URL grants at most one image, at most for the remaining
 * TTL — instead of the original "any image, until the invite code rotates"
 * exposure.
 */
router.get("/api/chunk-image", async (req: Request, res: Response) => {
  try {
    const path = (req.query.path as string) || "";
    const tokenParam = (req.query.token as string) || "";
    if (!path || !tokenParam) {
      return res.status(400).send("Missing path or token");
    }

    const token = decodeURIComponent(tokenParam);
    if (!verifyChunkImageToken(token, path)) {
      return res.status(401).send("Unauthorized");
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
    // Private cache only: no shared/CDN cache; tokens have a 1-hour TTL.
    res.setHeader("Cache-Control", "private, max-age=600");
    return res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    console.error("[chunk-image] Error:", e);
    return res.status(500).send("Internal error");
  }
});

// V25 deep-research MEDIUM-3 fix: removed POST /api/migrate.
//
// The endpoint executed arbitrary SQL via the Supabase `exec_sql` RPC
// behind an admin session. It was used once for one-time setup of
// `sources.storage_path`, `sources.folder_path`, `conversations.admin_name`,
// `infographics.admin_name`, `infographics.ip_address` and the `documents`
// bucket — all of which exist in production today. Keeping the endpoint
// alive turned every admin session compromise into near-DBA access.
//
// All future schema changes go through Supabase Dashboard SQL Editor with
// a migration file checked in under `supabase/`. If exec_sql ever needs to
// run from code again, do it through a one-off Railway run command, not a
// permanent web route.

/**
 * GET /api/debug-chunks — debug chunk retrieval (admin only)
 */
router.get("/api/debug-chunks", async (req: Request, res: Response) => {
  try {
    const adminCheck = await requireAdmin(req, res);
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
