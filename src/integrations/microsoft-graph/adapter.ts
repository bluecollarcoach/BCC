/**
 * Microsoft Graph adapter — calendar + (future) mail.
 *
 * Auth: uses the Account row populated by NextAuth's Microsoft Entra ID provider.
 * That row holds access_token / refresh_token / expires_at. The real `graph.ts`
 * client refreshes the token on demand.
 */

export interface GraphEvent {
  id: string;
  subject: string;
  body?: string;
  location?: string;
  start: string;      // ISO
  end: string;        // ISO
  isAllDay?: boolean;
  attendees?: Array<{ email: string; name?: string }>;
  etag?: string;
}

export interface GraphCalendarAdapter {
  listEvents(userId: string, range: { from: Date; to: Date }): Promise<GraphEvent[]>;
  createEvent(userId: string, ev: Omit<GraphEvent, "id" | "etag">): Promise<GraphEvent>;
  updateEvent(userId: string, id: string, ev: Partial<GraphEvent>): Promise<GraphEvent>;
  deleteEvent(userId: string, id: string): Promise<void>;
}
