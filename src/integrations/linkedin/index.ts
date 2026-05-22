import { hasLinkedInConfigured } from "@/lib/env";
import { mockLinkedIn } from "./mock";
import { liveLinkedIn } from "./live";
import type { LinkedInAdapter } from "./adapter";

export const linkedIn: LinkedInAdapter = hasLinkedInConfigured
  ? liveLinkedIn
  : mockLinkedIn;

export type {
  LinkedInAdapter,
  LinkedInPost,
  LinkedInAdCampaign,
} from "./adapter";
