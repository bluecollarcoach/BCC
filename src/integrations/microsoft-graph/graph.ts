import { Client } from "@microsoft/microsoft-graph-client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { GraphCalendarAdapter, GraphEvent } from "./adapter";

async function getAccessTokenFor(userId: string): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "microsoft-entra-id" },
  });
  if (!account?.access_token) return null;

  // TODO: refresh token if expires_at has passed. For now we return the stored token.
  if (account.expires_at && account.expires_at * 1000 < Date.now()) {
    logger.warn("graph.token.expired", { userId });
    // refresh flow:
    //   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
    //     grant_type=refresh_token & refresh_token=... & client_id=... & client_secret=...
    //   then persist back to Account.
  }
  return account.access_token;
}

function graphClientFor(userId: string) {
  return Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessTokenFor(userId);
        if (!token) return done(new Error("No Graph token for user"), null);
        done(null, token);
      } catch (e) {
        done(e as Error, null);
      }
    },
  });
}

function toGraphEvent(raw: Record<string, unknown>): GraphEvent {
  return {
    id: String(raw.id),
    subject: String(raw.subject ?? ""),
    body: typeof raw.bodyPreview === "string" ? raw.bodyPreview : undefined,
    location:
      raw.location && typeof (raw.location as { displayName?: unknown }).displayName === "string"
        ? ((raw.location as { displayName: string }).displayName)
        : undefined,
    start: ((raw.start as { dateTime?: string })?.dateTime ?? "") + "Z",
    end: ((raw.end as { dateTime?: string })?.dateTime ?? "") + "Z",
    isAllDay: Boolean(raw.isAllDay),
    etag: typeof raw["@odata.etag"] === "string" ? (raw["@odata.etag"] as string) : undefined,
  };
}

export const graphCalendar: GraphCalendarAdapter = {
  async listEvents(userId, range) {
    const c = graphClientFor(userId);
    const res = await c
      .api("/me/calendarView")
      .query({
        startDateTime: range.from.toISOString(),
        endDateTime: range.to.toISOString(),
      })
      .top(250)
      .get();
    return ((res.value as Record<string, unknown>[]) ?? []).map(toGraphEvent);
  },

  async createEvent(userId, ev) {
    const c = graphClientFor(userId);
    const res = await c.api("/me/events").post({
      subject: ev.subject,
      body: { contentType: "Text", content: ev.body ?? "" },
      start: { dateTime: ev.start, timeZone: "UTC" },
      end: { dateTime: ev.end, timeZone: "UTC" },
      location: ev.location ? { displayName: ev.location } : undefined,
      isAllDay: ev.isAllDay ?? false,
      attendees: (ev.attendees ?? []).map((a) => ({
        emailAddress: { address: a.email, name: a.name },
        type: "required",
      })),
    });
    return toGraphEvent(res as Record<string, unknown>);
  },

  async updateEvent(userId, id, ev) {
    const c = graphClientFor(userId);
    const res = await c.api(`/me/events/${id}`).patch({
      ...(ev.subject ? { subject: ev.subject } : {}),
      ...(ev.body ? { body: { contentType: "Text", content: ev.body } } : {}),
      ...(ev.start ? { start: { dateTime: ev.start, timeZone: "UTC" } } : {}),
      ...(ev.end ? { end: { dateTime: ev.end, timeZone: "UTC" } } : {}),
      ...(ev.location ? { location: { displayName: ev.location } } : {}),
    });
    return toGraphEvent(res as Record<string, unknown>);
  },

  async deleteEvent(userId, id) {
    const c = graphClientFor(userId);
    await c.api(`/me/events/${id}`).delete();
  },
};
