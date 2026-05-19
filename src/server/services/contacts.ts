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
});

export type ContactInput = z.infer<typeof contactSchema>;

export async function listContacts(orgId: string, opts?: { q?: string; stage?: ContactStage }) {
  return prisma.contact.findMany({
    where: {
      orgId,
      ...(opts?.stage ? { stage: opts.stage } : {}),
      ...(opts?.q
        ? {
            OR: [
              { firstName: { contains: opts.q } },
              { lastName: { contains: opts.q } },
              { email: { contains: opts.q } },
              { phone: { contains: opts.q } },
            ],
          }
        : {}),
    },
    include: { company: true, owner: { select: { id: true, name: true, email: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
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
