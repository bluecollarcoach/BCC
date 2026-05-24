import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  async function create(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const c = await prisma.campaign.create({
      data: {
        orgId: s.user.orgId,
        name: String(fd.get("name") ?? "").trim() || "Untitled campaign",
        channel: String(fd.get("channel") ?? "EMAIL"),
        status: "DRAFT",
        audience: String(fd.get("audience") ?? "").trim() || null,
        subject: String(fd.get("subject") ?? "").trim() || null,
        body: String(fd.get("body") ?? "").trim() || null,
      },
    });
    await audit({
      action: "campaign.create",
      orgId: s.user.orgId,
      actorId: s.user.id,
      targetType: "Campaign",
      targetId: c.id,
    });
    redirect("/marketing");
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="New campaign" description="Email, SMS, social, or review request." />
      <Card>
        <CardContent className="pt-6">
          <form action={create} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="name">Campaign name *</Label>
                <Input id="name" name="name" required placeholder="Spring review push · April" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="channel">Channel</Label>
                <select
                  id="channel"
                  name="channel"
                  defaultValue="EMAIL"
                  className="mt-1.5 flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="EMAIL">Email</option>
                  <option value="SMS">SMS</option>
                  <option value="SOCIAL">Social</option>
                  <option value="PRINT">Print</option>
                  <option value="REVIEW_REQUEST">Review request</option>
                </select>
              </div>
              <div>
                <Label htmlFor="audience">Audience / segment</Label>
                <Input id="audience" name="audience" placeholder="all-customers" className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="subject">Subject</Label>
                <Input id="subject" name="subject" placeholder="(for email / SMS)" className="mt-1.5" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="body">Body</Label>
                <Textarea id="body" name="body" rows={8} className="mt-1.5" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="submit">Save draft</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
