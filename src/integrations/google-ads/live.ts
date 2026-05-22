import type {
  AdsAccountInsights,
  AdsCampaign,
  GoogleAdsAdapter,
} from "./adapter";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Google Ads live adapter — SCAFFOLD.
 *
 * To finish wiring (~half day):
 *   1. Create OAuth client at https://console.cloud.google.com
 *      Scope: https://www.googleapis.com/auth/adwords
 *      Redirect: <APP_URL>/api/integrations/google-ads/callback
 *   2. Apply for a Google Ads developer token (production access can take 1–3 days).
 *   3. Install `google-ads-api` (npm) and use the GoogleAdsApi class.
 *   4. Replace each method body with a real GAQL query and map rows to AdsCampaign / AdsAccountInsights.
 *
 * GAQL examples we'll need:
 *   SELECT campaign.id, campaign.name, campaign.status,
 *          campaign.advertising_channel_type,
 *          campaign_budget.amount_micros,
 *          metrics.cost_micros, metrics.impressions,
 *          metrics.clicks, metrics.conversions
 *   FROM campaign
 *   WHERE segments.date DURING LAST_30_DAYS
 */

async function getToken(orgId: string) {
  const integ = await prisma.integration.findUnique({
    where: { orgId_provider: { orgId, provider: "GOOGLE_ADS" } },
  });
  if (!integ || integ.status !== "CONNECTED" || !integ.accessToken) return null;
  // TODO: refresh if expired
  return integ.accessToken;
}

export const liveGoogleAds: GoogleAdsAdapter = {
  async listCampaigns(customerId): Promise<AdsCampaign[]> {
    logger.info("google-ads.listCampaigns (stub)", {
      customerId,
      env: env.NODE_ENV,
    });
    return [];
  },

  async getAccountInsights(customerId, range): Promise<AdsAccountInsights> {
    logger.info("google-ads.getAccountInsights (stub)", { customerId, range });
    return {
      customerId,
      rangeStart: range.from.toISOString(),
      rangeEnd: range.to.toISOString(),
      spendCents: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      cpcCents: 0,
    };
  },

  async isConnected(orgId) {
    const integ = await prisma.integration.findUnique({
      where: { orgId_provider: { orgId, provider: "GOOGLE_ADS" } },
    });
    return integ?.status === "CONNECTED";
  },
};
