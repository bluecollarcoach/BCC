"use client";
import * as React from "react";
import { Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

interface RunningEntry {
  id: string;
  startedAt: string;
  jobName?: string | null;
  notes?: string | null;
}

export function TimerCard({
  initialRunning,
  onStart,
  onStop,
}: {
  initialRunning: RunningEntry | null;
  onStart: (fd: FormData) => Promise<void>;
  onStop: (entryId: string) => Promise<void>;
}) {
  const [running, setRunning] = React.useState(initialRunning);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!running) return;
    const startMs = new Date(running.startedAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  const hh = Math.floor(elapsed / 3600);
  const mm = Math.floor((elapsed % 3600) / 60);
  const ss = elapsed % 60;
  const fmt = (n: number) => n.toString().padStart(2, "0");

  return (
    <Card className={running ? "border-gold/40 shadow-glow" : ""}>
      <CardContent className="pt-6">
        {running ? (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold">
                  ● On the clock
                </div>
                <div className="mt-1 font-medium">{running.jobName ?? "Unspecified job"}</div>
                {running.notes && (
                  <p className="text-xs text-muted-foreground mt-1">{running.notes}</p>
                )}
              </div>
              <div className="font-display text-4xl tabular-nums text-gold">
                {fmt(hh)}:{fmt(mm)}:{fmt(ss)}
              </div>
            </div>
            <form
              action={async () => {
                await onStop(running.id);
                setRunning(null);
                setElapsed(0);
              }}
            >
              <Button type="submit" variant="destructive" className="w-full">
                <Square className="h-4 w-4" /> Stop timer
              </Button>
            </form>
          </div>
        ) : (
          <form
            action={async (fd: FormData) => {
              await onStart(fd);
            }}
            className="space-y-3"
          >
            <div>
              <Label htmlFor="jobName">Job / project</Label>
              <Input
                id="jobName"
                name="jobName"
                placeholder="Henley HVAC — RTU install"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                name="notes"
                placeholder="Optional"
                className="mt-1.5"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="billable"
                name="billable"
                type="checkbox"
                defaultChecked
                className="h-4 w-4 rounded border-border accent-gold"
              />
              <label htmlFor="billable" className="text-sm">
                Billable
              </label>
            </div>
            <Button type="submit" className="w-full" size="lg">
              <Play className="h-4 w-4" /> Start timer
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
