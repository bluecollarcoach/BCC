import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Blue Collar Coach brand lockup.
 *
 *   - Default mode: just the circle icon (PNG) + optional Cinzel wordmark beside it.
 *     Use this in tight spaces like the sidebar.
 *   - `lockup` mode: renders the full pre-composed PNG lockup (icon + wordmark
 *     baked into a single image). Use this for headers and sign-in screens
 *     where the full mark deserves the space.
 *   - `showWordmark={false}` falls back to icon-only (smallest footprint).
 *   - `onDark` tints the secondary "INTERNAL" tag for dark chrome surfaces.
 */
export function Logo({
  className,
  showWordmark = true,
  lockup = false,
  size = 40,
  onDark = false,
}: {
  className?: string;
  showWordmark?: boolean;
  /** When true, render the full pre-composed lockup PNG instead of icon + text. */
  lockup?: boolean;
  /** Logical height of the lockup (or diameter of the icon). */
  size?: number;
  onDark?: boolean;
}) {
  // Full lockup is naturally wider than tall; the source image is ~3.3:1.
  // Size = the height; width scales to maintain ratio.
  if (lockup) {
    return (
      <div className={cn("inline-flex items-center", className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/bcc-logo-full.png"
          alt="Blue Collar Coach"
          height={size}
          className="shrink-0 select-none"
          style={{ height: size, width: "auto" }}
        />
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/bcc-icon.png"
        alt=""
        width={size}
        height={size}
        className="shrink-0 select-none"
        style={{ width: size, height: size }}
        aria-hidden
      />
      {showWordmark && (
        <div className="flex flex-col leading-tight">
          <span
            className={cn(
              "font-normal tracking-wide",
              onDark ? "text-amber-200" : "text-amber-700",
            )}
            style={{
              fontSize: size * 0.55,
              fontFamily: 'var(--font-cinzel), Georgia, "Times New Roman", serif',
            }}
          >
            Blue Collar Coach
          </span>
          <span
            className={cn(
              "font-semibold uppercase tracking-[0.22em]",
              onDark ? "text-white/50" : "text-muted-foreground",
            )}
            style={{ fontSize: size * 0.26 }}
          >
            Internal
          </span>
        </div>
      )}
    </div>
  );
}
