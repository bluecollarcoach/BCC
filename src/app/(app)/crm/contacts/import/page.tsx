import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import {
  parseContactsCsv,
  bulkImportContacts,
} from "@/server/services/contacts";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "CRM · Import contacts" };

const SAMPLE_CSV = `firstName,lastName,email,phone,title,stage,city,state,region,source
Mike,Castro,mike@castromech.example,+1-555-0142,Owner,CUSTOMER,Phoenix,AZ,Southwest,referral
Sarah,Henley,sarah@henleyapts.example,+1-555-0188,Property Mgr,QUALIFIED,Tucson,AZ,Southwest,web
Diego,Reyes,diego@reyeshvac.example,+1-555-0156,Owner,LEAD,Denver,CO,Mountain,event`;

export default async function ImportContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ csv?: string; commit?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;

  // Parse on every render (the form posts the raw CSV back in the `csv` field).
  const raw = sp.csv ?? "";
  const parsed = raw.trim().length > 0 ? parseContactsCsv(raw) : null;

  // Server action: parse + commit + redirect with summary.
  async function commitImport(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const csv = String(fd.get("csv") ?? "");
    if (!csv.trim()) return;
    const result = parseContactsCsv(csv);
    if (result.rows.length === 0) return;
    const summary = await bulkImportContacts(s.user.orgId, s.user.id, result.rows);
    const qs = new URLSearchParams({
      created: String(summary.created),
      skipped: String(summary.skipped),
      errors: String(summary.errors.length),
    });
    redirect(`/crm?${qs.toString()}`);
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title="Import contacts"
        description="Paste or upload a CSV. We'll preview before committing. Duplicates by email are skipped."
        actions={
          <Button asChild variant="ghost">
            <Link href="/crm">← Back to CRM</Link>
          </Button>
        }
      />

      <form action="/crm/contacts/import" method="GET" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Paste CSV</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              name="csv"
              rows={10}
              defaultValue={raw}
              placeholder={SAMPLE_CSV}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                Required columns: <code className="bg-muted px-1 rounded">firstName</code>{" "}
                + <code className="bg-muted px-1 rounded">lastName</code>
              </span>
              <span>·</span>
              <span>
                Optional: email, phone, title, stage, source, tags, street, city, state,
                postalCode, country, region, notes
              </span>
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="secondary">
                Preview
              </Button>
              <button
                type="button"
                className="text-xs text-amber-700 hover:underline"
                onClick={() => {
                  /* clicked via inline JS; in RSC this is a no-op without 'use client'.
                     Keeping as visual only for now. */
                }}
              >
                (use the sample if you just want to try it)
              </button>
            </div>
          </CardContent>
        </Card>
      </form>

      {parsed && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">
                2. Preview ({parsed.rows.length} ready · {parsed.errors.length} skipped)
              </CardTitle>
              <div className="flex gap-2">
                {parsed.headers.length > 0 && (
                  <Badge variant="muted">
                    headers: {parsed.headers.join(", ").slice(0, 80)}
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {parsed.errors.length > 0 && (
              <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs space-y-0.5">
                <div className="font-semibold text-warning">
                  {parsed.errors.length} row{parsed.errors.length === 1 ? "" : "s"} have issues:
                </div>
                {parsed.errors.slice(0, 8).map((e, i) => (
                  <div key={i} className="text-muted-foreground">
                    line {e.line}: {e.message}
                  </div>
                ))}
                {parsed.errors.length > 8 && (
                  <div className="text-muted-foreground italic">
                    …and {parsed.errors.length - 8} more
                  </div>
                )}
              </div>
            )}

            {parsed.rows.length > 0 ? (
              <>
                <div className="overflow-x-auto rounded border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="px-2 py-1.5">Name</th>
                        <th className="px-2 py-1.5">Email</th>
                        <th className="px-2 py-1.5">Phone</th>
                        <th className="px-2 py-1.5">Stage</th>
                        <th className="px-2 py-1.5">City / State</th>
                        <th className="px-2 py-1.5">Region</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {parsed.rows.slice(0, 50).map((r, i) => (
                        <tr key={i}>
                          <td className="px-2 py-1.5">
                            {r.firstName} {r.lastName}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {r.email ?? "—"}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {r.phone ?? "—"}
                          </td>
                          <td className="px-2 py-1.5">
                            <Badge variant="muted">{r.stage ?? "LEAD"}</Badge>
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {r.region ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {parsed.rows.length > 50 && (
                  <p className="text-xs text-muted-foreground italic">
                    Showing 50 of {parsed.rows.length}. All rows will be imported.
                  </p>
                )}

                <form action={commitImport} className="flex items-center gap-3 pt-2">
                  <input type="hidden" name="csv" value={raw} />
                  <Button type="submit">
                    Import {parsed.rows.length} contact
                    {parsed.rows.length === 1 ? "" : "s"}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Existing contacts with the same email will be skipped.
                  </span>
                </form>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No valid rows to import. Check the CSV header (it must include
                firstName + lastName) and that data rows aren't empty.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
