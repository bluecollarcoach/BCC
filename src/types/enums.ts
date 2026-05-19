/**
 * Application-level enum unions.
 *
 * Prisma + SQLite doesn't support DB-level enums (Azure SQL/Postgres do).
 * We model these as `String` columns in the schema and keep type-safety here.
 * If/when we migrate the prod DB, we can swap these for Prisma-generated enums.
 */

export const ROLES = ["OWNER", "ADMIN", "COACH", "STAFF", "CUSTOMER"] as const;
export type Role = (typeof ROLES)[number];

export const CONTACT_STAGES = ["LEAD", "QUALIFIED", "CUSTOMER", "CHURNED"] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];

export const DEAL_STATUSES = ["OPEN", "WON", "LOST"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const ACTIVITY_TYPES = ["CALL", "EMAIL", "MEETING", "NOTE", "TASK"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const TIME_ENTRY_STATUSES = [
  "RUNNING",
  "STOPPED",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

export const CHANNEL_KINDS = ["PUBLIC", "PRIVATE", "DM", "CUSTOMER"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CAMPAIGN_CHANNELS = [
  "EMAIL",
  "SMS",
  "SOCIAL",
  "PRINT",
  "REVIEW_REQUEST",
] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "RUNNING",
  "COMPLETED",
  "PAUSED",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const INTEGRATION_PROVIDERS = [
  "MICROSOFT_GRAPH",
  "QBO",
  "SIGNALR",
  "STRIPE",
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
