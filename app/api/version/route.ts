import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    version: "2026-04-11-v3",
    commit: "0d6e77d",
    features: ["applyCompanyOverride", "filenameSearch", "tightFilter"],
  });
}
