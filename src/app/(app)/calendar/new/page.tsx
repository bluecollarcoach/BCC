import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createEvent } from "@/server/services/calendar-events";
import { hasEntraConfigured } from "@/lib/env";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const metadata = { title: "New event" };

function localFormat(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default async function NewCalendarEventPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;

  // Default start = today at next hour boundary; end = +1hr
  const start = new Date(sp.date ? `${sp.date}T09:00` : Date.now());
  start.setMinutes(0, 0, 0);
  if (!sp.date) start.setHours(start.getHours() + 1);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);

  async function save(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const startStr = String(fd.get("startAt"));
    const endStr = String(fd.get("endAt"));
    const startD = new Date(startStr);
    const endD = new Date(endStr);
    if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || endD <= startD) return;
    const ev = await createEvent(s.user.orgId, s.user.id, {
      title: String(fd.get("title") ?? "").trim() || "Untitled event",
      description: String(fd.get("description") ?? "").trim() || undefined,
      location: String(fd.get("location") ?? "").trim() || undefined,
      startAt: startD,
      endAt: endD,
      allDay: fd.get("allDay") === "on",
      syncToMicrosoft: fd.get("syncToMicrosoft") === "on",
    });
    const week = `${ev.startAt.getFullYear()}-${String(ev.startAt.getMonth() + 1).padStart(2, "0")}-${String(ev.startAt.getDate()).padStart(2, "0")}`;
    redirect(`/calendar?week=${week}`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="New calendar event"
        description="Create a local event, optionally synced to your Microsoft 365 calendar."
      />
      <Card>
        <CardContent className="pt-6">
          <form action={save} className="space-y-5">
            <div>
              <Label htmlFor="title">Title *</Label>
              <Input id="title" name="title" required placeholder="Site walk — Castro job" className="mt-1.5" />
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
                  defaultValue={localFormat(start)}
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
                  defaultValue={localFormat(end)}
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="location">Location</Label>
                <Input id="location" name="location" placeholder="2412 Elm St / Teams link / etc." className="mt-1.5" />
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input id="allDay" name="allDay" type="checkbox" className="h-4 w-4 rounded border-border accent-amber" />
                  <span>All day</span>
                </label>
              </div>
            </div>
            <div className="border-t border-border pt-4">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  id="syncToMicrosoft"
                  name="syncToMicrosoft"
                  type="checkbox"
                  defaultChecked={hasEntraConfigured}
                  disabled={!hasEntraConfigured}
                  className="h-4 w-4 rounded border-border accent-amber mt-0.5"
                />
                <div className="leading-tight">
                  <div className="font-medium">Also create in Microsoft 365</div>
                  <div className="text-xs text-muted-foreground">
                    {hasEntraConfigured
                      ? "Will appear in your Outlook calendar. Edits/deletes here mirror to MS."
                      : "Microsoft Entra not configured — toggle disabled."}
                  </div>
                </div>
              </label>
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
