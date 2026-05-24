import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createContact } from "@/server/services/contacts";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New contact" };

export default async function NewContactPage() {
  const session = await auth();
  if (!session?.user || !session.user.orgId) redirect("/sign-in");

  async function create(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const contact = await createContact(s.user.orgId, s.user.id, {
      firstName: String(fd.get("firstName") ?? ""),
      lastName: String(fd.get("lastName") ?? ""),
      email: String(fd.get("email") ?? "") || undefined,
      phone: String(fd.get("phone") ?? "") || undefined,
      title: String(fd.get("title") ?? "") || undefined,
      stage: String(fd.get("stage") ?? "LEAD") as "LEAD" | "QUALIFIED" | "CUSTOMER" | "CHURNED",
      source: String(fd.get("source") ?? "") || undefined,
      tags: String(fd.get("tags") ?? "") || undefined,
      notes: String(fd.get("notes") ?? "") || undefined,
      street: String(fd.get("street") ?? "") || undefined,
      city: String(fd.get("city") ?? "") || undefined,
      state: String(fd.get("state") ?? "") || undefined,
      postalCode: String(fd.get("postalCode") ?? "") || undefined,
      country: String(fd.get("country") ?? "") || undefined,
      region: String(fd.get("region") ?? "") || undefined,
    });
    redirect(`/crm/contacts/${contact.id}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="New contact" description="Add a lead, prospect, or customer." />

      <form action={create} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="firstName">First name *</Label>
                <Input id="firstName" name="firstName" required className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="lastName">Last name *</Label>
                <Input id="lastName" name="lastName" required className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" name="phone" type="tel" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="title">Title</Label>
                <Input id="title" name="title" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="stage">Stage</Label>
                <select
                  id="stage"
                  name="stage"
                  defaultValue="LEAD"
                  className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="LEAD">Lead</option>
                  <option value="QUALIFIED">Qualified</option>
                  <option value="CUSTOMER">Customer</option>
                  <option value="CHURNED">Churned</option>
                </select>
              </div>
              <div>
                <Label htmlFor="source">Source</Label>
                <Input id="source" name="source" placeholder="referral, web, event…" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="tags">Tags (comma separated)</Label>
                <Input id="tags" name="tags" placeholder="hvac, residential" className="mt-1.5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Address</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-6">
              <div className="sm:col-span-6">
                <Label htmlFor="street">Street</Label>
                <Input id="street" name="street" placeholder="2412 Elm St" className="mt-1.5" />
              </div>
              <div className="sm:col-span-3">
                <Label htmlFor="city">City</Label>
                <Input id="city" name="city" className="mt-1.5" />
              </div>
              <div className="sm:col-span-1">
                <Label htmlFor="state">State</Label>
                <Input id="state" name="state" placeholder="AZ" className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="postalCode">Postal code</Label>
                <Input id="postalCode" name="postalCode" className="mt-1.5" />
              </div>
              <div className="sm:col-span-3">
                <Label htmlFor="country">Country</Label>
                <Input id="country" name="country" placeholder="US" className="mt-1.5" />
              </div>
              <div className="sm:col-span-3">
                <Label htmlFor="region">Region / territory</Label>
                <Input id="region" name="region" placeholder="Southwest" className="mt-1.5" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea id="notes" name="notes" rows={5} placeholder="Anything worth remembering…" />
          </CardContent>
        </Card>

        <div className="flex gap-2 justify-end">
          <Button type="reset" variant="ghost">Reset</Button>
          <Button type="submit">Create contact</Button>
        </div>
      </form>
    </div>
  );
}
