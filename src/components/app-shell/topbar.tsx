"use client";
import * as React from "react";
import Link from "next/link";
import { Search, Bell, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { MobileNav } from "./mobile-nav";
import { cn } from "@/lib/utils";

export function Topbar({
  user,
}: {
  user?: { name?: string | null; email?: string | null; image?: string | null };
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md sm:px-6">
      <MobileNav />

      <div className="hidden md:flex flex-1 max-w-xl items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground">
        <Search className="h-4 w-4" />
        <input
          type="search"
          placeholder="Search contacts, deals, files, messages…"
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden lg:inline-flex h-5 items-center rounded border border-border bg-background px-1.5 text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </div>

      <div className="flex-1 md:hidden" />

      <Link
        href="/crm/contacts/new"
        className="hidden sm:inline-flex h-9 items-center gap-1.5 rounded-md bg-gold px-3 text-xs font-bold uppercase tracking-wider text-ink-900 hover:bg-gold-600"
      >
        <Plus className="h-3.5 w-3.5" />
        Quick Add
      </Link>

      <button
        type="button"
        className={cn(
          "relative grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-gold animate-pulse-dot" />
      </button>

      <Link href="/settings" className="flex items-center gap-2">
        <Avatar name={user?.name ?? "Coach"} src={user?.image ?? undefined} size={32} />
        <div className="hidden sm:block text-left leading-tight">
          <div className="text-xs font-semibold">{user?.name ?? "Coach"}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {user?.email ?? "demo@bluecollarcoach.us"}
          </div>
        </div>
      </Link>
    </header>
  );
}
