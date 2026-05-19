import { auth } from "@/lib/auth";
import { realtime } from "@/integrations/realtime";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream for chat messages on a single channel.
 * Production: replace this with a direct Azure SignalR client connection
 * using realtime.issueClientToken(). The mock adapter speaks SSE.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.orgId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId");
  if (!channelId) return new Response("Missing channelId", { status: 400 });

  const encoder = new TextEncoder();
  const ctl = new AbortController();
  req.signal.addEventListener("abort", () => ctl.abort());

  const stream = new ReadableStream({
    async start(controller) {
      // Initial comment to open the connection.
      controller.enqueue(encoder.encode(`: connected\n\n`));
      try {
        for await (const msg of realtime.subscribe(channelId, ctl.signal)) {
          const payload = JSON.stringify({
            id: msg.messageId,
            body: msg.body,
            createdAt: msg.createdAt,
            author: { id: msg.authorId },
          });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        }
      } catch {
        // closed
      } finally {
        controller.close();
      }
    },
    cancel() {
      ctl.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
