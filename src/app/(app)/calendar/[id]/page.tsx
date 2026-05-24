import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { getEvent, updateEvent, deleteEvent } from "@/server/services/calendar-events";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";

export const metadata = { title: "Calendar event" };

function localFormat(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default async function CalendarEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const { id } = await params;
  const ev = await getEvent(session.user.orgId, id);
  if (!ev) notFound();

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const startD = new Date(String(fd.get("startAt")));
    const endD = new Date(String(fd.get("endAt")));
    if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD <= startD) return;
    await updateEvent(s.user.orgId, s.user.id, id, {
      title: String(fd.get("title") ?? "").trim() || "Untitled event",
      description: String(fd.get("description") ?? "").trim() || undefined,
      location: String(fd.get("location") ?? "").trim() || undefined,
      startAt: startD,
      endAt: endD,
      allDay: fd.get("allDay") === "on",
    });
  }

  async function remove() {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await deleteEvent(s.user.orgId, s.user.id, id);
    const week = `${ev!.startAt.getFullYear()}-${String(ev!.startAt.getMonth() + 1).padStart(2, "0")}-${String(ev!.startAt.getDate()).padStart(2, "0")}`;
    redirect(`/calendar?week=${week}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title={ev.title}
        description={`${ev.startAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} – ${ev.endAt.toLocaleString("en-US", { timeStyle: "short" })}`}
        actions={
          <>
            <Badge variant={ev.source === "MSGRAPH" ? "success" : "muted"}>
              {ev.source === "MSGRAPH" ? "Synced with MS 365" : "Local only"}
            </Badge>
            <Button asChild variant="ghost">
              <Link href={`/calendar?week=${ev.startAt.toISOString().slice(0, 10)}`}>← Calendar</Link>
            </Button>
            <form action={remove}>
              <Button type="submit" variant="ghost" size="sm" className="text-destructive">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </form>
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit event</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={save} className="space-y-5">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input id="title" name="title" defaultValue={ev.title} required className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" name="description" defaultValue={ev.description ?? ""} rows={4} className="mt-1.5" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="startAt">Start</Label>
                <Input id="startAt" name="startAt" type="datetime-local" required defaultValue={localFormat(ev.startAt)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="endAt">End</Label>
                <Input id="endAt" name="endAt" type="datetime-local" required defaultValue={localFormat(ev.endAt)} className="mt-1.5" />
              </div>
              <div>
                <Label htmlFor="location">Location</Label>
                <Input id="location" name="location" defaultValue={ev.location ?? ""} className="mt-1.5" />
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input id="allDay" name="allDay" type="checkbox" defaultChecked={ev.allDay} className="h-4 w-4 rounded border-border accent-amber" />
                  <span>All day</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit">Save changes</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {ev.source === "MSGRAPH" && (
        <p className="text-xs text-muted-foreground">
          Changes here mirror to your Outlook calendar via Microsoft Graph. If the Graph call
          fails (expired token, network), the local copy still updates and you'll see a warning
          in Application Insights.
        </p>
      )}
    </div>
  );
}
