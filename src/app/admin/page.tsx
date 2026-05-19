import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Activity, Plug, ShieldCheck } from "lucide-react";

export const metadata = { title: "Admin · Overview" };

export default async function AdminHomePage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const [userCount, integrationCount, last24hAudits, runningTimers] = await Promise.all([
    prisma.user.count({ where: { orgId: session.user.orgId } }),
    prisma.integration.count({
      where: { orgId: session.user.orgId, status: "CONNECTED" },
    }),
    prisma.auditLog.count({
      where: {
        orgId: session.user.orgId,
        createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    }),
    prisma.timeEntry.count({
      where: { orgId: session.user.orgId, status: "RUNNING" },
    }),
  ]);

  const stats = [
    { label: "Active users", value: userCount, href: "/admin/users", icon: Users },
    { label: "Connected integrations", value: integrationCount, href: "/admin/integrations", icon: Plug },
    { label: "Audit events (24h)", value: last24hAudits, href: "/admin/audit", icon: Activity },
    { label: "Crew on the clock", value: runningTimers, href: "/time", icon: ShieldCheck },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin Center"
        description="Tenant-wide controls. Handle with care."
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="hover:border-gold/40 transition">
              <CardContent className="py-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                      {s.label}
                    </p>
                    <p className="mt-2 font-display text-3xl">{s.value}</p>
                  </div>
                  <div className="rounded-md bg-gold/10 p-2 text-gold ring-1 ring-gold/30">
                    <s.icon className="h-4 w-4" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>System health</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Health label="Database" status="UP" />
          <Health label="Application Insights" status={process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ? "UP" : "OFF"} />
          <Health label="Microsoft Graph" status={process.env.AUTH_MICROSOFT_ENTRA_ID ? "READY" : "OFF"} />
          <Health label="QuickBooks Online" status={process.env.QBO_CLIENT_ID ? "READY" : "OFF"} />
          <Health label="SignalR" status={process.env.SIGNALR_CONNECTION_STRING ? "UP" : "OFF (using mock)"} />
          <Health label="Azure Blob" status={process.env.AZURE_STORAGE_CONNECTION_STRING ? "UP" : "OFF"} />
        </CardContent>
      </Card>
    </div>
  );
}

function Health({ label, status }: { label: string; status: string }) {
  const ok = status === "UP" || status === "READY";
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2 text-sm">
      <span>{label}</span>
      <Badge variant={ok ? "success" : "muted"}>{status}</Badge>
    </div>
  );
}
