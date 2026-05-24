import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  createDeal,
  listContactsForOrg,
  listCompaniesForOrg,
} from "@/server/services/deals";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New deal" };

export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; companyId?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;

  const [pipeline, contacts, companies] = await Promise.all([
    prisma.pipeline.findFirst({
      where: { orgId: session.user.orgId, isDefault: true },
      include: { stages: { orderBy: { order: "asc" } } },
    }),
    listContactsForOrg(session.user.orgId),
    listCompaniesForOrg(session.user.orgId),
  ]);

  if (!pipeline) {
    return (
      <div className="space-y-6">
        <PageHeader title="New deal" />
        <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm">
          No default pipeline configured. Run <code>npm run db:seed</code> against
          this database to create one, or add a pipeline via Admin.
        </div>
      </div>
    );
  }

  async function create(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const amountDollars = Number(fd.get("amount") ?? 0);
    const d = await createDeal(s.user.orgId, s.user.id, {
      name: String(fd.get("name") ?? "").trim() || "Untitled deal",
      amountCents: Math.max(0, Math.round(amountDollars * 100)),
      status: "OPEN",
      pipelineId: String(fd.get("pipelineId") ?? "") || undefined,
      stageId: String(fd.get("stageId") ?? "") || undefined,
      contactId: String(fd.get("contactId") ?? "") || undefined,
      companyId: String(fd.get("companyId") ?? "") || undefined,
      expectedClose: String(fd.get("expectedClose") ?? "") || undefined,
      notes: String(fd.get("notes") ?? "") || undefined,
    });
    redirect(`/crm/deals/${d.id}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="New deal" description="Track a sale opportunity through your pipeline." />
      <Card>
        <CardContent className="pt-6">
          <form action={create} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="name">Deal name *</Label>
                <Input id="name" name="name" required placeholder="Henley HVAC retrofit" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="amount">Amount (USD)</Label>
                <Input id="amount" name="amount" type="number" step="0.01" min="0" placeholder="48000" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="expectedClose">Expected close</Label>
                <Input id="expectedClose" name="expectedClose" type="date" className="mt-1.5" />
              </div>
              <input type="hidden" name="pipelineId" value={pipeline.id} />
              <div>
                <Label htmlFor="stageId">Stage</Label>
                <select id="stageId" name="stageId" defaultValue={pipeline.stages[0]?.id} className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                  {pipeline.stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="contactId">Contact</Label>
                <select id="contactId" name="contactId" defaultValue={sp.contactId ?? ""} className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <option value="">— None —</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.firstName} {c.lastName}{c.email ? ` · ${c.email}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="companyId">Company</Label>
                <select id="companyId" name="companyId" defaultValue={sp.companyId ?? ""} className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <option value="">— None —</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" rows={4} className="mt-1.5" />
            </div>
            <div className="flex justify-end">
              <Button type="submit">Create deal</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
