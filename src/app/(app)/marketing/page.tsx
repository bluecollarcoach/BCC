import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Megaphone, Mail, MessageSquare, Share2, Star, Plus } from "lucide-react";

export const metadata = { title: "Marketing" };

const CHANNEL_ICON = {
  EMAIL: Mail,
  SMS: MessageSquare,
  SOCIAL: Share2,
  PRINT: Megaphone,
  REVIEW_REQUEST: Star,
};

export default async function MarketingPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const campaigns = await prisma.campaign.findMany({
    where: { orgId: session.user.orgId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Marketing"
        description="Customer acquisition, retention, reviews — and your internal comms."
        actions={
          <Button asChild>
            <Link href="/marketing/new">
              <Plus className="h-4 w-4" /> New campaign
            </Link>
          </Button>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Active campaigns", value: campaigns.filter((c) => c.status === "RUNNING").length },
          { label: "Scheduled", value: campaigns.filter((c) => c.status === "SCHEDULED").length },
          {
            label: "Total sends (90d)",
            value: campaigns.reduce((s, c) => s + c.sentCount, 0),
          },
          {
            label: "Open rate (avg)",
            value:
              campaigns.length === 0
                ? "—"
                : `${Math.round(
                    (campaigns.reduce((s, c) => s + c.openCount, 0) /
                      Math.max(1, campaigns.reduce((s, c) => s + c.sentCount, 0))) *
                      100,
                  )}%`,
          },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="py-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                {s.label}
              </div>
              <div className="mt-1 font-display text-2xl">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <CardDescription>Email, SMS, social, print, and review requests.</CardDescription>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="No campaigns yet"
              description="Create your first campaign — a review request to your last 20 customers is a great place to start."
              action={
                <Button asChild>
                  <Link href="/marketing/new">
                    <Plus className="h-4 w-4" /> New campaign
                  </Link>
                </Button>
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-2 font-semibold">Campaign</th>
                  <th className="py-2 font-semibold">Channel</th>
                  <th className="py-2 font-semibold">Status</th>
                  <th className="py-2 font-semibold text-right">Sent</th>
                  <th className="py-2 font-semibold text-right">Opens</th>
                  <th className="py-2 font-semibold text-right">Clicks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaigns.map((c) => {
                  const Icon = CHANNEL_ICON[c.channel];
                  return (
                    <tr key={c.id}>
                      <td className="py-3">{c.name}</td>
                      <td className="py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          <Icon className="h-3 w-3" />
                          {c.channel}
                        </span>
                      </td>
                      <td className="py-3">
                        <Badge variant={c.status === "RUNNING" ? "success" : "muted"}>{c.status}</Badge>
                      </td>
                      <td className="py-3 text-right tabular-nums">{c.sentCount}</td>
                      <td className="py-3 text-right tabular-nums">{c.openCount}</td>
                      <td className="py-3 text-right tabular-nums">{c.clickCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Internal comms</CardTitle>
          <CardDescription>Broadcasts to your crew — separate from customer marketing.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: Megaphone, title: "Announcements", desc: "Pin to all crew dashboards." },
            { icon: Mail, title: "SOPs & memos", desc: "Field guides, safety memos, pricing updates." },
            { icon: Star, title: "Recognition", desc: "Shout-outs, top crew, milestones." },
          ].map(({ icon: I, title, desc }) => (
            <div key={title} className="relative rounded-lg border border-border p-4 opacity-70">
              <I className="h-5 w-5 text-amber-700 mb-2" />
              <div className="font-medium">{title}</div>
              <div className="text-xs text-muted-foreground">{desc}</div>
              <span className="absolute top-2 right-2 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Soon
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
