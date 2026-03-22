import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

export async function GET() {
  try {
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("sources")
      .select("id, filename, mime_type, tags, storage_path, folder_path, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ sources: data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const body = await req.json();
    const { tags } = body;

    if (!Array.isArray(tags)) {
      return NextResponse.json({ error: "tags must be an array" }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("sources")
      .update({ tags })
      .eq("id", id)
      .select("id, filename, mime_type, tags, created_at")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ source: data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    // Support bulk delete via JSON body with ids array
    let ids: string[] = [];
    if (id) {
      ids = [id];
    } else {
      try {
        const body = await req.json();
        if (Array.isArray(body.ids)) ids = body.ids.map(String);
      } catch {
        // no body
      }
    }

    if (ids.length === 0) {
      return NextResponse.json({ error: "Missing id or ids" }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get storage paths for all sources
    const { data: sources } = await supabase
      .from("sources")
      .select("id, storage_path")
      .in("id", ids);

    // Delete files from storage
    const storagePaths = (sources || [])
      .map((s) => s.storage_path)
      .filter((p): p is string => !!p);
    if (storagePaths.length > 0) {
      await supabase.storage.from("documents").remove(storagePaths);
    }

    // Delete chunks for all sources
    await supabase.from("chunks").delete().in("source_id", ids);

    // Delete sources
    const { error } = await supabase.from("sources").delete().in("id", ids);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: ids.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
