import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  Users,
  Clock,
  Calendar,
  MessageSquare,
  Calculator,
  GraduationCap,
  LayoutDashboard,
  Megaphone,
  ShieldCheck,
} from "lucide-react";

const FEATURES = [
  {
    icon: LayoutDashboard,
    title: "Operations Dashboard",
    body: "One pane of glass for revenue, jobs, crew utilization, and cash position.",
  },
  {
    icon: Users,
    title: "CRM Built for the Trades",
    body: "Leads, deals, pipeline — wired to your calendar, jobs, and books.",
  },
  {
    icon: Calendar,
    title: "Calendars (Microsoft 365 Sync)",
    body: "Two-way sync with Outlook. Crew calendars, customer bookings, all in one view.",
  },
  {
    icon: MessageSquare,
    title: "Team & Customer Chat",
    body: "Real-time channels, DMs, and customer threads with attachments and mentions.",
  },
  {
    icon: Clock,
    title: "Time Tracking + Job Costing",
    body: "Mobile-first timer, GPS-aware, with crew approvals and payroll export.",
  },
  {
    icon: Calculator,
    title: "QBO-Synced Bookkeeping",
    body: "Live P&L, AR/AP, and cash KPIs from your QuickBooks Online file.",
  },
  {
    icon: Megaphone,
    title: "Marketing Command Center",
    body: "Email, SMS, social, and review campaigns — internal comms in the same place.",
  },
  {
    icon: GraduationCap,
    title: "Training & Playbooks",
    body: "Customer-facing courses and internal SOPs. Track progress, certify staff.",
  },
  {
    icon: ShieldCheck,
    title: "Admin & Audit",
    body: "Role-based access, full audit log, Azure-grade security and observability.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen brand-gradient">
      {/* Top nav */}
      <header className="sticky top-0 z-30 border-b border-gold/20 bg-ink-900/80 backdrop-blur-md">
        <div className="container flex h-16 items-center justify-between">
          <Logo />
          <nav className="hidden md:flex items-center gap-8 text-sm font-display tracking-wider">
            <a href="#features" className="text-foreground/80 hover:text-gold">Features</a>
            <a href="#why" className="text-foreground/80 hover:text-gold">Why BCC</a>
            <a href="https://bluecollarcoach.us" target="_blank" rel="noreferrer" className="text-foreground/80 hover:text-gold">
              Coaching
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/sign-in">Open the App</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="container py-20 lg:py-32">
        <div className="max-w-3xl">
          <p className="mb-4 inline-block text-xs font-bold uppercase tracking-[0.4em] text-gold">
            For owners of trade businesses
          </p>
          <h1 className="font-display text-4xl md:text-6xl lg:text-7xl font-bold leading-[1.05] tracking-tight">
            You built a business.
            <br />
            <span className="text-gold italic">Now run it like one.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-foreground/75 leading-relaxed">
            Blue Collar Coach <em>Connect</em> is the operations layer for HVAC, plumbing,
            electrical, landscaping, and construction shops — CRM, calendars, chat, time
            tracking, financials, and training, all in one place. Built on the
            BCC method of <span className="text-gold">clarity over motivation</span>.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/sign-in">Get clarity now</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#features">See what's inside</Link>
            </Button>
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Runs on Azure · Microsoft 365 sync · QuickBooks Online · SOC-friendly audit log
          </p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-gold/20 bg-ink-900/60">
        <div className="container py-20">
          <div className="mb-12 max-w-2xl">
            <h2 className="font-display text-3xl md:text-4xl font-bold">
              <span className="text-gold italic">Nine</span> tools your business already
              needs — finally in one place.
            </h2>
            <p className="mt-3 text-muted-foreground">
              Stop paying for six SaaS subscriptions that don't talk to each other.
              Stop running your business from a clipboard.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="group rounded-lg border border-border bg-card/60 p-6 transition hover:border-gold/40 hover:shadow-glow"
              >
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-md bg-gold/10 text-gold ring-1 ring-gold/30">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="font-display text-lg font-semibold text-foreground">
                  {title}
                </h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why BCC */}
      <section id="why" className="border-t border-gold/20">
        <div className="container py-20 text-center">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.4em] text-gold">
            The Blue Collar Coach difference
          </p>
          <blockquote className="mx-auto max-w-3xl font-display text-2xl md:text-3xl italic leading-relaxed text-foreground/90">
            “We don't sell motivation. We build the systems so the work you already
            do <span className="text-gold">actually adds up</span>.”
          </blockquote>
          <div className="mt-10">
            <Button asChild size="lg">
              <Link href="/sign-in">Open BCC Connect</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-ink-900">
        <div className="container py-10 flex flex-col gap-6 md:flex-row items-center justify-between text-xs text-muted-foreground">
          <Logo size={32} showWordmark />
          <div className="flex gap-6">
            <a href="https://bluecollarcoach.us" target="_blank" rel="noreferrer" className="hover:text-gold">
              bluecollarcoach.us
            </a>
            <Link href="/sign-in" className="hover:text-gold">Sign in</Link>
            <span>© {new Date().getFullYear()} Blue Collar Coach</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
