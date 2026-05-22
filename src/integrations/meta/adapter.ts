/**
 * Meta adapter — Facebook Pages + Instagram Business via Meta Graph API.
 * API: https://developers.facebook.com/docs/graph-api/
 *
 * One adapter handles both surfaces because Instagram Business accounts are
 * managed through their connected Facebook Page (Graph API node:
 * /{page-id}/instagram_business_account).
 */

export interface MetaPage {
  id: string;
  name: string;
  category?: string;
  followers?: number;
  igAccountId?: string | null;
}

export interface MetaPost {
  id: string;
  surface: "FACEBOOK" | "INSTAGRAM";
  message: string;
  createdAt: string;
  permalink?: string;
  reactions: number;
  comments: number;
  shares?: number;       // FB only
  impressions?: number;
  reach?: number;
}

export interface MetaAdCampaign {
  id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";
  objective: string;     // OUTCOME_LEADS, OUTCOME_SALES, etc.
  dailyBudgetCents: number;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  reach: number;
}

export interface MetaAdapter {
  listPages(userId: string): Promise<MetaPage[]>;
  listPosts(pageId: string, surface: "FACEBOOK" | "INSTAGRAM"): Promise<MetaPost[]>;
  listAdCampaigns(adAccountId: string): Promise<MetaAdCampaign[]>;
  isConnected(orgId: string): Promise<boolean>;
}
