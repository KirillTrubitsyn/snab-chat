import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";
import { requireDocumentAdmin, getInviteCodeFromHeader } from "@/app/lib/auth";
import { unauthorizedResponse } from "@/app/lib/api-helpers";

export async function GET(req: NextRequest) {
  // Require authentication — any valid invite or admin code
  const invite = await getInviteCodeFromHeader(req);
  if (!invite) return unauthorizedResponse();

  try {
    const { searchParams } = new URL(req.url);
    const view = searchParams.get("view"); // "chat" = regular user view

    const supabase = createServiceClient();
    const PAGE = 1000;
    const MAX_TOTAL_SOURCES = 10000;
    let allSources: any[] = [];
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from("sources")
        .select("id, filename, mime_type, tags, storage_path, folder_path, created_at")
        .order("created_at", { ascending: false })
        .range(from, from + PAGE - 1);

      if (error) {
        console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
      }

      allSources = allSources.concat(data);
      if (data.length < PAGE || allSources.length >= MAX_TOTAL_SOURCES) break;
      from += PAGE;
    }

    // For chat view (regular users): hide ALL denormalized .md files
    // except those in "contractor-cards" folder.
    // For admin view: hide only denormalized files in technical folders.
    const HIDDEN_DENORM_FOLDERS_ADMIN = ["pricing", "instructions", "schemas"];

    const visibleSources = allSources.filter((s: any) => {
      if (s.mime_type !== "application/x-denormalized") return true;
      if (view === "chat") {
        // Regular users see only contractor-cards denormalized files
        return s.folder_path === "contractor-cards";
      }
      // Admin view — hide only technical folders
      return !HIDDEN_DENORM_FOLDERS_ADMIN.includes(s.folder_path);
    });

    const denormalizedSources = allSources.filter(
      (s: any) =>
        s.mime_type === "application/x-denormalized" &&
        (view === "chat"
          ? s.folder_path !== "contractor-cards"
          : HIDDEN_DENORM_FOLDERS_ADMIN.includes(s.folder_path))
    );

    return NextResponse.json({
      sources: visibleSources,
      denormalized: denormalizedSources,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const adminCheck = requireDocumentAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const body = await req.json();
    const { tags, folder_path, filename } = body;

    const updateData: Record<string, unknown> = {};
    if (Array.isArray(tags)) updateData.tags = tags;
    if (typeof folder_path === "string") updateData.folder_path = folder_path;
    if (typeof filename === "string" && filename.trim()) updateData.filename = filename.trim();

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from("sources")
      .update(updateData)
      .eq("id", id)
      .select("id, filename, mime_type, tags, folder_path, created_at")
      .single();

    if (error) {
      console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
    }

    return NextResponse.json({ source: data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const adminCheck = requireDocumentAdmin(req);
  if (adminCheck instanceof NextResponse) return adminCheck;

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
      console.error("DB error:", error.message); return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deleted: ids.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
