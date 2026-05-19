import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Admin · Settings" };

export default async function AdminSettings() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const org = await prisma.org.findUnique({ where: { id: session.user.orgId } });
  if (!org) redirect("/dashboard");

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await prisma.org.update({
      where: { id: s.user.orgId },
      data: {
        name: String(fd.get("name") ?? org!.name),
        industry: String(fd.get("industry") ?? "") || null,
        size: String(fd.get("size") ?? "") || null,
      },
    });
    revalidatePath("/admin/settings");
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Organization settings" description="Brand, defaults, and policies." />
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={save} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" defaultValue={org.name} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="slug">Slug</Label>
                <Input id="slug" defaultValue={org.slug} disabled className="mt-1.5 opacity-60" />
              </div>
              <div>
                <Label htmlFor="industry">Industry</Label>
                <Input id="industry" name="industry" defaultValue={org.industry ?? ""} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="size">Team size</Label>
                <Input id="size" name="size" defaultValue={org.size ?? ""} className="mt-1.5" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
