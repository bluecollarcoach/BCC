import type { QboAdapter, QboKpis } from "./adapter";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * QuickBooks Online live adapter — STUBBED scaffold.
 *
 * To wire up:
 *   1. Register an Intuit dev app: https://developer.intuit.com
 *   2. Implement the OAuth2 flow at /api/integrations/qbo/connect + /callback.
 *      Store access_token, refresh_token, realmId in the Integration row.
 *   3. Replace monthlyKpis() body with calls to the QBO Reports API:
 *        GET /v3/company/{realmId}/reports/ProfitAndLoss
 *        GET /v3/company/{realmId}/reports/BalanceSheet
 *        GET /v3/company/{realmId}/reports/CashFlow
 *   4. Map line items into QboKpis.
 */

async function getQboToken(orgId: string) {
  const integ = await prisma.integration.findUnique({
    where: { orgId_provider: { orgId, provider: "QBO" } },
  });
  if (!integ || integ.status !== "CONNECTED" || !integ.accessToken) return null;
  if (integ.expiresAt && integ.expiresAt < new Date()) {
    logger.warn("qbo.token.expired", { orgId });
    // TODO: refresh
  }
  return { token: integ.accessToken, realmId: integ.realmId ?? "" };
}

export const qboLive: QboAdapter = {
  async monthlyKpis(orgId, months): Promise<QboKpis[]> {
    const auth = await getQboToken(orgId);
    if (!auth) return [];
    // TODO: real QBO Reports API call. For now log and return empty.
    logger.info("qbo.monthlyKpis (stub)", { orgId, months, env: env.QBO_ENVIRONMENT });
    return [];
  },
  async syncNow(orgId) {
    const auth = await getQboToken(orgId);
    if (!auth) return { synced: 0 };
    logger.info("qbo.syncNow (stub)", { orgId });
    return { synced: 0 };
  },
  async isConnected(orgId) {
    const integ = await prisma.integration.findUnique({
      where: { orgId_provider: { orgId, provider: "QBO" } },
    });
    return integ?.status === "CONNECTED";
  },
};
