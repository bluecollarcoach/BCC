import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createCompany } from "@/server/services/companies";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New company" };

export default async function NewCompanyPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  async function create(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const c = await createCompany(s.user.orgId, s.user.id, {
      name: String(fd.get("name") ?? "").trim() || "Untitled",
      domain: String(fd.get("domain") ?? "").trim() || undefined,
      industry: String(fd.get("industry") ?? "").trim() || undefined,
      size: String(fd.get("size") ?? "").trim() || undefined,
      phone: String(fd.get("phone") ?? "").trim() || undefined,
      website: String(fd.get("website") ?? "").trim() || undefined,
      notes: String(fd.get("notes") ?? "").trim() || undefined,
    });
    redirect(`/crm/companies/${c.id}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="New company" description="Group contacts and deals under one organization." />
      <Card>
        <CardContent className="pt-6">
          <form action={create} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="name">Name *</Label>
                <Input id="name" name="name" required placeholder="Castro Mechanical" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="domain">Domain</Label>
                <Input id="domain" name="domain" placeholder="castromech.com" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="website">Website</Label>
                <Input id="website" name="website" placeholder="https://…" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="industry">Industry</Label>
                <Input id="industry" name="industry" placeholder="HVAC & Plumbing" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="size">Size</Label>
                <Input id="size" name="size" placeholder="12 employees" className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="phone">Main phone</Label>
                <Input id="phone" name="phone" type="tel" className="mt-1.5" />
              </div>
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" rows={4} className="mt-1.5" />
            </div>
            <div className="flex justify-end">
              <Button type="submit">Create company</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
