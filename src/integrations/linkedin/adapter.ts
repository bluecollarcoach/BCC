/**
 * LinkedIn adapter — organic Company Page posts + Marketing (ads) API.
 * API: https://learn.microsoft.com/linkedin/marketing/
 */

export interface LinkedInPost {
  id: string;          // urn:li:ugcPost:...
  author: string;      // urn:li:organization:...
  text: string;
  createdAt: string;
  likes: number;
  comments: number;
  shares: number;
  impressions: number;
}

export interface LinkedInAdCampaign {
  id: string;          // urn:li:sponsoredCampaign:...
  name: string;
  status: "ACTIVE" | "PAUSED" | "DRAFT" | "ARCHIVED";
  type: string;        // SPONSORED_UPDATES, TEXT_AD, DYNAMIC, etc.
  dailyBudgetCents: number;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface LinkedInAdapter {
  listOrganicPosts(orgUrn: string): Promise<LinkedInPost[]>;
  listAdCampaigns(adAccountId: string): Promise<LinkedInAdCampaign[]>;
  isConnected(orgId: string): Promise<boolean>;
}
