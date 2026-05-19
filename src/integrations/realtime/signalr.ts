import type { RealtimeAdapter, RealtimeMessage } from "./adapter";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Azure SignalR Service adapter — STUBBED.
 *
 * To wire up:
 *   1. `npm install @azure/web-pubsub`  (recommended path) OR
 *      use the Azure SignalR Service REST API directly.
 *   2. Replace the body of each method with real HTTP/SDK calls.
 *   3. Set SIGNALR_CONNECTION_STRING in env to enable.
 *
 * Reference: https://learn.microsoft.com/azure/azure-signalr/
 */
export const signalRRealtime: RealtimeAdapter = {
  async publish(channelId, message: RealtimeMessage) {
    if (!env.SIGNALR_CONNECTION_STRING) {
      logger.warn("signalr.publish.skipped — no connection string", { channelId });
      return;
    }
    // TODO: REST POST to /api/v1/hubs/{hub}/groups/{group}/messages
    logger.info("signalr.publish (stub)", { channelId, messageId: message.messageId });
  },

  async *subscribe(_channelId, signal) {
    // Server-side subscription happens via the SignalR service negotiation;
    // clients receive events directly. This method exists only for parity with
    // the mock adapter, which proxies messages via SSE.
    await new Promise((res) => signal.addEventListener("abort", () => res(null), { once: true }));
    return;
  },

  async issueClientToken(userId) {
    if (!env.SIGNALR_CONNECTION_STRING) {
      return { url: "/api/chat/stream", accessToken: "mock" };
    }
    // TODO: parse connection string, sign a JWT with the SignalR endpoint key,
    // and return the client URL + token.
    logger.info("signalr.issueClientToken (stub)", { userId });
    return { url: "/api/chat/stream", accessToken: "stub" };
  },
};
