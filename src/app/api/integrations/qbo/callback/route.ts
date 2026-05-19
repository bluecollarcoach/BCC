import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const orgId = url.searchParams.get("state"); // we passed orgId as state
  if (!code || !realmId || !orgId) {
    return NextResponse.redirect(new URL("/admin/integrations?error=missing_params", env.NEXT_PUBLIC_APP_URL));
  }

  try {
    // Token exchange — stub. In prod, POST to oauth.platform.intuit.com.
    logger.info("qbo.callback.received", { orgId, realmId });
    await prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider: "QBO" } },
      create: {
        orgId,
        provider: "QBO",
        status: "PENDING_TOKEN_EXCHANGE",
        realmId,
        meta: JSON.stringify({ code }),
      },
      update: {
        status: "PENDING_TOKEN_EXCHANGE",
        realmId,
        meta: JSON.stringify({ code }),
      },
    });
    await audit({
      action: "integration.qbo.callback",
      orgId,
      targetType: "Integration",
      diff: { realmId },
    });
  } catch (err) {
    logger.error("qbo.callback.failed", { err });
  }

  return NextResponse.redirect(new URL("/admin/integrations?ok=qbo_pending", env.NEXT_PUBLIC_APP_URL));
}
