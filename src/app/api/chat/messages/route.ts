import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { postMessage } from "@/server/services/chat";
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await req.json()) as { channelId?: string; body?: string };
    if (!body.channelId || !body.body) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }
    const msg = await postMessage(
      session.user.orgId,
      session.user.id,
      body.channelId,
      body.body,
    );
    if (!msg) return NextResponse.json({ error: "Empty body" }, { status: 400 });
    return NextResponse.json({
      id: msg.id,
      body: msg.body,
      createdAt: msg.createdAt.toISOString(),
      author: {
        id: msg.author.id,
        name: msg.author.name,
        image: msg.author.image,
      },
    });
  } catch (err) {
    logger.error("chat.message.post.failed", { err });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
