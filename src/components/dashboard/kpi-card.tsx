import * as React from "react";
import { ArrowDown, ArrowUp, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function KpiCard({
  label,
  value,
  delta,
  helper,
  icon: Icon,
  trend = "neutral",
  accent = false,
}: {
  label: string;
  value: string;
  delta?: string;
  helper?: string;
  icon?: LucideIcon;
  trend?: "up" | "down" | "neutral";
  accent?: boolean;
}) {
  const trendColor =
    trend === "up"
      ? "text-success"
      : trend === "down"
      ? "text-destructive"
      : "text-muted-foreground";
  const TrendIcon = trend === "up" ? ArrowUp : trend === "down" ? ArrowDown : null;

  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border bg-card p-5 shadow-card transition hover:border-amber/40 hover:shadow-md",
        accent && "card-accent",
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-2 text-3xl font-extrabold tracking-tightest text-foreground">
            {value}
          </p>
        </div>
        {Icon && (
          <div className="rounded-md bg-muted p-2 text-foreground/70 ring-1 ring-border">
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
      {(delta || helper) && (
        <div className="mt-4 flex items-center gap-2 text-xs">
          {delta && (
            <span className={cn("inline-flex items-center gap-0.5 font-semibold", trendColor)}>
              {TrendIcon && <TrendIcon className="h-3 w-3" />}
              {delta}
            </span>
          )}
          {helper && <span className="text-muted-foreground">{helper}</span>}
        </div>
      )}
    </div>
  );
}
