/**
 * Google Ads adapter — campaign + account-level reporting.
 *
 * Auth: Google OAuth 2.0 (consent screen) + Google Ads developer token.
 * API:  https://developers.google.com/google-ads/api/docs/start
 */

export interface AdsCampaign {
  id: string;
  name: string;
  status: "ENABLED" | "PAUSED" | "REMOVED";
  channel: string; // SEARCH, DISPLAY, PERFORMANCE_MAX, etc.
  budgetCents: number;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface AdsAccountInsights {
  customerId: string;
  rangeStart: string; // ISO
  rangeEnd: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;       // %
  cpcCents: number;
}

export interface GoogleAdsAdapter {
  listCampaigns(customerId: string): Promise<AdsCampaign[]>;
  getAccountInsights(
    customerId: string,
    range: { from: Date; to: Date },
  ): Promise<AdsAccountInsights>;
  isConnected(orgId: string): Promise<boolean>;
}
