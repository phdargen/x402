import { NextResponse } from "next/server";
import { loadServerEnv } from "../../../../../shared/config";
import { buildHealthResponse } from "../../../../../shared/routes";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(buildHealthResponse(loadServerEnv()));
}
