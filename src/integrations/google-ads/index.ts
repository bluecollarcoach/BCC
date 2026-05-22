import { hasGoogleAdsConfigured } from "@/lib/env";
import { mockGoogleAds } from "./mock";
import { liveGoogleAds } from "./live";
import type { GoogleAdsAdapter } from "./adapter";

export const googleAds: GoogleAdsAdapter = hasGoogleAdsConfigured
  ? liveGoogleAds
  : mockGoogleAds;

export type {
  GoogleAdsAdapter,
  AdsCampaign,
  AdsAccountInsights,
} from "./adapter";
