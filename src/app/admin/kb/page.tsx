import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen, ExternalLink } from "lucide-react";

export const metadata = { title: "Admin · Knowledge Base" };

const ARTICLES = [
  {
    title: "Connect Microsoft 365",
    summary: "Register the Entra app, set redirect URIs, configure Graph scopes.",
    href: "/docs/integrations#microsoft",
  },
  {
    title: "Connect QuickBooks Online",
    summary: "Intuit developer app setup, sandbox vs. production, OAuth2.",
    href: "/docs/integrations#qbo",
  },
  {
    title: "Deploy to Azure",
    summary: "Provision App Service + Azure SQL + SignalR with the Bicep templates.",
    href: "/docs/azure-deploy",
  },
  {
    title: "Roles & permissions",
    summary: "OWNER vs. ADMIN vs. COACH vs. STAFF vs. CUSTOMER.",
    href: "/docs/rbac",
  },
];

export default function KbPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Base"
        description="Operating manual for the platform."
      />
      <div className="grid gap-3 md:grid-cols-2">
        {ARTICLES.map((a) => (
          <Card key={a.title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen className="h-4 w-4 text-gold" /> {a.title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{a.summary}</p>
              <a href={a.href} className="mt-3 inline-flex items-center gap-1 text-xs text-gold">
                Read <ExternalLink className="h-3 w-3" />
              </a>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
