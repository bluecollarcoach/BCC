import type {
  LinkedInAdCampaign,
  LinkedInAdapter,
  LinkedInPost,
} from "./adapter";

const MOCK_POSTS: LinkedInPost[] = [
  {
    id: "urn:li:ugcPost:mock-1",
    author: "urn:li:organization:0",
    text: "How three shop owners cut overhead 18% in 90 days. The pattern wasn't motivation — it was a single change to their weekly review cadence.",
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    likes: 42, comments: 6, shares: 9, impressions: 1840,
  },
  {
    id: "urn:li:ugcPost:mock-2",
    author: "urn:li:organization:0",
    text: "If your foreman is also your dispatcher, your estimator, and your CFO, you don't have a business. You have an expensive job. Here's how to start delegating.",
    createdAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
    likes: 87, comments: 14, shares: 22, impressions: 4120,
  },
];

const MOCK_CAMPAIGNS: LinkedInAdCampaign[] = [
  {
    id: "urn:li:sponsoredCampaign:mock-1",
    name: "Coaching Lead Gen · Owners 25-150 emp",
    status: "ACTIVE",
    type: "SPONSORED_UPDATES",
    dailyBudgetCents: 100_00,
    spendCents: 1_840_00,
    impressions: 28_400,
    clicks: 612,
    conversions: 18,
  },
  {
    id: "urn:li:sponsoredCampaign:mock-2",
    name: "Webinar Promo · Q2",
    status: "PAUSED",
    type: "DYNAMIC",
    dailyBudgetCents: 50_00,
    spendCents: 620_00,
    impressions: 9_840,
    clicks: 184,
    conversions: 7,
  },
];

export const mockLinkedIn: LinkedInAdapter = {
  async listOrganicPosts() { return MOCK_POSTS; },
  async listAdCampaigns() { return MOCK_CAMPAIGNS; },
  async isConnected() { return false; },
};
