import { auth } from "@/lib/auth";
import { listContacts } from "@/server/services/contacts";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

function csvEscape(v: string | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const HEADERS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "title",
  "stage",
  "source",
  "tags",
  "company",
  "street",
  "city",
  "state",
  "postalCode",
  "country",
  "region",
  "notes",
  "owner",
  "createdAt",
  "updatedAt",
] as const;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }

  const url = new URL(req.url);
  const contacts = await listContacts(session.user.orgId, {
    q: url.searchParams.get("q") ?? undefined,
    stage: (url.searchParams.get("stage") as "LEAD" | "QUALIFIED" | "CUSTOMER" | "CHURNED" | null) ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    region: url.searchParams.get("region") ?? undefined,
  });

  const lines: string[] = [HEADERS.join(",")];
  for (const c of contacts) {
    lines.push(
      [
        c.firstName,
        c.lastName,
        c.email,
        c.phone,
        c.title,
        c.stage,
        c.source,
        c.tags,
        c.company?.name,
        c.street,
        c.city,
        c.state,
        c.postalCode,
        c.country,
        c.region,
        c.notes,
        c.owner?.name,
        c.createdAt.toISOString(),
        c.updatedAt.toISOString(),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const body = lines.join("\n");
  const filename = `bcc-contacts-${new Date().toISOString().slice(0, 10)}.csv`;

  await audit({
    action: "contacts.export",
    orgId: session.user.orgId,
    actorId: session.user.id,
    diff: { count: contacts.length, filters: Object.fromEntries(url.searchParams) },
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
