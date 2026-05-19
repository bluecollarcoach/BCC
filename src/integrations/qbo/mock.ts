import type { QboAdapter, QboKpis } from "./adapter";
import { prisma } from "@/lib/db";

function mockMonth(monthsAgo: number): QboKpis {
  const end = new Date();
  end.setDate(0);
  end.setMonth(end.getMonth() - monthsAgo);
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  const base = 100_000 + (4 - monthsAgo) * 8_000;
  const revenue = (base + Math.floor(Math.random() * 15_000)) * 100;
  const cogs = Math.floor(revenue * 0.42);
  const grossMargin = revenue - cogs;
  const expenses = Math.floor(revenue * 0.31);
  const netIncome = grossMargin - expenses;
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    revenueCents: revenue,
    cogsCents: cogs,
    grossMarginCents: grossMargin,
    expensesCents: expenses,
    netIncomeCents: netIncome,
    cashCents: 80_000_00 + Math.floor(Math.random() * 20_000_00),
    arCents: 25_000_00 + Math.floor(Math.random() * 15_000_00),
    apCents: 18_000_00 + Math.floor(Math.random() * 8_000_00),
  };
}

export const mockQbo: QboAdapter = {
  async monthlyKpis(_orgId, months) {
    return Array.from({ length: months }, (_, i) => mockMonth(months - 1 - i));
  },
  async syncNow(orgId) {
    const months = await this.monthlyKpis(orgId, 6);
    let n = 0;
    for (const m of months) {
      await prisma.financialPeriod.upsert({
        where: {
          orgId_periodStart_periodEnd: {
            orgId,
            periodStart: new Date(m.periodStart),
            periodEnd: new Date(m.periodEnd),
          },
        },
        update: {
          revenueCents: m.revenueCents,
          cogsCents: m.cogsCents,
          grossMarginCents: m.grossMarginCents,
          expensesCents: m.expensesCents,
          netIncomeCents: m.netIncomeCents,
          cashCents: m.cashCents,
          arCents: m.arCents,
          apCents: m.apCents,
          syncedAt: new Date(),
        },
        create: {
          orgId,
          periodStart: new Date(m.periodStart),
          periodEnd: new Date(m.periodEnd),
          revenueCents: m.revenueCents,
          cogsCents: m.cogsCents,
          grossMarginCents: m.grossMarginCents,
          expensesCents: m.expensesCents,
          netIncomeCents: m.netIncomeCents,
          cashCents: m.cashCents,
          arCents: m.arCents,
          apCents: m.apCents,
          source: "MOCK",
        },
      });
      n++;
    }
    return { synced: n };
  },
  async isConnected(_orgId) {
    return false;
  },
};
