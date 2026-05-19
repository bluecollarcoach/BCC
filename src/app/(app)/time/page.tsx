import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getRunningEntry,
  listEntries,
  startTimer,
  stopTimer,
  submitForApproval,
  totalHours,
} from "@/server/services/time-entries";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TimerCard } from "@/components/time/timer-card";
import { formatDate, formatDuration } from "@/lib/utils";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Time tracking" };

const STATUS_VARIANT = {
  RUNNING: "default",
  STOPPED: "muted",
  SUBMITTED: "warning",
  APPROVED: "success",
  REJECTED: "danger",
} as const;

export default async function TimePage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const orgId = session.user.orgId;
  const userId = session.user.id;

  const [running, myEntries] = await Promise.all([
    getRunningEntry(orgId, userId),
    listEntries(orgId, { userId, days: 14 }),
  ]);

  const weekHours = totalHours(
    myEntries.filter((e) => {
      const start = new Date();
      start.setDate(start.getDate() - 7);
      return e.startedAt >= start && e.durationSec != null;
    }),
  );

  async function doStart(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await startTimer(s.user.orgId, s.user.id, {
      jobName: String(fd.get("jobName") ?? "") || undefined,
      notes: String(fd.get("notes") ?? "") || undefined,
      billable: fd.get("billable") === "on",
    });
    revalidatePath("/time");
  }

  async function doStop(entryId: string) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await stopTimer(s.user.orgId, s.user.id, entryId);
    revalidatePath("/time");
  }

  async function doSubmit(entryId: string) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    await submitForApproval(s.user.orgId, s.user.id, entryId);
    revalidatePath("/time");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Time tracking"
        description="Run a timer, log billable hours, submit for approval."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-4">
          <TimerCard
            initialRunning={
              running
                ? {
                    id: running.id,
                    startedAt: running.startedAt.toISOString(),
                    jobName: running.jobName,
                    notes: running.notes,
                  }
                : null
            }
            onStart={doStart}
            onStop={doStop}
          />

          <Card>
            <CardHeader>
              <CardTitle>This week</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-display text-4xl text-gold tabular-nums">
                {weekHours.toFixed(1)}h
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Last 7 days · across {myEntries.length} entries
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent entries</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">Job</th>
                  <th className="px-4 py-2 font-semibold">Date</th>
                  <th className="px-4 py-2 font-semibold">Duration</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {myEntries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                      No entries in the last 14 days. Start a timer above.
                    </td>
                  </tr>
                )}
                {myEntries.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium">{e.jobName ?? <span className="text-muted-foreground">—</span>}</div>
                      {e.notes && <div className="text-xs text-muted-foreground">{e.notes}</div>}
                    </td>
                    <td className="px-4 py-3 text-foreground/80">
                      {formatDate(e.startedAt, { dateStyle: "medium" })}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      {e.durationSec != null
                        ? formatDuration(e.durationSec * 1000)
                        : "Running"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[e.status]}>{e.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {e.status === "STOPPED" && (
                        <form action={async () => { "use server"; await doSubmit(e.id); }}>
                          <Button type="submit" size="sm" variant="outline">
                            Submit
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
