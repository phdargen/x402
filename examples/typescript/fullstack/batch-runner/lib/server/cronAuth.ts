import { NextRequest, NextResponse } from "next/server";

export function authorizeCronRequest(request: NextRequest): NextResponse | undefined {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return undefined;

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
