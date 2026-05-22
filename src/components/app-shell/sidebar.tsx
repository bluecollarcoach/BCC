"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { APP_NAV, type NavSection } from "@/config/nav";
import { ShieldCheck } from "lucide-react";

export function Sidebar({
  sections = APP_NAV,
  isAdmin = false,
}: {
  sections?: NavSection[];
  isAdmin?: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:w-64 xl:w-72 flex-col bg-chrome text-chrome-foreground border-r border-chrome-border chrome-scroll">
      <div className="flex h-16 items-center border-b border-chrome-border px-5">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <Logo size={32} showWordmark={false} onDark />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-bold tracking-tight">
              Blue Collar Coach
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-200">
              Internal
            </span>
          </div>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        {sections.map((section) => (
          <div key={section.label} className="mb-6">
            <h4 className="px-3 pb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-chrome-muted">
              {section.label}
            </h4>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== "/dashboard" && pathname.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-white/5 text-white"
                          : "text-chrome-foreground/70 hover:bg-white/5 hover:text-white",
                      )}
                    >
                      {active && (
                        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-amber" />
                      )}
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          active ? "text-amber" : "text-chrome-muted group-hover:text-white",
                        )}
                      />
                      <span className="flex-1">{item.label}</span>
                      {item.badge && (
                        <span className="rounded-full bg-amber px-2 py-0.5 text-[10px] font-bold text-ink-900">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {isAdmin && (
        <div className="border-t border-chrome-border p-3">
          <Link
            href="/admin"
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
              pathname.startsWith("/admin")
                ? "bg-white/10 text-white"
                : "text-chrome-foreground/70 hover:bg-white/5 hover:text-white",
            )}
          >
            <ShieldCheck className="h-4 w-4 text-amber" />
            Admin Center
          </Link>
        </div>
      )}
    </aside>
  );
}
