import { hasRealtime } from "@/lib/env";
import { mockRealtime } from "./mock";
import { signalRRealtime } from "./signalr";
import type { RealtimeAdapter } from "./adapter";

export const realtime: RealtimeAdapter = hasRealtime ? signalRRealtime : mockRealtime;
export type { RealtimeAdapter, RealtimeMessage } from "./adapter";
