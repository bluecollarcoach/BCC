import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";
import type { ContactStage } from "@/types/enums";

export const contactSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().max(40).optional(),
  title: z.string().max(120).optional(),
  stage: z.enum(["LEAD", "QUALIFIED", "CUSTOMER", "CHURNED"]).default("LEAD"),
  source: z.string().max(80).optional(),
  tags: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
  companyId: z.string().optional(),
  street: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(60).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(60).optional(),
  region: z.string().max(60).optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;

export async function listContacts(
  orgId: string,
  opts?: {
    q?: string;
    stage?: ContactStage;
    state?: string;
    region?: string;
  },
) {
  return prisma.contact.findMany({
    where: {
      orgId,
      ...(opts?.stage ? { stage: opts.stage } : {}),
      ...(opts?.state ? { state: opts.state } : {}),
      ...(opts?.region ? { region: opts.region } : {}),
      ...(opts?.q
        ? {
            OR: [
              { firstName: { contains: opts.q } },
              { lastName: { contains: opts.q } },
              { email: { contains: opts.q } },
              { phone: { contains: opts.q } },
              { city: { contains: opts.q } },
            ],
          }
        : {}),
    },
    include: {
      company: true,
      owner: { select: { id: true, name: true, email: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });
}

export async function listRegionsAndStates(orgId: string) {
  const rows = await prisma.contact.findMany({
    where: { orgId },
    select: { region: true, state: true },
  });
  const regions = Array.from(
    new Set(rows.map((r) => r.region).filter((v): v is string => !!v)),
  );
  const states = Array.from(
    new Set(rows.map((r) => r.state).filter((v): v is string => !!v)),
  );
  return { regions: regions.sort(), states: states.sort() };
}

export async function getContact(orgId: string, id: string) {
  return prisma.contact.findFirst({
    where: { id, orgId },
    include: {
      company: true,
      owner: true,
      deals: { include: { stage: true } },
      activities: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
}

export async function createContact(
  orgId: string,
  actorId: string,
  input: ContactInput,
) {
  const data = contactSchema.parse(input);
  const contact = await prisma.contact.create({
    data: { ...data, orgId, ownerId: actorId },
  });
  await audit({
    action: "contact.create",
    actorId,
    orgId,
    targetType: "Contact",
    targetId: contact.id,
    diff: data,
  });
  return contact;
}

export async function updateContact(
  orgId: string,
  actorId: string,
  id: string,
  input: Partial<ContactInput>,
) {
  const data = contactSchema.partial().parse(input);
  const contact = await prisma.contact.update({
    where: { id, orgId },
    data,
  });
  await audit({
    action: "contact.update",
    actorId,
    orgId,
    targetType: "Contact",
    targetId: id,
    diff: data,
  });
  return contact;
}

export async function deleteContact(orgId: string, actorId: string, id: string) {
  await prisma.contact.delete({ where: { id, orgId } });
  await audit({
    action: "contact.delete",
    actorId,
    orgId,
    targetType: "Contact",
    targetId: id,
  });
}

/* ---------- Bulk CSV import ---------- */

export interface CsvRow {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  title?: string;
  stage?: string;
  source?: string;
  tags?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  region?: string;
  notes?: string;
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: Array<{ line: number; message: string }>;
  headers: string[];
}

/**
 * Lightweight RFC-4180-ish CSV parser. Handles quoted fields with embedded
 * commas + doubled-quote escapes. Skips blank lines. Maps header columns
 * (case-insensitive, alias-aware) to ContactInput fields.
 */
export function parseContactsCsv(raw: string): CsvParseResult {
  const errors: { line: number; message: string }[] = [];
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], errors: [{ line: 0, message: "Empty CSV" }], headers: [] };
  }

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') {
          q = false;
        } else {
          cur += c;
        }
      } else {
        if (c === '"') q = true;
        else if (c === ",") {
          out.push(cur);
          cur = "";
        } else {
          cur += c;
        }
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const headerRow = parseLine(lines[0]).map((h) =>
    h.toLowerCase().replace(/[^a-z0-9]/g, ""),
  );
  const aliases: Record<string, keyof CsvRow> = {
    firstname: "firstName", first: "firstName", fname: "firstName",
    lastname: "lastName", last: "lastName", lname: "lastName", surname: "lastName",
    email: "email", emailaddress: "email", mail: "email",
    phone: "phone", phonenumber: "phone", mobile: "phone", cell: "phone",
    title: "title", jobtitle: "title", position: "title",
    stage: "stage", status: "stage",
    source: "source", leadsource: "source", channel: "source",
    tags: "tags", labels: "tags",
    street: "street", address: "street", address1: "street", streetaddress: "street",
    city: "city", town: "city",
    state: "state", province: "state",
    region: "region", territory: "region",
    postalcode: "postalCode", zip: "postalCode", zipcode: "postalCode", postcode: "postalCode",
    country: "country",
    notes: "notes", note: "notes", comments: "notes",
  };
  const fields = headerRow.map((h) => aliases[h] ?? null);

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row: Partial<Record<keyof CsvRow, string>> = {};
    for (let j = 0; j < cells.length && j < fields.length; j++) {
      const key = fields[j];
      if (!key) continue;
      const val = cells[j];
      if (val) (row as Record<string, string>)[key] = val;
    }
    if (!row.firstName || !row.lastName) {
      errors.push({ line: i + 1, message: "Missing firstName or lastName" });
      continue;
    }
    rows.push(row as CsvRow);
  }
  return { rows, errors, headers: headerRow };
}

export async function bulkImportContacts(
  orgId: string,
  actorId: string,
  rows: CsvRow[],
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  // Dedup against existing contacts by email (case-insensitive).
  const existingEmails = new Set(
    (
      await prisma.contact.findMany({
        where: { orgId, email: { not: null } },
        select: { email: true },
      })
    )
      .map((c) => c.email?.toLowerCase())
      .filter((v): v is string => !!v),
  );

  for (const r of rows) {
    if (r.email && existingEmails.has(r.email.toLowerCase())) {
      skipped++;
      continue;
    }
    try {
      const validStage =
        r.stage &&
        ["LEAD", "QUALIFIED", "CUSTOMER", "CHURNED"].includes(r.stage.toUpperCase())
          ? r.stage.toUpperCase()
          : "LEAD";
      await prisma.contact.create({
        data: {
          orgId,
          ownerId: actorId,
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email || null,
          phone: r.phone || null,
          title: r.title || null,
          stage: validStage,
          source: r.source || "bulk-import",
          tags: r.tags || null,
          notes: r.notes || null,
          street: r.street || null,
          city: r.city || null,
          state: r.state || null,
          postalCode: r.postalCode || null,
          country: r.country || null,
          region: r.region || null,
        },
      });
      if (r.email) existingEmails.add(r.email.toLowerCase());
      created++;
    } catch (err) {
      errors.push(
        `${r.firstName} ${r.lastName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (created > 0) {
    await audit({
      action: "contacts.bulk_import",
      actorId,
      orgId,
      diff: { created, skipped, total: rows.length },
    });
  }
  return { created, skipped, errors };
}
