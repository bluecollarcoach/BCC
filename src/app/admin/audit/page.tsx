import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatDate, relativeTime } from "@/lib/utils";

export const metadata = { title: "Admin · Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; action?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;

  const entries = await prisma.auditLog.findMany({
    where: {
      orgId: session.user.orgId,
      ...(sp.action ? { action: { contains: sp.action } } : {}),
    },
    include: { actor: { select: { id: true, name: true, image: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every privileged action, with actor and target. Retained per Azure log policy."
      />

      <form className="flex gap-2" action="/admin/audit">
        <input
          name="action"
          defaultValue={sp.action ?? ""}
          placeholder="Filter by action (e.g. contact, deal, time)"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md border border-gold/40 px-3 text-xs font-bold uppercase tracking-wider text-gold"
        >
          Filter
        </button>
      </form>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Actor</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Target</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">IP</th>
                <th className="px-4 py-3 font-semibold">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    No audit events. Try doing something.
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3 flex items-center gap-2">
                    <Avatar
                      name={e.actor?.name ?? e.actor?.email ?? "System"}
                      src={e.actor?.image}
                      size={24}
                    />
                    <div className="text-xs">
                      <div>{e.actor?.name ?? "System"}</div>
                      <div className="text-muted-foreground">{e.actor?.email ?? ""}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">{e.action}</Badge>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                    {e.targetType ? `${e.targetType} / ${e.targetId?.slice(0, 8)}…` : "—"}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                    {e.ip ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div>{relativeTime(e.createdAt)}</div>
                    <div className="text-muted-foreground">{formatDate(e.createdAt, { dateStyle: "short", timeStyle: "short" })}</div>
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
