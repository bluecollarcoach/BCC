import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("Blue Collar Coach Connect"),

  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z.string().min(1).default("dev-secret-change-in-production"),
  AUTH_TRUST_HOST: z.string().optional(),
  DEV_AUTH_BYPASS: z.string().optional(),

  AUTH_MICROSOFT_ENTRA_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_TENANT_ID: z.string().default("common"),

  QBO_CLIENT_ID: z.string().optional(),
  QBO_CLIENT_SECRET: z.string().optional(),
  QBO_REDIRECT_URI: z.string().optional(),
  QBO_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),

  SIGNALR_CONNECTION_STRING: z.string().optional(),

  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),
  NEXT_PUBLIC_APPINSIGHTS_CONNECTION_STRING: z.string().optional(),

  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_CONTAINER_DOCS: z.string().default("bcc-docs"),

  ACS_CONNECTION_STRING: z.string().optional(),
  EMAIL_FROM: z.string().default("Blue Collar Coach <no-reply@bluecollarcoach.us>"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

export const isDevAuthBypass = env.DEV_AUTH_BYPASS === "true";
export const hasEntraConfigured = !!(
  env.AUTH_MICROSOFT_ENTRA_ID && env.AUTH_MICROSOFT_ENTRA_SECRET
);
export const hasQboConfigured = !!(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET);
export const hasAppInsights = !!env.APPLICATIONINSIGHTS_CONNECTION_STRING;
export const hasAzureBlob = !!env.AZURE_STORAGE_CONNECTION_STRING;
export const hasRealtime = !!env.SIGNALR_CONNECTION_STRING;
