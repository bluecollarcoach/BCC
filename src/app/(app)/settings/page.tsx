import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/sign-in");

  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  if (!user) redirect("/sign-in");

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user) return;
    await prisma.user.update({
      where: { id: s.user.id },
      data: {
        name: String(fd.get("name") ?? "").trim() || null,
        phone: String(fd.get("phone") ?? "").trim() || null,
        title: String(fd.get("title") ?? "").trim() || null,
      },
    });
    revalidatePath("/settings");
  }

  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/" });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="Settings" description="Manage your profile and account." />

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={save} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" defaultValue={user.name ?? ""} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" defaultValue={user.email} disabled className="mt-1.5 opacity-60" />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" name="phone" defaultValue={user.phone ?? ""} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="title">Title</Label>
                <Input id="title" name="title" defaultValue={user.title ?? ""} className="mt-1.5" />
              </div>
              <div>
                <Label>Role</Label>
                <Input defaultValue={user.role} disabled className="mt-1.5 opacity-60" />
              </div>
              <div>
                <Label>Hourly rate</Label>
                <Input
                  defaultValue={user.hourlyRate ? `$${(user.hourlyRate / 100).toFixed(2)}` : "—"}
                  disabled
                  className="mt-1.5 opacity-60"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit">Save profile</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={doSignOut}>
            <Button type="submit" variant="destructive">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
