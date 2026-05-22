import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * BCC Internal logo lockup.
 *   - Bold sans-serif monogram tile (white-on-charcoal or charcoal-on-white)
 *   - Wordmark: "BCC" in heavy sans + "INTERNAL" small caps
 *   - `onDark` flips the tile colors for use on the dark chrome backdrop
 */
export function Logo({
  className,
  showWordmark = true,
  size = 40,
  onDark = false,
}: {
  className?: string;
  showWordmark?: boolean;
  size?: number;
  onDark?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        className={cn(
          "relative grid shrink-0 place-items-center rounded-md font-extrabold tracking-tightest",
          onDark
            ? "bg-white text-ink-900"
            : "bg-ink-900 text-white",
        )}
        style={{
          width: size,
          height: size,
          fontSize: size * 0.42,
        }}
        aria-hidden
      >
        BCC
        <span
          aria-hidden
          className="absolute bottom-0 left-0 right-0 bg-amber"
          style={{ height: Math.max(2, size * 0.06) }}
        />
      </div>
      {showWordmark && (
        <div className="flex flex-col leading-tight">
          <span
            className={cn(
              "font-extrabold tracking-tightest",
              onDark ? "text-white" : "text-foreground",
            )}
            style={{ fontSize: size * 0.5 }}
          >
            Blue Collar Coach
          </span>
          <span
            className={cn(
              "font-semibold uppercase tracking-[0.22em]",
              onDark ? "text-amber-200" : "text-amber-600",
            )}
            style={{ fontSize: size * 0.28 }}
          >
            Internal
          </span>
        </div>
      )}
    </div>
  );
}
