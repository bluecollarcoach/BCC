import type { Role } from "@prisma/client";

/**
 * Centralised role-based access checks. Add capabilities (not role checks)
 * throughout the codebase; mappings live here.
 */
export type Capability =
  | "admin.access"
  | "users.manage"
  | "audit.view"
  | "integrations.manage"
  | "crm.read"
  | "crm.write"
  | "deals.manage"
  | "time.read.any"
  | "time.write.any"
  | "time.approve"
  | "bookkeeping.view"
  | "campaigns.manage"
  | "documents.delete"
  | "training.author"
  | "events.manage";

const MATRIX: Record<Role, Capability[]> = {
  OWNER: [
    "admin.access", "users.manage", "audit.view", "integrations.manage",
    "crm.read", "crm.write", "deals.manage",
    "time.read.any", "time.write.any", "time.approve",
    "bookkeeping.view", "campaigns.manage", "documents.delete",
    "training.author", "events.manage",
  ],
  ADMIN: [
    "admin.access", "users.manage", "audit.view", "integrations.manage",
    "crm.read", "crm.write", "deals.manage",
    "time.read.any", "time.approve",
    "bookkeeping.view", "campaigns.manage", "documents.delete",
    "training.author", "events.manage",
  ],
  COACH: [
    "crm.read", "crm.write", "deals.manage",
    "time.read.any", "bookkeeping.view",
    "campaigns.manage", "training.author", "events.manage",
  ],
  STAFF: ["crm.read", "deals.manage"],
  CUSTOMER: [],
};

export function can(role: Role | undefined | null, cap: Capability): boolean {
  if (!role) return false;
  return MATRIX[role]?.includes(cap) ?? false;
}

export function requireCap(role: Role | undefined | null, cap: Capability) {
  if (!can(role, cap)) {
    const err = new Error(`Forbidden: missing capability ${cap}`);
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}
