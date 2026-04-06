import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireAdmin } from "@/app/lib/auth";

export async function POST(req: NextRequest) {
  const adminCheck = requireAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
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

    return NextResponse.json({
      success: true,
      message: "Migration completed",
      bucketCreated: !bucketError,
      bucketNote: bucketError?.message || "Created successfully",
      columnNote: alterError
        ? "Could not auto-add columns. Please run in Supabase SQL Editor: ALTER TABLE sources ADD COLUMN IF NOT EXISTS storage_path text; ALTER TABLE sources ADD COLUMN IF NOT EXISTS folder_path text;"
        : "Columns added successfully",
    });
  } catch (err) {
    console.error("Migration error:", err);
    return NextResponse.json(
      { error: "Migration failed" },
      { status: 500 }
    );
  }
}
