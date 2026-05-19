import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listChannels } from "@/server/services/chat";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { MessageSquare, Hash, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Chat" };

export default async function ChatHomePage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const channels = await listChannels(session.user.orgId, session.user.id);

  if (channels.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Chat" description="Team and customer messaging." />
        <EmptyState
          icon={MessageSquare}
          title="No channels yet"
          description="Channels are created when you seed the database, or via Admin → Channels."
        />
      </div>
    );
  }

  // Auto-redirect to the first channel
  redirect(`/chat/${channels[0].id}`);
}
