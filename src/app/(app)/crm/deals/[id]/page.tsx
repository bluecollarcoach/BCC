import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getDeal,
  updateDeal,
  deleteDeal,
  listContactsForOrg,
  listCompaniesForOrg,
} from "@/server/services/deals";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2, Building2, User as UserIcon } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";

export const metadata = { title: "Deal" };

const STATUS_VARIANT = {
  OPEN: "default",
  WON: "success",
  LOST: "danger",
} as const;

export default async function DealDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const { id } = await params;

  const [deal, contacts, companies] = await Promise.all([
    getDeal(session.user.orgId, id),
    listContactsForOrg(session.user.orgId),
    listCompaniesForOrg(session.user.orgId),
  ]);
  if (!deal) notFound();

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const amountDollars = Number(fd.get("amount") ?? 0);
    await updateDeal(s.user.orgId, s.user.id, id, {
      name: String(fd.get("name") ?? "").trim(),
      amountCents: Math.max(0, Math.round(amountDollars * 100)),
      status: String(fd.get("status") ?? "OPEN") as "OPEN" | "WON" | "LOST",
      stageId: String(fd.get("stageId") ?? "") || undefined,
      contactId: String(fd.get("contactId") ?? "") || undefined,
      companyId: String(fd.get("companyId") ?? "") || undefined,
      expectedClose: String(fd.get("expectedClose") ?? "") || undefined,
      notes: String(fd.get("notes") ?? "") || undefined,
    });
  }

  async function remove() {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await deleteDeal(s.user.orgId, s.user.id, id);
    redirect("/crm/deals");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={deal.name}
        description={`${formatCurrency(deal.amountCents)} · ${deal.stage.name}`}
        actions={
          <>
            <Badge variant={STATUS_VARIANT[deal.status as keyof typeof STATUS_VARIANT] ?? "muted"}>
              {deal.status}
            </Badge>
            <form action={remove}>
              <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </form>
            <Button asChild variant="outline">
              <Link href="/crm/deals">← Pipeline</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Deal details</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" defaultValue={deal.name} required className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="amount">Amount (USD)</Label>
                  <Input
                    id="amount"
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={(deal.amountCents / 100).toFixed(2)}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="expectedClose">Expected close</Label>
                  <Input
                    id="expectedClose"
                    name="expectedClose"
                    type="date"
                    defaultValue={
                      deal.expectedClose
                        ? deal.expectedClose.toISOString().slice(0, 10)
                        : ""
                    }
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="stageId">Stage</Label>
                  <select
                    id="stageId"
                    name="stageId"
                    defaultValue={deal.stageId}
                    className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {deal.pipeline.stages.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <select
                    id="status"
                    name="status"
                    defaultValue={deal.status}
                    className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="OPEN">Open</option>
                    <option value="WON">Won</option>
                    <option value="LOST">Lost</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="contactId">Contact</Label>
                  <select
                    id="contactId"
                    name="contactId"
                    defaultValue={deal.contactId ?? ""}
                    className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">— None —</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.firstName} {c.lastName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="companyId">Company</Label>
                  <select
                    id="companyId"
                    name="companyId"
                    defaultValue={deal.companyId ?? ""}
                    className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">— None —</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" name="notes" rows={5} defaultValue={deal.notes ?? ""} className="mt-1.5" />
              </div>
              <div className="flex justify-end">
                <Button type="submit">Save changes</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Linked records</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {deal.contact ? (
                <Link
                  href={`/crm/contacts/${deal.contact.id}`}
                  className="flex items-center gap-3 rounded-md border border-border p-2 hover:border-amber/40"
                >
                  <UserIcon className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1">
                    <div>{deal.contact.firstName} {deal.contact.lastName}</div>
                    {deal.contact.email && (
                      <div className="text-xs text-muted-foreground truncate">{deal.contact.email}</div>
                    )}
                  </div>
                </Link>
              ) : (
                <p className="text-muted-foreground text-xs">No contact linked.</p>
              )}
              {deal.company ? (
                <Link
                  href={`/crm/companies/${deal.company.id}`}
                  className="flex items-center gap-3 rounded-md border border-border p-2 hover:border-amber/40"
                >
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1">
                    <div>{deal.company.name}</div>
                    {deal.company.industry && (
                      <div className="text-xs text-muted-foreground">{deal.company.industry}</div>
                    )}
                  </div>
                </Link>
              ) : (
                <p className="text-muted-foreground text-xs">No company linked.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {deal.activities.length === 0 ? (
                <p className="text-muted-foreground text-xs">No activity yet.</p>
              ) : (
                deal.activities.map((a) => (
                  <div key={a.id} className="border-l-2 border-amber/40 pl-3">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                      {a.type} · {formatDate(a.createdAt, { dateStyle: "short", timeStyle: "short" })}
                    </div>
                    <div className="font-medium">{a.subject}</div>
                    {a.body && <p className="text-xs text-muted-foreground mt-1">{a.body}</p>}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
