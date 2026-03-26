// Placeholder - JSONL ingestion endpoint (not yet implemented)
export async function POST() {
  return new Response(JSON.stringify({ error: "Not implemented" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}
