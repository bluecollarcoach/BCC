import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listContacts } from "@/server/services/contacts";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Users, Plus, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "CRM · Contacts" };

const STAGE_VARIANT = {
  LEAD: "muted",
  QUALIFIED: "default",
  CUSTOMER: "success",
  CHURNED: "danger",
} as const;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; stage?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/sign-in");
  const sp = await searchParams;

  const contacts = session.user.orgId
    ? await listContacts(session.user.orgId, {
        q: sp.q,
        stage: (sp.stage as "LEAD" | "QUALIFIED" | "CUSTOMER" | "CHURNED" | undefined),
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM"
        description="Contacts, leads, and customers — your book of business."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/crm/deals">View pipeline</Link>
            </Button>
            <Button asChild>
              <Link href="/crm/contacts/new">
                <Plus className="h-4 w-4" /> New contact
              </Link>
            </Button>
          </>
        }
      />

      <form className="flex flex-wrap gap-2" action="/crm">
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm flex-1 min-w-[240px]">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search by name, email, or phone…"
            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        <select
          name="stage"
          defaultValue={sp.stage ?? ""}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="">All stages</option>
          <option value="LEAD">Leads</option>
          <option value="QUALIFIED">Qualified</option>
          <option value="CUSTOMER">Customers</option>
          <option value="CHURNED">Churned</option>
        </select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>

      {contacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No contacts yet"
          description="Add your first contact or import from CSV. Connect a marketing campaign to start filling the funnel."
          action={
            <Button asChild>
              <Link href="/crm/contacts/new">
                <Plus className="h-4 w-4" /> Create contact
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Company</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Contact</th>
                <th className="px-4 py-3 font-semibold">Stage</th>
                <th className="px-4 py-3 font-semibold hidden sm:table-cell">Owner</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link href={`/crm/contacts/${c.id}`} className="flex items-center gap-3 hover:text-gold">
                      <Avatar name={`${c.firstName} ${c.lastName}`} size={28} />
                      <div>
                        <div className="font-medium">{c.firstName} {c.lastName}</div>
                        {c.title && (
                          <div className="text-xs text-muted-foreground">{c.title}</div>
                        )}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-foreground/80">
                    {c.company?.name ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-foreground/80">
                    {c.email && <div className="truncate max-w-[200px]">{c.email}</div>}
                    {c.phone && <div className="text-xs text-muted-foreground">{c.phone}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STAGE_VARIANT[c.stage] ?? "muted"}>{c.stage}</Badge>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-foreground/80">
                    {c.owner?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                    {formatDate(c.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
