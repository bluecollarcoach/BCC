import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { calendar as graph } from "@/integrations/microsoft-graph";
import { logger } from "@/lib/logger";

interface EventInput {
  title: string;
  description?: string;
  location?: string;
  startAt: Date;
  endAt: Date;
  allDay?: boolean;
  syncToMicrosoft?: boolean;
}

export async function createEvent(
  orgId: string,
  userId: string,
  input: EventInput,
) {
  let externalId: string | null = null;
  if (input.syncToMicrosoft) {
    try {
      const created = await graph.createEvent(userId, {
        subject: input.title,
        body: input.description,
        location: input.location,
        start: input.startAt.toISOString(),
        end: input.endAt.toISOString(),
        isAllDay: input.allDay ?? false,
      });
      externalId = created.id;
    } catch (err) {
      logger.error("calendar.createEvent.graph.failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      // Continue — we'll save locally even if Graph sync fails.
    }
  }
  const ev = await prisma.calendarEvent.create({
    data: {
      orgId,
      ownerId: userId,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      allDay: input.allDay ?? false,
      source: externalId ? "MSGRAPH" : "LOCAL",
      externalId,
    },
  });
  await audit({
    action: "calendar.event.create",
    orgId,
    actorId: userId,
    targetType: "CalendarEvent",
    targetId: ev.id,
    diff: { syncedToMicrosoft: !!externalId },
  });
  return ev;
}

export async function updateEvent(
  orgId: string,
  userId: string,
  id: string,
  input: Partial<EventInput>,
) {
  const current = await prisma.calendarEvent.findFirst({ where: { id, orgId } });
  if (!current) throw new Error("Event not found");

  // Mirror change to Graph if this event is synced.
  if (current.source === "MSGRAPH" && current.externalId) {
    try {
      await graph.updateEvent(userId, current.externalId, {
        subject: input.title,
        body: input.description,
        location: input.location,
        start: input.startAt?.toISOString(),
        end: input.endAt?.toISOString(),
        isAllDay: input.allDay,
      });
    } catch (err) {
      logger.error("calendar.updateEvent.graph.failed", {
        externalId: current.externalId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const updated = await prisma.calendarEvent.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.startAt ? { startAt: input.startAt } : {}),
      ...(input.endAt ? { endAt: input.endAt } : {}),
      ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
    },
  });
  await audit({
    action: "calendar.event.update",
    orgId,
    actorId: userId,
    targetType: "CalendarEvent",
    targetId: id,
  });
  return updated;
}

export async function deleteEvent(orgId: string, userId: string, id: string) {
  const current = await prisma.calendarEvent.findFirst({ where: { id, orgId } });
  if (!current) return;
  if (current.source === "MSGRAPH" && current.externalId) {
    try {
      await graph.deleteEvent(userId, current.externalId);
    } catch (err) {
      logger.error("calendar.deleteEvent.graph.failed", {
        externalId: current.externalId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await prisma.calendarEvent.delete({ where: { id } });
  await audit({
    action: "calendar.event.delete",
    orgId,
    actorId: userId,
    targetType: "CalendarEvent",
    targetId: id,
  });
}

export async function getEvent(orgId: string, id: string) {
  return prisma.calendarEvent.findFirst({
    where: { id, orgId },
    include: { owner: { select: { id: true, name: true, email: true } } },
  });
}
