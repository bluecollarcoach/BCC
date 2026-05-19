import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { qbo } from "@/integrations/qbo";
import { hasQboConfigured } from "@/lib/env";
import { PageHeader } from "@/components/ui/page-header";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DollarSign, Banknote, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Bookkeeping" };

export default async function BookkeepingPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const periods = await prisma.financialPeriod.findMany({
    where: { orgId: session.user.orgId },
    orderBy: { periodEnd: "desc" },
    take: 12,
  });

  const latest = periods[0];

  async function syncQbo() {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await qbo.syncNow(s.user.orgId);
    revalidatePath("/bookkeeping");
    revalidatePath("/dashboard");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bookkeeping"
        description="Financial KPIs synced from QuickBooks Online."
        actions={
          <>
            <Badge variant={hasQboConfigured ? "success" : "muted"}>
              {hasQboConfigured ? "QBO connected" : "Mock data"}
            </Badge>
            <form action={syncQbo}>
              <Button type="submit">
                <RefreshCw className="h-4 w-4" /> Sync from QBO
              </Button>
            </form>
          </>
        }
      />

      {!latest && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No financial data yet. Click <strong>Sync from QBO</strong> to pull periods.
          </CardContent>
        </Card>
      )}

      {latest && (
        <>
          <section className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Revenue (last period)"
              value={formatCurrency(latest.revenueCents)}
              icon={DollarSign}
              helper={formatDate(latest.periodEnd)}
            />
            <KpiCard
              label="Net Income"
              value={formatCurrency(latest.netIncomeCents)}
              icon={latest.netIncomeCents >= 0 ? TrendingUp : TrendingDown}
              trend={latest.netIncomeCents >= 0 ? "up" : "down"}
            />
            <KpiCard
              label="Cash"
              value={formatCurrency(latest.cashCents)}
              icon={Banknote}
            />
            <KpiCard
              label="AR · AP"
              value={`${formatCurrency(latest.arCents)} · ${formatCurrency(latest.apCents)}`}
            />
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Period history</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Period</th>
                    <th className="px-4 py-2 font-semibold text-right">Revenue</th>
                    <th className="px-4 py-2 font-semibold text-right">COGS</th>
                    <th className="px-4 py-2 font-semibold text-right">Gross Margin</th>
                    <th className="px-4 py-2 font-semibold text-right">Expenses</th>
                    <th className="px-4 py-2 font-semibold text-right">Net Income</th>
                    <th className="px-4 py-2 font-semibold hidden lg:table-cell">Synced</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {periods.map((p) => (
                    <tr key={p.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 text-foreground/90">
                        {formatDate(p.periodStart, { month: "short", year: "numeric" })}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(p.revenueCents)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatCurrency(p.cogsCents)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(p.grossMarginCents)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatCurrency(p.expensesCents)}</td>
                      <td className={`px-4 py-3 text-right font-semibold tabular-nums ${p.netIncomeCents >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatCurrency(p.netIncomeCents)}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                        {formatDate(p.syncedAt, { dateStyle: "short", timeStyle: "short" })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {!hasQboConfigured && (
        <p className="text-xs text-muted-foreground">
          QuickBooks is not connected. Configure credentials in{" "}
          <Link href="/admin/integrations" className="text-gold underline">
            Admin → Integrations
          </Link>
          .
        </p>
      )}
    </div>
  );
}
