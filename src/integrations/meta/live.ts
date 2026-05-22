import type {
  MetaAdCampaign,
  MetaAdapter,
  MetaPage,
  MetaPost,
} from "./adapter";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Meta live adapter — SCAFFOLD.
 *
 * Setup (~1 hour, plus App Review delay if going beyond test mode):
 *   1. https://developers.facebook.com/apps → Create app (Business type).
 *   2. Add products:
 *        - Facebook Login for Business
 *        - Marketing API
 *        - Instagram Graph API
 *   3. OAuth redirect: <APP_URL>/api/integrations/meta/callback
 *   4. Permissions you'll request via OAuth (advanced ones need App Review):
 *        pages_show_list, pages_read_engagement, pages_manage_posts
 *        instagram_basic, instagram_content_publish, instagram_manage_insights
 *        ads_read, ads_management, business_management
 *   5. Use Graph API v19+: https://graph.facebook.com/v19.0/...
 *
 * Token model:
 *   - User Access Token → exchange for Long-Lived Token (60d)
 *   - Page Access Token (no expiry once derived from long-lived user token)
 *   - Persist all of these in the Integration row.
 */

async function getAuth(orgId: string) {
  const integ = await prisma.integration.findUnique({
    where: { orgId_provider: { orgId, provider: "META" } },
  });
  if (!integ || integ.status !== "CONNECTED" || !integ.accessToken) return null;
  return integ.accessToken;
}

export const liveMeta: MetaAdapter = {
  async listPages(userId): Promise<MetaPage[]> {
    logger.info("meta.listPages (stub)", { userId });
    // TODO: GET /me/accounts?fields=id,name,category,followers_count,instagram_business_account
    return [];
  },
  async listPosts(pageId, surface): Promise<MetaPost[]> {
    logger.info("meta.listPosts (stub)", { pageId, surface });
    // TODO:
    //   FB:  GET /{page-id}/posts?fields=id,message,created_time,permalink_url,...
    //   IG:  GET /{ig-business-id}/media?fields=id,caption,timestamp,permalink,...
    return [];
  },
  async listAdCampaigns(adAccountId): Promise<MetaAdCampaign[]> {
    logger.info("meta.listAdCampaigns (stub)", { adAccountId });
    // TODO: GET /act_{ad-account-id}/campaigns?fields=id,name,status,objective,...
    //       Then GET /{campaign-id}/insights for spend/impressions/etc.
    return [];
  },
  async isConnected(orgId) {
    const integ = await prisma.integration.findUnique({
      where: { orgId_provider: { orgId, provider: "META" } },
    });
    return integ?.status === "CONNECTED";
  },
};
