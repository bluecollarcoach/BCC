import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { calendar } from "@/integrations/microsoft-graph";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { hasEntraConfigured } from "@/lib/env";
import { CalendarWeek } from "@/components/calendar/calendar-week";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

export const metadata = { title: "Calendar" };

function parseWeekParam(raw: string | undefined): Date {
  // Accept ISO date strings like 2026-05-22; default = today.
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw + "T00:00:00");
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function startOfWeek(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay()); // Sunday-anchored
  return s;
}

function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const sp = await searchParams;
  const anchor = parseWeekParam(sp.week);
  const start = startOfWeek(anchor);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const prevWeek = new Date(start);
  prevWeek.setDate(prevWeek.getDate() - 7);
  const nextWeek = new Date(start);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const today = new Date();

  // Best-effort: failures shouldn't crash the page. Microsoft Graph errors
  // (expired token, missing scope) fall back to empty array, mock adapter
  // returns its baked-in data.
  const [localEvents, msEvents] = await Promise.all([
    prisma.calendarEvent
      .findMany({
        where: {
          orgId: session.user.orgId,
          startAt: { gte: start, lt: end },
        },
        orderBy: { startAt: "asc" },
      })
      .catch(() => []),
    calendar
      .listEvents(session.user.id, { from: start, to: end })
      .catch(() => []),
  ]);

  const events = [
    ...localEvents.map((e) => ({
      id: e.id,
      subject: e.title,
      start: e.startAt.toISOString(),
      end: e.endAt.toISOString(),
      location: e.location ?? undefined,
      source: e.source,
    })),
    ...msEvents.map((e) => ({
      id: e.id,
      subject: e.subject,
      start: e.start,
      end: e.end,
      location: e.location,
      source: "MSGRAPH" as const,
    })),
  ];

  const weekLabel = `${start.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
  })} – ${new Date(end.getTime() - 1).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Your week at a glance — synced with Microsoft 365."
        actions={
          <>
            <Badge variant={hasEntraConfigured ? "success" : "muted"}>
              {hasEntraConfigured ? "MS 365 connected" : "Mock data"}
            </Badge>
            <Button asChild>
              <Link href="/calendar/new">New event</Link>
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">{weekLabel}</CardTitle>
            <div className="flex items-center gap-1">
              <Button asChild variant="ghost" size="icon" aria-label="Previous week">
                <Link href={`/calendar?week=${formatYmd(prevWeek)}`}>
                  <ChevronLeft className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/calendar?week=${formatYmd(today)}`}>Today</Link>
              </Button>
              <Button asChild variant="ghost" size="icon" aria-label="Next week">
                <Link href={`/calendar?week=${formatYmd(nextWeek)}`}>
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CalendarWeek weekStart={start.toISOString()} events={events} />
        </CardContent>
      </Card>

      {!hasEntraConfigured && (
        <p className="text-xs text-muted-foreground">
          Calendar is showing mock events. Configure Microsoft Entra in{" "}
          <Link href="/admin/integrations" className="text-amber-700 underline">
            Admin → Integrations
          </Link>{" "}
          to enable two-way sync with Outlook.
        </p>
      )}

      {hasEntraConfigured && msEvents.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Connected to Microsoft 365 but no events returned for this week. If
          this looks wrong, your access token may have expired — sign out and
          back in to refresh, or check{" "}
          <Link href="/admin/integrations" className="text-amber-700 underline">
            Admin → Integrations
          </Link>
          .
        </p>
      )}
    </div>
  );
}
