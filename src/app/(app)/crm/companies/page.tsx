import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listCompanies } from "@/server/services/companies";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Building2, Plus, Search } from "lucide-react";

export const metadata = { title: "CRM · Companies" };

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;
  const companies = await listCompanies(session.user.orgId, { q: sp.q });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Companies"
        description={`${companies.length} compan${companies.length === 1 ? "y" : "ies"}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/crm">← Contacts</Link>
            </Button>
            <Button asChild>
              <Link href="/crm/companies/new">
                <Plus className="h-4 w-4" /> New company
              </Link>
            </Button>
          </>
        }
      />

      <form className="flex flex-wrap gap-2" action="/crm/companies">
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm flex-1 min-w-[240px]">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search by name, domain, or industry…"
            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Button type="submit" variant="secondary">Filter</Button>
        {sp.q && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/crm/companies">Clear</Link>
          </Button>
        )}
      </form>

      {companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={sp.q ? "No matches" : "No companies yet"}
          description={
            sp.q
              ? "Try a different search."
              : "Add a company to group contacts and deals under one umbrella."
          }
          action={
            <Button asChild>
              <Link href="/crm/companies/new">
                <Plus className="h-4 w-4" /> Add company
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Industry</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Domain</th>
                <th className="px-4 py-3 font-semibold hidden sm:table-cell text-right">Contacts</th>
                <th className="px-4 py-3 font-semibold hidden sm:table-cell text-right">Deals</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {companies.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link
                      href={`/crm/companies/${c.id}`}
                      className="flex items-center gap-3 hover:text-amber-700"
                    >
                      <div className="grid h-8 w-8 place-items-center rounded-md bg-muted ring-1 ring-border">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="font-medium">{c.name}</div>
                        {c.size && (
                          <div className="text-xs text-muted-foreground">{c.size}</div>
                        )}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-foreground/80">
                    {c.industry ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground">
                    {c.domain ?? "—"}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-right tabular-nums">
                    {c._count.contacts}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-right tabular-nums">
                    {c._count.deals}
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
