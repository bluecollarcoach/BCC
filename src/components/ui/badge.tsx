import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-gold/15 text-gold ring-1 ring-gold/30",
        muted: "bg-muted text-muted-foreground",
        success: "bg-success/15 text-success ring-1 ring-success/30",
        warning: "bg-warning/15 text-warning ring-1 ring-warning/30",
        danger:
          "bg-destructive/15 text-destructive ring-1 ring-destructive/30",
        outline: "border border-border text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
