"use client";
import * as React from "react";
import { Send, Paperclip, Smile } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn, relativeTime } from "@/lib/utils";

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name?: string | null; image?: string | null };
}

export function ChannelView({
  channelId,
  channelName,
  channelKind,
  topic,
  currentUserId,
  initialMessages,
}: {
  channelId: string;
  channelName: string;
  channelKind: string;
  topic?: string | null;
  currentUserId: string;
  initialMessages: ChatMessage[];
}) {
  const [messages, setMessages] = React.useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  // SSE subscription for new messages
  React.useEffect(() => {
    const ctl = new AbortController();
    const url = `/api/chat/stream?channelId=${encodeURIComponent(channelId)}`;
    const es = new EventSource(url);
    es.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data) as ChatMessage;
        setMessages((prev) =>
          prev.some((p) => p.id === m.id) ? prev : [...prev, m],
        );
      } catch {
        // ignore
      }
    });
    es.addEventListener("error", () => {
      // EventSource auto-reconnects; surface a soft indicator later.
    });
    return () => {
      es.close();
      ctl.abort();
    };
  }, [channelId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft("");
    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, body }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = (await res.json()) as ChatMessage;
      setMessages((prev) =>
        prev.some((p) => p.id === created.id) ? prev : [...prev, created],
      );
    } catch (err) {
      console.error(err);
      setDraft(body); // restore
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="flex flex-col h-full bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-display text-lg leading-tight">
            <span className="text-muted-foreground">{channelKind === "PUBLIC" ? "#" : ""}</span>
            {channelName}
          </h2>
          {topic && <p className="text-xs text-muted-foreground">{topic}</p>}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-12">
            No messages yet. Say hi.
          </p>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped =
            prev &&
            prev.author.id === m.author.id &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          const mine = m.author.id === currentUserId;
          return (
            <div
              key={m.id}
              className={cn(
                "flex gap-3 animate-fade-in",
                mine && "flex-row-reverse",
              )}
            >
              <div className={cn("w-8 shrink-0", grouped && "opacity-0")}>
                {!grouped && <Avatar name={m.author.name} src={m.author.image} size={32} />}
              </div>
              <div className={cn("max-w-[75%]", mine && "items-end text-right")}>
                {!grouped && (
                  <div className={cn("text-xs", mine && "text-right")}>
                    <span className="font-semibold">{m.author.name ?? "Unknown"}</span>
                    <span className="ml-2 text-muted-foreground">
                      {relativeTime(m.createdAt)}
                    </span>
                  </div>
                )}
                <div
                  className={cn(
                    "mt-0.5 inline-block rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
                    mine
                      ? "bg-gold/15 text-foreground border border-gold/30"
                      : "bg-card border border-border",
                  )}
                >
                  {m.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={send}
        className="border-t border-border bg-card/50 p-3 flex items-center gap-2"
      >
        <button type="button" className="p-2 rounded hover:bg-muted text-muted-foreground" aria-label="Attach">
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Message ${channelName}`}
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          disabled={sending}
        />
        <button type="button" className="p-2 rounded hover:bg-muted text-muted-foreground" aria-label="Emoji">
          <Smile className="h-4 w-4" />
        </button>
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="inline-flex items-center gap-1 rounded-md bg-gold px-3 py-2 text-xs font-bold uppercase tracking-wider text-ink-900 hover:bg-gold-600 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          Send
        </button>
      </form>
    </section>
  );
}
