import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { audit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/utils";
import { ROLES, type Role } from "@/types/enums";

export const metadata = { title: "Admin · Users" };

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const users = await prisma.user.findMany({
    where: { orgId: session.user.orgId },
    orderBy: { createdAt: "asc" },
  });

  async function setRole(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const targetId = String(fd.get("userId"));
    const role = String(fd.get("role")) as Role;
    await prisma.user.update({ where: { id: targetId }, data: { role } });
    await audit({
      action: "user.role.update",
      actorId: s.user.id,
      orgId: s.user.orgId,
      targetType: "User",
      targetId,
      diff: { role },
    });
    revalidatePath("/admin/users");
  }

  async function setActive(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const targetId = String(fd.get("userId"));
    const active = fd.get("active") === "true";
    await prisma.user.update({ where: { id: targetId }, data: { active } });
    await audit({
      action: active ? "user.activate" : "user.deactivate",
      actorId: s.user.id,
      orgId: s.user.orgId,
      targetType: "User",
      targetId,
    });
    revalidatePath("/admin/users");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & Roles"
        description="Manage workspace members and their access level."
      />

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">User</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Title</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 flex items-center gap-3">
                    <Avatar name={u.name} src={u.image} size={32} />
                    <div>
                      <div className="font-medium">{u.name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">{u.title ?? "—"}</td>
                  <td className="px-4 py-3">
                    <form action={setRole} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={u.id} />
                      <select
                        name="role"
                        defaultValue={u.role}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                      <Button type="submit" size="sm" variant="ghost">Save</Button>
                    </form>
                  </td>
                  <td className="px-4 py-3">
                    <form action={setActive} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="active" value={(!u.active).toString()} />
                      <Badge variant={u.active ? "success" : "muted"}>
                        {u.active ? "Active" : "Disabled"}
                      </Badge>
                      <Button type="submit" size="sm" variant="ghost">
                        {u.active ? "Disable" : "Enable"}
                      </Button>
                    </form>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                    {formatDate(u.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
