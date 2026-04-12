/**
 * One-off script: delete the SPU registry from Supabase knowledge base.
 *
 * Deletes all sources whose filename contains "Реестр СПУ" or has
 * tag "карточка контрагента", along with their associated chunks.
 *
 * Usage:
 *   npx tsx scripts/delete-spu-registry.ts
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  // 1. Find all SPU-related sources
  const { data: sources, error: fetchErr } = await supabase
    .from("sources")
    .select("id, filename, tags")
    .or("filename.ilike.%Реестр СПУ%,filename.ilike.%реестр_спу%,filename.ilike.%реестр спу%");

  if (fetchErr) {
    console.error("Error fetching sources:", fetchErr.message);
    process.exit(1);
  }

  if (!sources || sources.length === 0) {
    console.log("No SPU registry sources found. Nothing to delete.");
    return;
  }

  console.log(`Found ${sources.length} SPU source(s):`);
  for (const s of sources) {
    console.log(`  - [${s.id}] ${s.filename} (tags: ${JSON.stringify(s.tags)})`);
  }

  const filenames = sources.map((s: { filename: string }) => s.filename);
  const ids = sources.map((s: { id: string }) => s.id);

  // 2. Count chunks to be deleted
  const { count: chunkCount } = await supabase
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .in("source_filename", filenames);

  console.log(`\nWill delete ${chunkCount ?? "?"} chunks and ${ids.length} source(s).`);

  // 3. Delete chunks first (FK dependency)
  const { error: chunkErr } = await supabase
    .from("chunks")
    .delete()
    .in("source_filename", filenames);

  if (chunkErr) {
    console.error("Error deleting chunks:", chunkErr.message);
    process.exit(1);
  }
  console.log(`Deleted chunks for ${filenames.length} file(s).`);

  // 4. Delete sources
  const { error: srcErr } = await supabase
    .from("sources")
    .delete()
    .in("id", ids);

  if (srcErr) {
    console.error("Error deleting sources:", srcErr.message);
    process.exit(1);
  }
  console.log(`Deleted ${ids.length} source(s).`);

  console.log("\nDone. SPU registry removed from knowledge base.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
