/**
 * QuickBooks Online adapter.
 *
 * Provides financial KPIs we cache in FinancialPeriod rows.
 * Real impl uses the Intuit OAuth2 + accounting v3 REST API.
 */

export interface QboKpis {
  periodStart: string;
  periodEnd: string;
  revenueCents: number;
  cogsCents: number;
  grossMarginCents: number;
  expensesCents: number;
  netIncomeCents: number;
  cashCents: number;
  arCents: number;
  apCents: number;
}

export interface QboAdapter {
  /** Get monthly KPIs for the last N months. */
  monthlyKpis(orgId: string, months: number): Promise<QboKpis[]>;
  /** Trigger a manual sync — populates FinancialPeriod table. */
  syncNow(orgId: string): Promise<{ synced: number }>;
  isConnected(orgId: string): Promise<boolean>;
}
