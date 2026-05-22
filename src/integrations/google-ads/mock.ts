import type {
  AdsAccountInsights,
  AdsCampaign,
  GoogleAdsAdapter,
} from "./adapter";

const MOCK_CAMPAIGNS: AdsCampaign[] = [
  {
    id: "g-1",
    name: "Brand · Search",
    status: "ENABLED",
    channel: "SEARCH",
    budgetCents: 50_00 * 100,
    spendCents: 38_42 * 100,
    impressions: 12_480,
    clicks: 410,
    conversions: 22,
  },
  {
    id: "g-2",
    name: "Trade Owners · Lookalike",
    status: "ENABLED",
    channel: "PERFORMANCE_MAX",
    budgetCents: 75_00 * 100,
    spendCents: 68_19 * 100,
    impressions: 41_280,
    clicks: 901,
    conversions: 38,
  },
  {
    id: "g-3",
    name: "Remarketing · Website Visitors",
    status: "PAUSED",
    channel: "DISPLAY",
    budgetCents: 25_00 * 100,
    spendCents: 12_05 * 100,
    impressions: 80_200,
    clicks: 240,
    conversions: 6,
  },
];

function sumInsights(c: AdsCampaign[], customerId: string, range: { from: Date; to: Date }): AdsAccountInsights {
  const spendCents = c.reduce((s, x) => s + x.spendCents, 0);
  const impressions = c.reduce((s, x) => s + x.impressions, 0);
  const clicks = c.reduce((s, x) => s + x.clicks, 0);
  const conversions = c.reduce((s, x) => s + x.conversions, 0);
  return {
    customerId,
    rangeStart: range.from.toISOString(),
    rangeEnd: range.to.toISOString(),
    spendCents,
    impressions,
    clicks,
    conversions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpcCents: clicks > 0 ? Math.floor(spendCents / clicks) : 0,
  };
}

export const mockGoogleAds: GoogleAdsAdapter = {
  async listCampaigns() {
    return MOCK_CAMPAIGNS;
  },
  async getAccountInsights(customerId, range) {
    return sumInsights(MOCK_CAMPAIGNS, customerId, range);
  },
  async isConnected() {
    return false;
  },
};
