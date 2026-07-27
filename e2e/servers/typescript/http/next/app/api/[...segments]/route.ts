import { NextRequest, NextResponse } from "next/server";
import { server } from "@/proxy";
import {
  createProxyRouteHandler,
  createWithX402GetHandler,
  isKnownCatalogPath,
  resolveProxyCatalogPath,
} from "@/lib/setup";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
) {
  const segments = (await context.params).segments ?? [];

  if (segments.length > 1 && segments[segments.length - 1] === "withx402") {
    const catalogPath = `/${segments.slice(0, -1).join("/")}`;
    if (!isKnownCatalogPath(catalogPath)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return createWithX402GetHandler(catalogPath, server)(req);
  }

  const catalogPath = resolveProxyCatalogPath(segments);
  if (!catalogPath) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return createProxyRouteHandler(catalogPath)();
}
