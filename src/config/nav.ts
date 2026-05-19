import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Calendar,
  MessageSquare,
  Clock,
  Megaphone,
  BookOpen,
  FileText,
  GraduationCap,
  CalendarDays,
  Calculator,
  Settings,
  ShieldCheck,
  Activity,
  Plug,
  UserCog,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
  description?: string;
  roles?: Array<"OWNER" | "ADMIN" | "COACH" | "STAFF" | "CUSTOMER">;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const APP_NAV: NavSection[] = [
  {
    label: "Workspace",
    items: [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: LayoutDashboard,
        description: "KPIs, alerts, and what needs your attention today.",
      },
      {
        label: "Calendar",
        href: "/calendar",
        icon: Calendar,
        description: "Synced with Microsoft 365.",
      },
      {
        label: "Chat",
        href: "/chat",
        icon: MessageSquare,
        description: "Real-time team + customer messaging.",
      },
      {
        label: "Time Tracking",
        href: "/time",
        icon: Clock,
        description: "Crew hours, job costing, payroll export.",
      },
    ],
  },
  {
    label: "Revenue",
    items: [
      {
        label: "CRM",
        href: "/crm",
        icon: Users,
        description: "Contacts, leads, deals, pipelines.",
      },
      {
        label: "Marketing",
        href: "/marketing",
        icon: Megaphone,
        description: "Campaigns, customer comms, reviews.",
      },
      {
        label: "Events",
        href: "/events",
        icon: CalendarDays,
        description: "Workshops, meetups, community events.",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        label: "Bookkeeping",
        href: "/bookkeeping",
        icon: Calculator,
        description: "QBO-synced financial KPIs.",
      },
      {
        label: "Documents",
        href: "/documents",
        icon: FileText,
        description: "Contracts, SOPs, customer files.",
      },
      {
        label: "Training",
        href: "/training",
        icon: GraduationCap,
        description: "Customer-facing courses & playbooks.",
      },
    ],
  },
];

export const ADMIN_NAV: NavSection[] = [
  {
    label: "Admin Center",
    items: [
      {
        label: "Overview",
        href: "/admin",
        icon: ShieldCheck,
      },
      {
        label: "Users & Roles",
        href: "/admin/users",
        icon: UserCog,
      },
      {
        label: "Audit Log",
        href: "/admin/audit",
        icon: Activity,
      },
      {
        label: "Integrations",
        href: "/admin/integrations",
        icon: Plug,
      },
      {
        label: "Settings",
        href: "/admin/settings",
        icon: Settings,
      },
      {
        label: "Knowledge Base",
        href: "/admin/kb",
        icon: BookOpen,
      },
    ],
  },
];
