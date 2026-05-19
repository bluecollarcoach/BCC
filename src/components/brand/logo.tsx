import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * BCC logo lockup. Matches the bluecollarcoach.us brand:
 *   - gold circular emblem with monogram
 *   - Georgia serif wordmark in gold
 *   - works on dark backgrounds by default
 */
export function Logo({
  className,
  showWordmark = true,
  size = 40,
}: {
  className?: string;
  showWordmark?: boolean;
  size?: number;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        className="relative grid shrink-0 place-items-center rounded-full border-2 border-gold bg-ink-900 text-gold font-display"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden
      >
        <span className="tracking-tight">BCC</span>
      </div>
      {showWordmark && (
        <div className="flex flex-col leading-tight">
          <span
            className="font-display text-gold tracking-[0.18em]"
            style={{ fontSize: size * 0.55 }}
          >
            BLUE COLLAR
          </span>
          <span
            className="font-display text-foreground/80 tracking-[0.22em]"
            style={{ fontSize: size * 0.34 }}
          >
            COACH · CONNECT
          </span>
        </div>
      )}
    </div>
  );
}
