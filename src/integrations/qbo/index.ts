import { hasQboConfigured } from "@/lib/env";
import { mockQbo } from "./mock";
import { qboLive } from "./qbo";
import type { QboAdapter } from "./adapter";

export const qbo: QboAdapter = hasQboConfigured ? qboLive : mockQbo;
export type { QboAdapter, QboKpis } from "./adapter";
