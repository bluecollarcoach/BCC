import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, Plus, MapPin, Users as UsersIcon } from "lucide-react";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Events" };

export default async function EventsPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const events = await prisma.eventBooking.findMany({
    where: { orgId: session.user.orgId, startAt: { gte: new Date() } },
    orderBy: { startAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Events"
        description="Workshops, lunch-and-learns, customer appreciation, ride-alongs."
        actions={
          <Button asChild>
            <Link href="/events/new">
              <Plus className="h-4 w-4" /> Create event
            </Link>
          </Button>
        }
      />

      {events.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No upcoming events"
          description="Host a customer breakfast, a quarterly safety review, or a community open house. Events drive referrals."
          action={
            <Button asChild>
              <Link href="/events/new">
                <Plus className="h-4 w-4" /> Create your first event
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {events.map((e) => (
            <Card key={e.id} className="hover:border-gold/40 transition">
              <CardContent className="py-5 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-display text-lg">{e.title}</h3>
                    {e.description && (
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{e.description}</p>
                    )}
                  </div>
                  <Badge variant={e.isPublic ? "default" : "muted"}>
                    {e.isPublic ? "Public" : "Private"}
                  </Badge>
                </div>
                <div className="text-sm flex flex-wrap gap-4">
                  <div className="flex items-center gap-1.5 text-foreground/80">
                    <CalendarDays className="h-3.5 w-3.5 text-gold" />
                    {formatDate(e.startAt, { dateStyle: "medium", timeStyle: "short" })}
                  </div>
                  {e.location && (
                    <div className="flex items-center gap-1.5 text-foreground/80">
                      <MapPin className="h-3.5 w-3.5 text-gold" />
                      {e.location}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 text-foreground/80">
                    <UsersIcon className="h-3.5 w-3.5 text-gold" />
                    {e.rsvpCount}
                    {e.capacity ? ` / ${e.capacity}` : ""} RSVPs
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
