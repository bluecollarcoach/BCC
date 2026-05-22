import { hasMetaConfigured } from "@/lib/env";
import { mockMeta } from "./mock";
import { liveMeta } from "./live";
import type { MetaAdapter } from "./adapter";

export const meta: MetaAdapter = hasMetaConfigured ? liveMeta : mockMeta;

export type {
  MetaAdapter,
  MetaPage,
  MetaPost,
  MetaAdCampaign,
} from "./adapter";
