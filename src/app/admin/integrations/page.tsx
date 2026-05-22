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
  hasGoogleAdsConfigured,
  hasLinkedInConfigured,
  hasMetaConfigured,
  hasRealtime,
  hasAppInsights,
  hasAzureBlob,
} from "@/lib/env";
import { Plug } from "lucide-react";

export const metadata = { title: "Admin · Integrations" };

interface Provider {
  key: string;
  name: string;
  group: "Auth & Sync" | "Finance" | "Marketing & Ads" | "Platform";
  description: string;
  docsUrl: string;
  available: () => boolean;
}

const PROVIDERS: Provider[] = [
  {
    key: "MICROSOFT_GRAPH",
    name: "Microsoft 365 (Graph)",
    group: "Auth & Sync",
    description: "SSO, calendar two-way sync, mail send, Teams presence.",
    docsUrl: "https://learn.microsoft.com/graph/auth-v2-user",
    available: () => hasEntraConfigured,
  },
  {
    key: "QBO",
    name: "QuickBooks Online",
    group: "Finance",
    description: "Financial KPIs synced into Dashboard and Bookkeeping.",
    docsUrl: "https://developer.intuit.com",
    available: () => hasQboConfigured,
  },
  {
    key: "GOOGLE_ADS",
    name: "Google Ads",
    group: "Marketing & Ads",
    description: "Campaign performance, spend, impressions, conversions.",
    docsUrl: "https://developers.google.com/google-ads/api/docs/start",
    available: () => hasGoogleAdsConfigured,
  },
  {
    key: "LINKEDIN",
    name: "LinkedIn (Marketing API)",
    group: "Marketing & Ads",
    description: "Sponsored content + organic Company Page posts and analytics.",
    docsUrl: "https://learn.microsoft.com/linkedin/marketing/",
    available: () => hasLinkedInConfigured,
  },
  {
    key: "META",
    name: "Meta (Facebook + Instagram)",
    group: "Marketing & Ads",
    description: "Page + IG posts, insights, and Marketing API campaigns.",
    docsUrl: "https://developers.facebook.com/docs/graph-api/",
    available: () => hasMetaConfigured,
  },
  {
    key: "SIGNALR",
    name: "Azure SignalR Service",
    group: "Platform",
    description: "Production-grade realtime for chat at scale.",
    docsUrl: "https://learn.microsoft.com/azure/azure-signalr/",
    available: () => hasRealtime,
  },
];

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

const GROUPS: Provider["group"][] = ["Auth & Sync", "Finance", "Marketing & Ads", "Platform"];

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

      {GROUPS.map((group) => {
        const items = PROVIDERS.filter((p) => p.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} className="space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {group}
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {items.map((p) => {
                const integ = byKey.get(p.key);
                const envReady = p.available();
                const connected = integ?.status === "CONNECTED";
                return (
                  <Card key={p.key} accent={connected}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <CardTitle>{p.name}</CardTitle>
                          <CardDescription>{p.description}</CardDescription>
                        </div>
                        <Badge
                          variant={
                            connected ? "success" : envReady ? "warning" : "muted"
                          }
                        >
                          {connected
                            ? "Connected"
                            : envReady
                            ? "Ready"
                            : "Env not set"}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-wrap items-center gap-2">
                      {!envReady && (
                        <p className="text-xs text-muted-foreground flex-1">
                          Set credentials in <code>.env</code> first.{" "}
                          <a className="text-amber-700 underline" href={p.docsUrl} target="_blank" rel="noreferrer">
                            Setup docs →
                          </a>
                        </p>
                      )}
                      {envReady && !connected && (
                        <Button asChild>
                          <a href={`/api/integrations/${p.key.toLowerCase().replace(/_/g, "-")}/connect`}>
                            <Plug className="h-4 w-4" /> Connect
                          </a>
                        </Button>
                      )}
                      {connected && (
                        <>
                          <p className="text-xs text-muted-foreground flex-1">
                            Connected
                            {integ?.connectedAt
                              ? ` since ${integ.connectedAt.toLocaleDateString()}`
                              : ""}
                            .
                          </p>
                          <Button variant="outline" size="sm">Manage</Button>
                          <Button variant="ghost" size="sm" className="text-destructive">
                            Disconnect
                          </Button>
                        </>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}

      <Card>
        <CardHeader>
          <CardTitle>Platform services</CardTitle>
          <CardDescription>Azure resources configured for this deployment.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {SECONDARY.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"
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
