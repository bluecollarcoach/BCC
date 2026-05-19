import { prisma } from "@/lib/db";

/**
 * Returns the dashboard KPI snapshot for an org.
 * In production these query QBO-synced FinancialPeriod rows + live CRM/time data.
 * For dev / empty orgs we fall back to representative mock values.
 */
export async function getDashboardKpis(orgId: string | null | undefined) {
  if (!orgId) return mockKpis();

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfPrev = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [openDeals, wonThisMonth, activeContacts, runningTimers, last6mo] =
    await Promise.all([
      prisma.deal.count({ where: { orgId, status: "OPEN" } }),
      prisma.deal.aggregate({
        where: {
          orgId,
          status: "WON",
          closedAt: { gte: startOfMonth },
        },
        _sum: { amountCents: true },
        _count: true,
      }),
      prisma.contact.count({
        where: { orgId, stage: { in: ["QUALIFIED", "CUSTOMER"] } },
      }),
      prisma.timeEntry.count({ where: { orgId, status: "RUNNING" } }),
      prisma.financialPeriod.findMany({
        where: { orgId },
        orderBy: { periodEnd: "desc" },
        take: 6,
      }),
    ]);

  const revenueSeries =
    last6mo.length > 0
      ? last6mo
          .slice()
          .reverse()
          .map((p) => ({
            label: p.periodEnd.toLocaleString("en-US", { month: "short" }),
            revenue: p.revenueCents / 100,
          }))
      : mockSeries();

  const monthRevenueCents = (wonThisMonth._sum.amountCents ?? 0);

  return {
    monthRevenueCents,
    openDealsCount: openDeals,
    activeContactsCount: activeContacts,
    runningTimersCount: runningTimers,
    wonCountMonth: wonThisMonth._count,
    revenueSeries,
    // Real impl would compute these from FinancialPeriod
    cashCents: last6mo[0]?.cashCents ?? 0,
    arCents: last6mo[0]?.arCents ?? 0,
    grossMarginPct:
      last6mo[0] && last6mo[0].revenueCents > 0
        ? Math.round(
            (last6mo[0].grossMarginCents / last6mo[0].revenueCents) * 100,
          )
        : null,
    prevPeriodPresent: !!last6mo[1],
  };
}

function mockKpis() {
  return {
    monthRevenueCents: 128_400_00,
    openDealsCount: 14,
    activeContactsCount: 87,
    runningTimersCount: 3,
    wonCountMonth: 6,
    revenueSeries: mockSeries(),
    cashCents: 84_200_00,
    arCents: 32_500_00,
    grossMarginPct: 47,
    prevPeriodPresent: true,
  };
}

function mockSeries() {
  return [
    { label: "Dec", revenue: 92_400 },
    { label: "Jan", revenue: 104_800 },
    { label: "Feb", revenue: 88_900 },
    { label: "Mar", revenue: 116_300 },
    { label: "Apr", revenue: 121_700 },
    { label: "May", revenue: 128_400 },
  ];
}
