import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

export const companySchema = z.object({
  name: z.string().min(1).max(160),
  domain: z.string().max(120).optional(),
  industry: z.string().max(120).optional(),
  size: z.string().max(60).optional(),
  phone: z.string().max(40).optional(),
  website: z.string().max(200).optional(),
  notes: z.string().max(4000).optional(),
});

export type CompanyInput = z.infer<typeof companySchema>;

export async function listCompanies(orgId: string, opts?: { q?: string }) {
  return prisma.company.findMany({
    where: {
      orgId,
      ...(opts?.q
        ? {
            OR: [
              { name: { contains: opts.q } },
              { domain: { contains: opts.q } },
              { industry: { contains: opts.q } },
            ],
          }
        : {}),
    },
    include: {
      _count: { select: { contacts: true, deals: true } },
    },
    orderBy: { name: "asc" },
    take: 500,
  });
}

export async function getCompany(orgId: string, id: string) {
  return prisma.company.findFirst({
    where: { id, orgId },
    include: {
      contacts: {
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: { owner: { select: { id: true, name: true } } },
      },
      deals: {
        orderBy: { updatedAt: "desc" },
        take: 50,
        include: { stage: true },
      },
    },
  });
}

export async function createCompany(orgId: string, actorId: string, input: CompanyInput) {
  const data = companySchema.parse(input);
  const company = await prisma.company.create({
    data: { ...data, orgId },
  });
  await audit({
    action: "company.create",
    actorId,
    orgId,
    targetType: "Company",
    targetId: company.id,
    diff: data,
  });
  return company;
}

export async function updateCompany(
  orgId: string,
  actorId: string,
  id: string,
  input: Partial<CompanyInput>,
) {
  const data = companySchema.partial().parse(input);
  const company = await prisma.company.update({
    where: { id, orgId },
    data,
  });
  await audit({
    action: "company.update",
    actorId,
    orgId,
    targetType: "Company",
    targetId: id,
    diff: data,
  });
  return company;
}

export async function deleteCompany(orgId: string, actorId: string, id: string) {
  await prisma.company.delete({ where: { id, orgId } });
  await audit({
    action: "company.delete",
    actorId,
    orgId,
    targetType: "Company",
    targetId: id,
  });
}
