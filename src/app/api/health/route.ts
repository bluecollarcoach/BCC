import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  hasEntraConfigured,
  hasQboConfigured,
  hasRealtime,
  hasAppInsights,
  hasAzureBlob,
} from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return NextResponse.json({
    ok: dbOk,
    timestamp: new Date().toISOString(),
    services: {
      db: dbOk ? "up" : "down",
      entra: hasEntraConfigured ? "configured" : "missing",
      qbo: hasQboConfigured ? "configured" : "missing",
      signalr: hasRealtime ? "configured" : "mock",
      appInsights: hasAppInsights ? "configured" : "off",
      blob: hasAzureBlob ? "configured" : "off",
    },
  });
}
