import {
  DollarSign,
  TrendingUp,
  Users,
  Clock,
  Briefcase,
  Banknote,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { getDashboardKpis } from "@/server/services/kpis";
import { PageHeader } from "@/components/ui/page-header";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { RevenueChart } from "@/components/dashboard/revenue-chart";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import Link from "next/link";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await auth();
  const kpis = await getDashboardKpis(session?.user?.orgId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good morning${session?.user?.name ? `, ${session.user.name.split(" ")[0]}` : ""}.`}
        description="Here's what needs your attention today."
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/integrations">Sync data</Link>
          </Button>
        }
      />

      <section className="grid gap-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="MTD Revenue"
          value={formatCurrency(kpis.monthRevenueCents)}
          delta="+12.4%"
          helper="vs last month"
          trend="up"
          icon={DollarSign}
        />
        <KpiCard
          label="Open Deals"
          value={kpis.openDealsCount.toString()}
          helper="In pipeline"
          icon={Briefcase}
        />
        <KpiCard
          label="Active Customers"
          value={kpis.activeContactsCount.toString()}
          delta="+3"
          helper="this week"
          trend="up"
          icon={Users}
        />
        <KpiCard
          label="Running Timers"
          value={kpis.runningTimersCount.toString()}
          helper="crew on the clock"
          icon={Clock}
        />
        <KpiCard
          label="Cash on Hand"
          value={formatCurrency(kpis.cashCents)}
          helper="From QBO"
          icon={Banknote}
        />
        <KpiCard
          label="Gross Margin"
          value={kpis.grossMarginPct != null ? `${kpis.grossMarginPct}%` : "—"}
          delta={kpis.grossMarginPct ? "+2.1pp" : undefined}
          helper="Last close"
          trend="up"
          icon={TrendingUp}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Revenue · last 6 months</CardTitle>
                <CardDescription>
                  Sourced from QuickBooks Online closed periods.
                </CardDescription>
              </div>
              <Badge variant="muted">Demo data</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <RevenueChart data={kpis.revenueSeries} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What's next</CardTitle>
            <CardDescription>Your most actionable items.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { tag: "deal", text: "Follow up: Henley HVAC retrofit — quote sent 4 days ago.", href: "/crm" },
              { tag: "time", text: "2 timesheets pending your approval.", href: "/time" },
              { tag: "chat", text: "3 unread messages in #install-crew.", href: "/chat" },
              { tag: "calendar", text: "Lunch with Mike Castro at 12:30pm.", href: "/calendar" },
            ].map((item) => (
              <Link
                key={item.text}
                href={item.href}
                className="block rounded-md border border-border bg-background/40 p-3 transition hover:border-gold/40"
              >
                <div className="flex items-start gap-3">
                  <Badge variant="outline" className="uppercase text-[10px]">
                    {item.tag}
                  </Badge>
                  <span className="flex-1 text-sm text-foreground/90">{item.text}</span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline health</CardTitle>
            <CardDescription>Deal flow by stage.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {[
              { stage: "Lead", n: 18, v: 32_500 },
              { stage: "Qualified", n: 9, v: 64_200 },
              { stage: "Proposal", n: 5, v: 88_900 },
              { stage: "Negotiation", n: 3, v: 42_100 },
              { stage: "Won (MTD)", n: kpis.wonCountMonth, v: kpis.monthRevenueCents / 100 },
            ].map((row) => (
              <div key={row.stage} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{row.stage}</span>
                <div className="flex items-center gap-4">
                  <span className="text-foreground/90">{row.n} deals</span>
                  <span className="w-28 text-right font-medium tabular-nums">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(row.v)}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Crew utilization · this week</CardTitle>
            <CardDescription>Billable vs. non-billable hours.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { name: "Diego R.", hrs: 38, billable: 34 },
              { name: "Tasha M.", hrs: 41, billable: 39 },
              { name: "Will P.", hrs: 26, billable: 18 },
              { name: "Marcus B.", hrs: 32, billable: 28 },
            ].map((c) => {
              const pct = Math.round((c.billable / c.hrs) * 100);
              return (
                <div key={c.name} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span>{c.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {c.billable}/{c.hrs}h · {pct}% billable
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-gold transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
