import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listContacts, listRegionsAndStates } from "@/server/services/contacts";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { Users, Plus, Search, Upload, MapPin, Download, Building2 } from "lucide-react";
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
  searchParams: Promise<{ q?: string; stage?: string; state?: string; region?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;

  const [contacts, { regions, states }] = await Promise.all([
    listContacts(session.user.orgId, {
      q: sp.q,
      stage: sp.stage as "LEAD" | "QUALIFIED" | "CUSTOMER" | "CHURNED" | undefined,
      state: sp.state,
      region: sp.region,
    }),
    listRegionsAndStates(session.user.orgId),
  ]);

  const activeFilters = [sp.q, sp.stage, sp.state, sp.region].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="CRM"
        description={`${contacts.length} contact${contacts.length === 1 ? "" : "s"}${
          activeFilters ? ` · ${activeFilters} filter${activeFilters === 1 ? "" : "s"} active` : ""
        }`}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/crm/companies">
                <Building2 className="h-4 w-4" /> Companies
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/api/crm/contacts/export?${new URLSearchParams(
                Object.fromEntries(Object.entries(sp).filter(([, v]) => v))
              ).toString()}`}>
                <Download className="h-4 w-4" /> Export CSV
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/crm/contacts/import">
                <Upload className="h-4 w-4" /> Import CSV
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/crm/deals">Pipeline</Link>
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
            placeholder="Search name, email, phone, city…"
            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </div>
        <select
          name="stage"
          defaultValue={sp.stage ?? ""}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
          aria-label="Stage"
        >
          <option value="">All stages</option>
          <option value="LEAD">Leads</option>
          <option value="QUALIFIED">Qualified</option>
          <option value="CUSTOMER">Customers</option>
          <option value="CHURNED">Churned</option>
        </select>
        <select
          name="region"
          defaultValue={sp.region ?? ""}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
          aria-label="Region"
        >
          <option value="">All regions</option>
          {regions.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select
          name="state"
          defaultValue={sp.state ?? ""}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
          aria-label="State"
        >
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <Button type="submit" variant="secondary">Filter</Button>
        {activeFilters > 0 && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/crm">Clear</Link>
          </Button>
        )}
      </form>

      {contacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title={activeFilters > 0 ? "No matches" : "No contacts yet"}
          description={
            activeFilters > 0
              ? "Try clearing some filters or broadening your search."
              : "Add your first contact one at a time, or bulk-import from CSV."
          }
          action={
            activeFilters > 0 ? (
              <Button asChild variant="outline">
                <Link href="/crm">Clear filters</Link>
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button asChild variant="outline">
                  <Link href="/crm/contacts/import">
                    <Upload className="h-4 w-4" /> Import CSV
                  </Link>
                </Button>
                <Button asChild>
                  <Link href="/crm/contacts/new">
                    <Plus className="h-4 w-4" /> New contact
                  </Link>
                </Button>
              </div>
            )
          }
        />
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold hidden md:table-cell">Company</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Contact</th>
                <th className="px-4 py-3 font-semibold hidden xl:table-cell">Location</th>
                <th className="px-4 py-3 font-semibold">Stage</th>
                <th className="px-4 py-3 font-semibold hidden sm:table-cell">Owner</th>
                <th className="px-4 py-3 font-semibold hidden lg:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contacts.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link
                      href={`/crm/contacts/${c.id}`}
                      className="flex items-center gap-3 hover:text-amber-700"
                    >
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
                  <td className="px-4 py-3 hidden xl:table-cell text-foreground/80">
                    {(c.city || c.state) ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <MapPin className="h-3 w-3 text-muted-foreground" />
                        {[c.city, c.state].filter(Boolean).join(", ")}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STAGE_VARIANT[c.stage as keyof typeof STAGE_VARIANT] ?? "muted"}>
                      {c.stage}
                    </Badge>
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
