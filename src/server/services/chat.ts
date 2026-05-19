import { prisma } from "@/lib/db";
import { realtime } from "@/integrations/realtime";
import { audit } from "@/lib/audit";

export async function listChannels(orgId: string, userId: string) {
  return prisma.chatChannel.findMany({
    where: {
      orgId,
      OR: [
        { kind: "PUBLIC" },
        { members: { some: { userId } } },
      ],
    },
    include: {
      _count: { select: { messages: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { author: { select: { id: true, name: true, image: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function getChannel(orgId: string, id: string) {
  return prisma.chatChannel.findFirst({
    where: { id, orgId },
    include: {
      members: { include: { user: { select: { id: true, name: true, image: true } } } },
    },
  });
}

export async function listMessages(channelId: string, limit = 100) {
  return prisma.chatMessage.findMany({
    where: { channelId },
    include: { author: { select: { id: true, name: true, image: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function postMessage(
  orgId: string,
  authorId: string,
  channelId: string,
  body: string,
) {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const message = await prisma.chatMessage.create({
    data: { channelId, authorId, body: trimmed },
    include: { author: { select: { id: true, name: true, image: true } } },
  });
  await realtime.publish(channelId, {
    channelId,
    messageId: message.id,
    authorId,
    body: trimmed,
    createdAt: message.createdAt.toISOString(),
  });
  await audit({
    action: "chat.message.post",
    actorId: authorId,
    orgId,
    targetType: "ChatMessage",
    targetId: message.id,
  });
  return message;
}
