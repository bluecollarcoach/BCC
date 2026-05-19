import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getChannel, listChannels, listMessages } from "@/server/services/chat";
import { ChannelView } from "@/components/chat/channel-view";
import { Hash, Lock, MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export const metadata = { title: "Chat" };

const KIND_ICON = {
  PUBLIC: Hash,
  PRIVATE: Lock,
  DM: MessageSquare,
  CUSTOMER: Users,
};

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const { channelId } = await params;

  const [channels, channel, messages] = await Promise.all([
    listChannels(session.user.orgId, session.user.id),
    getChannel(session.user.orgId, channelId),
    listMessages(channelId, 100),
  ]);

  if (!channel) notFound();

  return (
    <div className="-mx-4 lg:-mx-8 -my-6 lg:-my-8 grid lg:grid-cols-[260px_1fr] h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem)]">
      {/* Channel list */}
      <aside className="hidden lg:flex flex-col border-r border-border bg-card/40 overflow-y-auto">
        <div className="px-4 py-4 border-b border-border">
          <h2 className="font-display text-lg">Channels</h2>
          <p className="text-xs text-muted-foreground">{channels.length} total</p>
        </div>
        <nav className="p-2 space-y-0.5">
          {channels.map((c) => {
            const Icon = KIND_ICON[c.kind];
            const active = c.id === channelId;
            return (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                  active ? "bg-gold/10 text-gold" : "text-foreground/80 hover:bg-muted",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{c.name}</span>
                {c._count.messages > 0 && (
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {c._count.messages}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Channel content */}
      <ChannelView
        channelId={channel.id}
        channelName={channel.name}
        channelKind={channel.kind}
        topic={channel.topic}
        currentUserId={session.user.id}
        initialMessages={messages
          .slice()
          .reverse()
          .map((m) => ({
            id: m.id,
            body: m.body,
            createdAt: m.createdAt.toISOString(),
            author: {
              id: m.author.id,
              name: m.author.name,
              image: m.author.image,
            },
          }))}
      />
    </div>
  );
}
