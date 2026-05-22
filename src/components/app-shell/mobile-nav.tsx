"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { APP_NAV, ADMIN_NAV } from "@/config/nav";
import { cn } from "@/lib/utils";

export function MobileNav() {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="lg:hidden grid h-9 w-9 place-items-center rounded-md text-foreground hover:bg-muted"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="lg:hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            className="absolute inset-y-0 left-0 w-72 max-w-[85%] bg-chrome text-chrome-foreground border-r border-chrome-border flex flex-col animate-fade-in chrome-scroll"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-16 items-center justify-between border-b border-chrome-border px-5">
              <Logo size={32} showWordmark={false} onDark />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="grid h-8 w-8 place-items-center rounded-md text-white/70 hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3">
              {[...APP_NAV, ...ADMIN_NAV].map((section) => (
                <div key={section.label} className="mb-5">
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
                              "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm",
                              active
                                ? "bg-white/5 text-white"
                                : "text-chrome-foreground/70 hover:bg-white/5 hover:text-white",
                            )}
                          >
                            <Icon
                              className={cn(
                                "h-4 w-4",
                                active ? "text-amber" : "text-chrome-muted",
                              )}
                            />
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
