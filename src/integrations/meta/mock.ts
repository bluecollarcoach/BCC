import type {
  MetaAdCampaign,
  MetaAdapter,
  MetaPage,
  MetaPost,
} from "./adapter";

const PAGES: MetaPage[] = [
  {
    id: "fb-page-1",
    name: "Blue Collar Coach",
    category: "Business Consultant",
    followers: 4_280,
    igAccountId: "ig-1",
  },
];

const FB_POSTS: MetaPost[] = [
  {
    id: "fb-post-1",
    surface: "FACEBOOK",
    message:
      "If your books only get reconciled once a quarter, you're flying blind. Here's the 20-minute weekly close we coach every owner through.",
    createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(),
    reactions: 38, comments: 7, shares: 12, impressions: 2_410, reach: 1_640,
  },
  {
    id: "fb-post-2",
    surface: "FACEBOOK",
    message:
      "Hiring a foreman ≠ promoting your best tech. The lead-tech-to-foreman trap kills more crews than any market downturn.",
    createdAt: new Date(Date.now() - 4 * 86400_000).toISOString(),
    reactions: 62, comments: 11, shares: 24, impressions: 4_120, reach: 2_980,
  },
];

const IG_POSTS: MetaPost[] = [
  {
    id: "ig-post-1",
    surface: "INSTAGRAM",
    message: "Clarity beats motivation. Every time. #blueCollarCoach",
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    reactions: 142, comments: 18, impressions: 3_840, reach: 2_840,
  },
];

const CAMPAIGNS: MetaAdCampaign[] = [
  {
    id: "fb-camp-1",
    name: "Lead Magnet · 7-Day Cash Reset",
    status: "ACTIVE",
    objective: "OUTCOME_LEADS",
    dailyBudgetCents: 75_00,
    spendCents: 1_280_00,
    impressions: 38_400,
    clicks: 902,
    conversions: 42,
    reach: 19_200,
  },
  {
    id: "fb-camp-2",
    name: "Retarget · Site Visitors 30d",
    status: "ACTIVE",
    objective: "OUTCOME_ENGAGEMENT",
    dailyBudgetCents: 25_00,
    spendCents: 420_00,
    impressions: 18_200,
    clicks: 380,
    conversions: 9,
    reach: 6_800,
  },
];

export const mockMeta: MetaAdapter = {
  async listPages() { return PAGES; },
  async listPosts(_pageId, surface) {
    return surface === "FACEBOOK" ? FB_POSTS : IG_POSTS;
  },
  async listAdCampaigns() { return CAMPAIGNS; },
  async isConnected() { return false; },
};
