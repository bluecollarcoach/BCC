import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  hasEntraConfigured,
  hasQboConfigured,
  hasRealtime,
  hasAppInsights,
  hasAzureBlob,
} from "@/lib/env";
import { Plug } from "lucide-react";

export const metadata = { title: "Admin · Integrations" };

const PROVIDERS = [
  {
    key: "MICROSOFT_GRAPH" as const,
    name: "Microsoft 365 (Graph)",
    description: "Calendar sync, email, Teams presence.",
    docsUrl: "https://learn.microsoft.com/graph/auth-v2-user",
    available: () => hasEntraConfigured,
  },
  {
    key: "QBO" as const,
    name: "QuickBooks Online",
    description: "Financial KPIs synced into the dashboard and bookkeeping.",
    docsUrl: "https://developer.intuit.com",
    available: () => hasQboConfigured,
  },
  {
    key: "SIGNALR" as const,
    name: "Azure SignalR Service",
    description: "Production-grade realtime for chat at scale.",
    docsUrl: "https://learn.microsoft.com/azure/azure-signalr/",
    available: () => hasRealtime,
  },
] as const;

const SECONDARY = [
  {
    name: "Application Insights",
    available: hasAppInsights,
    description: "Telemetry, logging, exception tracking.",
  },
  {
    name: "Azure Blob Storage",
    available: hasAzureBlob,
    description: "Documents and large file storage.",
  },
];

export default async function IntegrationsPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const integrations = await prisma.integration.findMany({
    where: { orgId: session.user.orgId },
  });
  const byKey = new Map(integrations.map((i) => [i.provider, i]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect external services. Credentials are stored encrypted at rest."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((p) => {
          const integ = byKey.get(p.key);
          const envReady = p.available();
          const connected = integ?.status === "CONNECTED";
          return (
            <Card key={p.key}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>{p.name}</CardTitle>
                    <CardDescription>{p.description}</CardDescription>
                  </div>
                  <Badge
                    variant={
                      connected ? "success" : envReady ? "warning" : "muted"
                    }
                  >
                    {connected ? "Connected" : envReady ? "Ready to connect" : "Env not configured"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                {!envReady && (
                  <p className="text-xs text-muted-foreground flex-1">
                    Set credentials in <code>.env</code> first, then restart the app.{" "}
                    <a className="text-gold underline" href={p.docsUrl} target="_blank" rel="noreferrer">
                      Setup docs →
                    </a>
                  </p>
                )}
                {envReady && !connected && (
                  <Button asChild>
                    <a href={`/api/integrations/${p.key.toLowerCase()}/connect`}>
                      <Plug className="h-4 w-4" /> Connect
                    </a>
                  </Button>
                )}
                {connected && (
                  <>
                    <p className="text-xs text-muted-foreground flex-1">
                      Connected{integ?.connectedAt ? ` since ${integ.connectedAt.toLocaleDateString()}` : ""}.
                    </p>
                    <Button variant="outline" size="sm">Manage</Button>
                    <Button variant="ghost" size="sm" className="text-destructive">Disconnect</Button>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Platform services</CardTitle>
          <CardDescription>Azure resources configured for this deployment.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {SECONDARY.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
            >
              <div>
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-muted-foreground">{s.description}</div>
              </div>
              <Badge variant={s.available ? "success" : "muted"}>
                {s.available ? "Configured" : "Not set"}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
