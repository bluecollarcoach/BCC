import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getContact, updateContact, deleteContact } from "@/server/services/contacts";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Mail, Phone, Building2, Trash2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";

export const metadata = { title: "Contact" };

export default async function ContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const { id } = await params;

  const contact = await getContact(session.user.orgId, id);
  if (!contact) notFound();

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await updateContact(s.user.orgId, s.user.id, id, {
      firstName: String(fd.get("firstName") ?? ""),
      lastName: String(fd.get("lastName") ?? ""),
      email: String(fd.get("email") ?? "") || undefined,
      phone: String(fd.get("phone") ?? "") || undefined,
      title: String(fd.get("title") ?? "") || undefined,
      stage: String(fd.get("stage") ?? "LEAD") as "LEAD" | "QUALIFIED" | "CUSTOMER" | "CHURNED",
      notes: String(fd.get("notes") ?? "") || undefined,
      street: String(fd.get("street") ?? "") || undefined,
      city: String(fd.get("city") ?? "") || undefined,
      state: String(fd.get("state") ?? "") || undefined,
      postalCode: String(fd.get("postalCode") ?? "") || undefined,
      country: String(fd.get("country") ?? "") || undefined,
      region: String(fd.get("region") ?? "") || undefined,
    });
  }

  async function remove() {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await deleteContact(s.user.orgId, s.user.id, id);
    redirect("/crm");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${contact.firstName} ${contact.lastName}`}
        description={contact.title ?? "Contact details"}
        actions={
          <>
            <form action={remove}>
              <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </form>
            <Button asChild variant="outline">
              <Link href="/crm">← All contacts</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-start gap-4">
              <Avatar name={`${contact.firstName} ${contact.lastName}`} size={56} />
              <div className="flex-1">
                <CardTitle>{contact.firstName} {contact.lastName}</CardTitle>
                <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <Badge>{contact.stage}</Badge>
                  {contact.source && <span>· {contact.source}</span>}
                </div>
                <div className="mt-2 grid gap-1 text-sm">
                  {contact.email && (
                    <div className="flex items-center gap-2 text-foreground/80">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {contact.email}
                    </div>
                  )}
                  {contact.phone && (
                    <div className="flex items-center gap-2 text-foreground/80">
                      <Phone className="h-3.5 w-3.5 text-muted-foreground" /> {contact.phone}
                    </div>
                  )}
                  {contact.company && (
                    <div className="flex items-center gap-2 text-foreground/80">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" /> {contact.company.name}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form action={save} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">First name</Label>
                  <Input id="firstName" name="firstName" defaultValue={contact.firstName} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="lastName">Last name</Label>
                  <Input id="lastName" name="lastName" defaultValue={contact.lastName} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" defaultValue={contact.email ?? ""} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" name="phone" defaultValue={contact.phone ?? ""} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="title">Title</Label>
                  <Input id="title" name="title" defaultValue={contact.title ?? ""} className="mt-1.5" />
                </div>
                <div>
                  <Label htmlFor="stage">Stage</Label>
                  <select
                    id="stage"
                    name="stage"
                    defaultValue={contact.stage}
                    className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="LEAD">Lead</option>
                    <option value="QUALIFIED">Qualified</option>
                    <option value="CUSTOMER">Customer</option>
                    <option value="CHURNED">Churned</option>
                  </select>
                </div>
              </div>
              <div className="pt-2 border-t border-border">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">
                  Address
                </div>
                <div className="grid gap-3 sm:grid-cols-6">
                  <div className="sm:col-span-6">
                    <Label htmlFor="street">Street</Label>
                    <Input id="street" name="street" defaultValue={contact.street ?? ""} className="mt-1.5" />
                  </div>
                  <div className="sm:col-span-3">
                    <Label htmlFor="city">City</Label>
                    <Input id="city" name="city" defaultValue={contact.city ?? ""} className="mt-1.5" />
                  </div>
                  <div className="sm:col-span-1">
                    <Label htmlFor="state">State</Label>
                    <Input id="state" name="state" defaultValue={contact.state ?? ""} placeholder="AZ" className="mt-1.5" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor="postalCode">Postal</Label>
                    <Input id="postalCode" name="postalCode" defaultValue={contact.postalCode ?? ""} className="mt-1.5" />
                  </div>
                  <div className="sm:col-span-3">
                    <Label htmlFor="country">Country</Label>
                    <Input id="country" name="country" defaultValue={contact.country ?? ""} className="mt-1.5" />
                  </div>
                  <div className="sm:col-span-3">
                    <Label htmlFor="region">Region</Label>
                    <Input id="region" name="region" defaultValue={contact.region ?? ""} placeholder="Southwest" className="mt-1.5" />
                  </div>
                </div>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" name="notes" rows={5} defaultValue={contact.notes ?? ""} className="mt-1.5" />
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
              <CardTitle>Open deals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {contact.deals.length === 0 && (
                <p className="text-muted-foreground">No deals yet.</p>
              )}
              {contact.deals.map((d) => (
                <Link
                  key={d.id}
                  href="/crm/deals"
                  className="flex items-center justify-between rounded-md border border-border p-3 hover:border-gold/40"
                >
                  <div>
                    <div className="font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground">{d.stage.name}</div>
                  </div>
                  <div className="font-semibold tabular-nums">
                    {formatCurrency(d.amountCents)}
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {contact.activities.length === 0 && (
                <p className="text-muted-foreground">No activity yet.</p>
              )}
              {contact.activities.map((a) => (
                <div key={a.id} className="border-l-2 border-gold/40 pl-3">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    {a.type} · {formatDate(a.createdAt, { dateStyle: "short", timeStyle: "short" })}
                  </div>
                  <div className="font-medium">{a.subject}</div>
                  {a.body && <p className="text-muted-foreground text-xs mt-1">{a.body}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
