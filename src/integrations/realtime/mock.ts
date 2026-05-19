import type { RealtimeAdapter, RealtimeMessage } from "./adapter";

type Listener = (msg: RealtimeMessage) => void;

const channels = new Map<string, Set<Listener>>();

export const mockRealtime: RealtimeAdapter = {
  async publish(channelId, message) {
    const set = channels.get(channelId);
    if (!set) return;
    for (const l of set) {
      try {
        l(message);
      } catch {
        // ignore
      }
    }
  },

  async *subscribe(channelId, signal) {
    const queue: RealtimeMessage[] = [];
    let notify: (() => void) | null = null;
    const listener: Listener = (m) => {
      queue.push(m);
      notify?.();
    };
    let set = channels.get(channelId);
    if (!set) {
      set = new Set();
      channels.set(channelId, set);
    }
    set.add(listener);

    try {
      while (!signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((res) => {
            notify = res;
            signal.addEventListener("abort", res, { once: true });
          });
          notify = null;
        }
      }
    } finally {
      set.delete(listener);
      if (set.size === 0) channels.delete(channelId);
    }
  },

  async issueClientToken() {
    // Mock token — frontend uses SSE/polling instead.
    return { url: "/api/chat/stream", accessToken: "mock" };
  },
};
