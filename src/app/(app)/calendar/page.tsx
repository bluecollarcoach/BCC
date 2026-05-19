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
import Link from "next/link";

export const metadata = { title: "Calendar" };

export default async function CalendarPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  // Pull local events + Microsoft Graph events, merge.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay()); // start of week (Sun)
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const [localEvents, msEvents] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: {
        orgId: session.user.orgId,
        startAt: { gte: start, lt: end },
      },
      orderBy: { startAt: "asc" },
    }),
    calendar.listEvents(session.user.id, { from: start, to: end }).catch(() => []),
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
          <CardTitle className="text-base">
            Week of{" "}
            {start.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CalendarWeek weekStart={start.toISOString()} events={events} />
        </CardContent>
      </Card>

      {!hasEntraConfigured && (
        <p className="text-xs text-muted-foreground">
          Calendar is showing mock events. Configure Microsoft Entra in{" "}
          <Link href="/admin/integrations" className="text-gold underline">
            Admin → Integrations
          </Link>{" "}
          to enable two-way sync with Outlook.
        </p>
      )}
    </div>
  );
}
