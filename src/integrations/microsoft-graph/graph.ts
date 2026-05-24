import { Client } from "@microsoft/microsoft-graph-client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { GraphCalendarAdapter, GraphEvent } from "./adapter";

/**
 * Microsoft Graph live adapter.
 *
 * Handles automatic refresh of the OAuth access token. Auth.js stores tokens
 * in the Account row via the Prisma adapter; access tokens live ~1 hour and
 * we refresh transparently against login.microsoftonline.com when they expire.
 */

// Refresh ~5 minutes before stated expiry so we don't race the boundary.
const SKEW_MS = 5 * 60 * 1000;
const GRAPH_SCOPES =
  "openid profile email offline_access User.Read Calendars.ReadWrite Mail.Send";

async function refreshAccessToken(
  refreshToken: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}> {
  const tenant = env.AUTH_MICROSOFT_ENTRA_TENANT_ID || "common";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.AUTH_MICROSOFT_ENTRA_ID ?? "",
    client_secret: env.AUTH_MICROSOFT_ENTRA_SECRET ?? "",
    scope: GRAPH_SCOPES,
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph refresh ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  }>;
}

async function getAccessTokenFor(userId: string): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "microsoft-entra-id" },
  });
  if (!account?.access_token) return null;

  const expiresAtMs = account.expires_at ? account.expires_at * 1000 : 0;
  const isExpiringSoon = expiresAtMs > 0 && expiresAtMs - SKEW_MS < Date.now();

  if (!isExpiringSoon) return account.access_token;
  if (!account.refresh_token) {
    logger.warn("graph.token.expired_no_refresh_token", { userId });
    return account.access_token; // expired, but worth trying — Graph will 401
  }

  try {
    logger.info("graph.token.refreshing", { userId });
    const fresh = await refreshAccessToken(account.refresh_token);
    const newExpiresAt = Math.floor(Date.now() / 1000) + fresh.expires_in;
    await prisma.account.update({
      where: { id: account.id },
      data: {
        access_token: fresh.access_token,
        // MS may rotate the refresh token; keep the new one if returned.
        refresh_token: fresh.refresh_token ?? account.refresh_token,
        expires_at: newExpiresAt,
        id_token: fresh.id_token ?? account.id_token,
      },
    });
    logger.info("graph.token.refreshed", { userId, expiresAt: newExpiresAt });
    return fresh.access_token;
  } catch (err) {
    logger.error("graph.token.refresh_failed", {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return account.access_token; // last-resort: try the stale token
  }
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
      raw.location &&
      typeof (raw.location as { displayName?: unknown }).displayName === "string"
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
    try {
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
    } catch (err) {
      logger.error("graph.listEvents.failed", {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
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
