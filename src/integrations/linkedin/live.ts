import type {
  LinkedInAdCampaign,
  LinkedInAdapter,
  LinkedInPost,
} from "./adapter";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * LinkedIn live adapter — SCAFFOLD.
 *
 * Setup (~1 hour):
 *   1. https://www.linkedin.com/developers/apps → Create app
 *   2. Add products: "Share on LinkedIn", "Sign In with LinkedIn", "Marketing Developer Platform"
 *      (the last one requires a separate approval — apply early).
 *   3. OAuth redirect: <APP_URL>/api/integrations/linkedin/callback
 *   4. Scopes needed:
 *        r_organization_social  (read org posts + analytics)
 *        w_organization_social  (post on behalf of org)
 *        r_ads, r_ads_reporting (read ads + metrics)
 *        rw_ads                 (manage campaigns)
 *   5. Use Versioned REST API: https://api.linkedin.com/rest/...
 *      with header: LinkedIn-Version: 202401 (or current)
 */

async function getAuth(orgId: string) {
  const integ = await prisma.integration.findUnique({
    where: { orgId_provider: { orgId, provider: "LINKEDIN" } },
  });
  if (!integ || integ.status !== "CONNECTED" || !integ.accessToken) return null;
  return integ.accessToken;
}

export const liveLinkedIn: LinkedInAdapter = {
  async listOrganicPosts(orgUrn): Promise<LinkedInPost[]> {
    logger.info("linkedin.listOrganicPosts (stub)", { orgUrn });
    // TODO: GET /rest/posts?q=author&author={orgUrn}
    return [];
  },
  async listAdCampaigns(adAccountId): Promise<LinkedInAdCampaign[]> {
    logger.info("linkedin.listAdCampaigns (stub)", { adAccountId });
    // TODO: GET /rest/adAccounts/{id}/adCampaigns
    // Then for each: GET /rest/adAnalytics?...
    return [];
  },
  async isConnected(orgId) {
    const integ = await prisma.integration.findUnique({
      where: { orgId_provider: { orgId, provider: "LINKEDIN" } },
    });
    return integ?.status === "CONNECTED";
  },
};
