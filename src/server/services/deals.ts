import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

export const dealSchema = z.object({
  name: z.string().min(1).max(160),
  amountCents: z.number().int().min(0).default(0),
  status: z.enum(["OPEN", "WON", "LOST"]).default("OPEN"),
  expectedClose: z.string().optional(),
  pipelineId: z.string().optional(),
  stageId: z.string().optional(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  notes: z.string().max(4000).optional(),
});

export type DealInput = z.infer<typeof dealSchema>;

export async function getDeal(orgId: string, id: string) {
  return prisma.deal.findFirst({
    where: { id, orgId },
    include: {
      pipeline: { include: { stages: { orderBy: { order: "asc" } } } },
      stage: true,
      contact: true,
      company: true,
      owner: { select: { id: true, name: true, email: true } },
      activities: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
}

export async function createDeal(orgId: string, actorId: string, input: DealInput) {
  const data = dealSchema.parse(input);
  // Resolve a pipeline + stage if not provided.
  let pipelineId = data.pipelineId;
  let stageId = data.stageId;
  if (!pipelineId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { orgId, isDefault: true },
      include: { stages: { orderBy: { order: "asc" }, take: 1 } },
    });
    if (!pipeline) throw new Error("No pipeline configured");
    pipelineId = pipeline.id;
    if (!stageId) stageId = pipeline.stages[0]?.id;
  }
  if (!stageId) throw new Error("No stage selected");

  const deal = await prisma.deal.create({
    data: {
      orgId,
      ownerId: actorId,
      name: data.name,
      amountCents: data.amountCents,
      status: data.status,
      pipelineId,
      stageId,
      contactId: data.contactId ?? null,
      companyId: data.companyId ?? null,
      notes: data.notes ?? null,
      expectedClose: data.expectedClose ? new Date(data.expectedClose) : null,
    },
  });
  await audit({
    action: "deal.create",
    actorId,
    orgId,
    targetType: "Deal",
    targetId: deal.id,
    diff: data,
  });
  return deal;
}

export async function updateDeal(
  orgId: string,
  actorId: string,
  id: string,
  input: Partial<DealInput>,
) {
  const data = dealSchema.partial().parse(input);
  const deal = await prisma.deal.update({
    where: { id, orgId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.amountCents !== undefined ? { amountCents: data.amountCents } : {}),
      ...(data.status !== undefined
        ? {
            status: data.status,
            closedAt: data.status !== "OPEN" ? new Date() : null,
          }
        : {}),
      ...(data.stageId ? { stageId: data.stageId } : {}),
      ...(data.contactId !== undefined ? { contactId: data.contactId || null } : {}),
      ...(data.companyId !== undefined ? { companyId: data.companyId || null } : {}),
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(data.expectedClose !== undefined
        ? { expectedClose: data.expectedClose ? new Date(data.expectedClose) : null }
        : {}),
    },
  });
  await audit({
    action: "deal.update",
    actorId,
    orgId,
    targetType: "Deal",
    targetId: id,
    diff: data,
  });
  return deal;
}

export async function deleteDeal(orgId: string, actorId: string, id: string) {
  await prisma.deal.delete({ where: { id, orgId } });
  await audit({
    action: "deal.delete",
    actorId,
    orgId,
    targetType: "Deal",
    targetId: id,
  });
}

export async function listContactsForOrg(orgId: string) {
  return prisma.contact.findMany({
    where: { orgId },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 500,
  });
}

export async function listCompaniesForOrg(orgId: string) {
  return prisma.company.findMany({
    where: { orgId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });
}
