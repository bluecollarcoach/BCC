"use client";
import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface WeekEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location?: string;
  source?: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOURS = Array.from({ length: 13 }, (_, i) => i + 7); // 7am .. 7pm

export function CalendarWeek({
  weekStart,
  events,
}: {
  weekStart: string;
  events: WeekEvent[];
}) {
  const start = new Date(weekStart);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });

  const eventsByDay = days.map((day) =>
    events.filter((e) => {
      const ev = new Date(e.start);
      return (
        ev.getFullYear() === day.getFullYear() &&
        ev.getMonth() === day.getMonth() &&
        ev.getDate() === day.getDate()
      );
    }),
  );

  return (
    <div className="overflow-x-auto">
      <div className="grid grid-cols-[60px_repeat(7,minmax(120px,1fr))] min-w-[800px]">
        <div />
        {days.map((d, i) => {
          const isToday =
            d.toDateString() === new Date().toDateString();
          return (
            <div
              key={i}
              className={cn(
                "py-2 text-center border-b border-border",
                isToday && "bg-gold/5",
              )}
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {DAYS[i]}
              </div>
              <div
                className={cn(
                  "font-display text-lg mt-0.5",
                  isToday && "text-gold",
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}

        {HOURS.map((h) => (
          <React.Fragment key={h}>
            <div className="text-right pr-2 pt-1 text-[10px] text-muted-foreground border-r border-border">
              {h}:00
            </div>
            {days.map((_, dayIdx) => (
              <div
                key={dayIdx}
                className="relative border-b border-border/60 border-l border-l-border h-14"
              >
                {eventsByDay[dayIdx]
                  .filter((e) => {
                    const start = new Date(e.start);
                    return start.getHours() === h;
                  })
                  .map((e) => {
                    const startD = new Date(e.start);
                    const endD = new Date(e.end);
                    const minutesIntoHour = startD.getMinutes();
                    const durationMin = Math.max(
                      30,
                      (endD.getTime() - startD.getTime()) / 60_000,
                    );
                    const top = (minutesIntoHour / 60) * 56; // 56px per hour
                    const height = (durationMin / 60) * 56;
                    const isLocal = e.source !== "MSGRAPH";
                    const Wrapper = isLocal ? Link : "div" as const;
                    const wrapperProps = isLocal
                      ? { href: `/calendar/${e.id}` as const }
                      : {};
                    return (
                      <Wrapper
                        key={e.id}
                        {...wrapperProps}
                        className={cn(
                          "absolute left-1 right-1 rounded px-2 py-0.5 text-[11px] overflow-hidden text-foreground",
                          isLocal
                            ? "bg-amber/15 border-l-2 border-amber cursor-pointer hover:bg-amber/25 transition-colors"
                            : "bg-blue-500/20 border-l-2 border-blue-400",
                        )}
                        style={{ top, height }}
                        title={`${e.subject} · ${startD.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                      >
                        <div className="font-semibold truncate">{e.subject}</div>
                        {e.location && (
                          <div className="truncate text-muted-foreground">{e.location}</div>
                        )}
                      </Wrapper>
                    );
                  })}
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
