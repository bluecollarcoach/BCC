import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCompany, updateCompany, deleteCompany } from "@/server/services/companies";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Building2, Trash2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

export const metadata = { title: "Company" };

const STAGE_VARIANT = {
  LEAD: "muted",
  QUALIFIED: "default",
  CUSTOMER: "success",
  CHURNED: "danger",
} as const;

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const { id } = await params;
  const company = await getCompany(session.user.orgId, id);
  if (!company) notFound();

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await updateCompany(s.user.orgId, s.user.id, id, {
      name: String(fd.get("name") ?? "").trim(),
      domain: String(fd.get("domain") ?? "").trim() || undefined,
      industry: String(fd.get("industry") ?? "").trim() || undefined,
      size: String(fd.get("size") ?? "").trim() || undefined,
      phone: String(fd.get("phone") ?? "").trim() || undefined,
      website: String(fd.get("website") ?? "").trim() || undefined,
      notes: String(fd.get("notes") ?? "").trim() || undefined,
    });
  }

  async function remove() {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await deleteCompany(s.user.orgId, s.user.id, id);
    redirect("/crm/companies");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={company.name}
        description={[company.industry, company.size].filter(Boolean).join(" · ") || "Company"}
        actions={
          <>
            <form action={remove}>
              <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </form>
            <Button asChild variant="outline">
              <Link href="/crm/companies">← All companies</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-md bg-muted ring-1 ring-border">
                <Building2 className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <CardTitle>{company.name}</CardTitle>
                {company.website && (
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-amber-700 hover:underline"
                  >
                    {company.website}
                  </a>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form action={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" defaultValue={company.name} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="domain">Domain</Label>
                  <Input id="domain" name="domain" defaultValue={company.domain ?? ""} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="website">Website</Label>
                  <Input id="website" name="website" defaultValue={company.website ?? ""} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="industry">Industry</Label>
                  <Input id="industry" name="industry" defaultValue={company.industry ?? ""} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="size">Size</Label>
                  <Input id="size" name="size" defaultValue={company.size ?? ""} className="mt-1.5" />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="phone">Main phone</Label>
                  <Input id="phone" name="phone" type="tel" defaultValue={company.phone ?? ""} className="mt-1.5" />
                </div>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" name="notes" rows={5} defaultValue={company.notes ?? ""} className="mt-1.5" />
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
              <CardTitle className="text-base">Contacts ({company.contacts.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {company.contacts.length === 0 && (
                <p className="text-sm text-muted-foreground">No contacts yet.</p>
              )}
              {company.contacts.slice(0, 10).map((c) => (
                <Link
                  key={c.id}
                  href={`/crm/contacts/${c.id}`}
                  className="flex items-center gap-2 rounded-md border border-border p-2 hover:border-amber/40 text-sm"
                >
                  <Avatar name={`${c.firstName} ${c.lastName}`} size={24} />
                  <div className="flex-1">
                    <div>{c.firstName} {c.lastName}</div>
                    {c.title && (
                      <div className="text-xs text-muted-foreground">{c.title}</div>
                    )}
                  </div>
                  <Badge variant={STAGE_VARIANT[c.stage as keyof typeof STAGE_VARIANT] ?? "muted"}>
                    {c.stage}
                  </Badge>
                </Link>
              ))}
              {company.contacts.length > 10 && (
                <p className="text-xs text-muted-foreground italic">
                  …and {company.contacts.length - 10} more
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deals ({company.deals.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {company.deals.length === 0 && (
                <p className="text-sm text-muted-foreground">No deals yet.</p>
              )}
              {company.deals.slice(0, 10).map((d) => (
                <Link
                  key={d.id}
                  href={`/crm/deals/${d.id}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-border p-2 hover:border-amber/40 text-sm"
                >
                  <div>
                    <div className="font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground">{d.stage.name}</div>
                  </div>
                  <div className="font-semibold tabular-nums text-amber-700">
                    {formatCurrency(d.amountCents)}
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
