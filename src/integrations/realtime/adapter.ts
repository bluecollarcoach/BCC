/**
 * Realtime adapter interface. Swap implementations:
 *   - mock.ts        (default; in-memory, single instance)
 *   - signalr.ts     (Azure SignalR Service)
 */

export interface RealtimeMessage {
  channelId: string;
  messageId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface RealtimeAdapter {
  /** Publish a message to a channel (server-side). */
  publish(channelId: string, message: RealtimeMessage): Promise<void>;
  /** Subscribe to a channel from a server route, returning an async iterator. */
  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<RealtimeMessage>;
  /** Return a short-lived client-side connection token. */
  issueClientToken(userId: string): Promise<{ url: string; accessToken: string }>;
}
