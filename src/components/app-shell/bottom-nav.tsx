"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Clock, MessageSquare, Calendar, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const MOBILE_TABS = [
  { label: "Home", href: "/dashboard", icon: LayoutDashboard },
  { label: "Time", href: "/time", icon: Clock },
  { label: "Chat", href: "/chat", icon: MessageSquare },
  { label: "Cal", href: "/calendar", icon: Calendar },
  { label: "CRM", href: "/crm", icon: Users },
];

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-20 border-t border-border bg-background/95 backdrop-blur-md">
      <ul className="grid grid-cols-5">
        {MOBILE_TABS.map((tab) => {
          const Icon = tab.icon;
          const active =
            pathname === tab.href ||
            (tab.href !== "/dashboard" && pathname.startsWith(tab.href));
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium uppercase tracking-wider",
                  active ? "text-gold" : "text-muted-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
