import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Briefcase, Plus } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

export const metadata = { title: "Pipeline" };

export default async function DealsPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const pipeline = await prisma.pipeline.findFirst({
    where: { orgId: session.user.orgId, isDefault: true },
    include: {
      stages: {
        orderBy: { order: "asc" },
        include: {
          deals: {
            where: { status: "OPEN" },
            include: { contact: true, owner: true },
            orderBy: { updatedAt: "desc" },
          },
        },
      },
    },
  });

  if (!pipeline) {
    return (
      <div className="space-y-6">
        <PageHeader title="Pipeline" description="Visual deal management." />
        <EmptyState
          icon={Briefcase}
          title="No pipeline yet"
          description="A default pipeline is created when you seed the database. Run `npm run db:seed` to set one up."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pipeline"
        description={pipeline.name}
        actions={
          <Button asChild>
            <Link href="/crm/deals/new">
              <Plus className="h-4 w-4" /> New deal
            </Link>
          </Button>
        }
      />

      <div className="overflow-x-auto -mx-4 px-4 pb-2">
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${pipeline.stages.length}, minmax(280px, 1fr))` }}>
          {pipeline.stages.map((stage) => {
            const total = stage.deals.reduce((sum, d) => sum + d.amountCents, 0);
            return (
              <div key={stage.id} className="flex flex-col rounded-lg border border-border bg-card/40">
                <div className="flex items-center justify-between border-b border-border p-3">
                  <div>
                    <h3 className="text-sm font-semibold">{stage.name}</h3>
                    <p className="text-xs text-muted-foreground">{stage.deals.length} · {formatCurrency(total)}</p>
                  </div>
                  <Badge variant="muted">{stage.probability}%</Badge>
                </div>
                <div className="flex-1 space-y-2 p-3 min-h-[120px]">
                  {stage.deals.map((d) => (
                    <Link
                      key={d.id}
                      href={`/crm/deals/${d.id}`}
                      className="block rounded-md border border-border bg-background p-3 hover:border-gold/40 hover:shadow-glow transition"
                    >
                      <div className="font-medium text-sm">{d.name}</div>
                      <div className="mt-1 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {d.contact ? `${d.contact.firstName} ${d.contact.lastName}` : "—"}
                        </span>
                        <span className="font-semibold tabular-nums text-gold">
                          {formatCurrency(d.amountCents)}
                        </span>
                      </div>
                    </Link>
                  ))}
                  {stage.deals.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No deals here.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
