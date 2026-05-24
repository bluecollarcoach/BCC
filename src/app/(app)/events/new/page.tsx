import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New event" };

export default async function NewEventPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  async function create(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const startAt = new Date(String(fd.get("startAt")));
    const endAt = new Date(String(fd.get("endAt")));
    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) return;
    const e = await prisma.eventBooking.create({
      data: {
        orgId: s.user.orgId,
        title: String(fd.get("title") ?? "").trim() || "Untitled event",
        description: String(fd.get("description") ?? "").trim() || null,
        location: String(fd.get("location") ?? "").trim() || null,
        startAt,
        endAt,
        capacity: fd.get("capacity") ? Number(fd.get("capacity")) : null,
        isPublic: fd.get("isPublic") === "on",
      },
    });
    await audit({
      action: "event.create",
      orgId: s.user.orgId,
      actorId: s.user.id,
      targetType: "EventBooking",
      targetId: e.id,
    });
    redirect("/events");
  }

  // Default to one week out, 1-hour slot, for the form's `datetime-local` inputs.
  const oneWeek = new Date();
  oneWeek.setDate(oneWeek.getDate() + 7);
  oneWeek.setMinutes(0, 0, 0);
  const oneWeekEnd = new Date(oneWeek);
  oneWeekEnd.setHours(oneWeekEnd.getHours() + 1);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader title="New event" description="Workshop, lunch-and-learn, customer appreciation, etc." />
      <Card>
        <CardContent className="pt-6">
          <form action={create} className="space-y-5">
            <div>
              <Label htmlFor="title">Title *</Label>
              <Input id="title" name="title" required placeholder="Quarterly safety review" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" name="description" rows={4} className="mt-1.5" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="startAt">Start *</Label>
                <Input
                  id="startAt"
                  name="startAt"
                  type="datetime-local"
                  required
                  defaultValue={fmt(oneWeek)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="endAt">End *</Label>
                <Input
                  id="endAt"
                  name="endAt"
                  type="datetime-local"
                  required
                  defaultValue={fmt(oneWeekEnd)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="location">Location</Label>
                <Input id="location" name="location" placeholder="Shop · 2412 Elm St" className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="capacity">Capacity</Label>
                <Input id="capacity" name="capacity" type="number" min={1} placeholder="(optional)" className="mt-1.5" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input id="isPublic" name="isPublic" type="checkbox" defaultChecked className="h-4 w-4 rounded border-border accent-amber" />
              <label htmlFor="isPublic" className="text-sm">Public (visible on RSVP page)</label>
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="submit">Create event</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
