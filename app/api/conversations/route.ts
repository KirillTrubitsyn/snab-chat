import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/app/lib/supabase";

export async function GET() {
  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at, summary")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    data.map((c) => ({
      ...c,
      hasSummary: !!c.summary,
      summary: undefined,
    }))
  );
}

export async function POST(req: NextRequest) {
  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const title = body.title || "Новый диалог";

  const { data, error } = await supabase
    .from("conversations")
    .insert({ title })
    .select("id, title, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  let supabase;
  try {
    supabase = createServiceClient();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const all = searchParams.get("all");

  // Delete all conversations
  if (all === "true") {
    await supabase.from("messages").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    const { error } = await supabase.from("conversations").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  // Bulk delete by ids in body
  if (!id) {
    try {
      const body = await req.json();
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        await supabase.from("messages").delete().in("conversation_id", body.ids);
        const { error } = await supabase.from("conversations").delete().in("id", body.ids);
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ ok: true });
      }
    } catch {
      // no body
    }
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Delete single conversation
  await supabase.from("messages").delete().eq("conversation_id", id);
  const { error } = await supabase.from("conversations").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
