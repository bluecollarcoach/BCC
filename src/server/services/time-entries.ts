import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export async function startTimer(
  orgId: string,
  userId: string,
  opts: { jobName?: string; dealId?: string; notes?: string; billable?: boolean },
) {
  // Stop any existing running timer for this user (one active timer at a time).
  await stopAllRunning(orgId, userId);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { hourlyRate: true } });

  const entry = await prisma.timeEntry.create({
    data: {
      orgId,
      userId,
      jobName: opts.jobName,
      dealId: opts.dealId,
      notes: opts.notes,
      billable: opts.billable ?? true,
      rateCents: user?.hourlyRate ?? null,
      startedAt: new Date(),
      status: "RUNNING",
    },
  });
  await audit({
    action: "time.start",
    actorId: userId,
    orgId,
    targetType: "TimeEntry",
    targetId: entry.id,
  });
  return entry;
}

export async function stopTimer(orgId: string, userId: string, entryId: string) {
  const entry = await prisma.timeEntry.findFirst({
    where: { id: entryId, orgId, userId, status: "RUNNING" },
  });
  if (!entry) return null;
  const endedAt = new Date();
  const durationSec = Math.floor((endedAt.getTime() - entry.startedAt.getTime()) / 1000);
  const updated = await prisma.timeEntry.update({
    where: { id: entry.id },
    data: { endedAt, durationSec, status: "STOPPED" },
  });
  await audit({
    action: "time.stop",
    actorId: userId,
    orgId,
    targetType: "TimeEntry",
    targetId: entry.id,
    diff: { durationSec },
  });
  return updated;
}

export async function stopAllRunning(orgId: string, userId: string) {
  const running = await prisma.timeEntry.findMany({
    where: { orgId, userId, status: "RUNNING" },
  });
  for (const e of running) await stopTimer(orgId, userId, e.id);
}

export async function listEntries(
  orgId: string,
  opts?: { userId?: string; days?: number },
) {
  const since = new Date();
  since.setDate(since.getDate() - (opts?.days ?? 14));
  return prisma.timeEntry.findMany({
    where: {
      orgId,
      ...(opts?.userId ? { userId: opts.userId } : {}),
      startedAt: { gte: since },
    },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { startedAt: "desc" },
    take: 500,
  });
}

export async function submitForApproval(orgId: string, userId: string, entryId: string) {
  return prisma.timeEntry.update({
    where: { id: entryId, orgId, userId },
    data: { status: "SUBMITTED" },
  });
}

export async function approveEntry(
  orgId: string,
  approverId: string,
  entryId: string,
  approved: boolean,
) {
  const updated = await prisma.timeEntry.update({
    where: { id: entryId, orgId },
    data: { status: approved ? "APPROVED" : "REJECTED" },
  });
  await audit({
    action: approved ? "time.approve" : "time.reject",
    actorId: approverId,
    orgId,
    targetType: "TimeEntry",
    targetId: entryId,
  });
  return updated;
}

export async function getRunningEntry(orgId: string, userId: string) {
  return prisma.timeEntry.findFirst({
    where: { orgId, userId, status: "RUNNING" },
  });
}

export function totalHours(entries: { durationSec: number | null }[]) {
  return entries.reduce((sum, e) => sum + (e.durationSec ?? 0), 0) / 3600;
}
