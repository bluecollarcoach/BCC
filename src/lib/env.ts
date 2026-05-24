import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("BCC Internal"),

  DATABASE_URL: z.string().min(1),

  AUTH_SECRET: z.string().min(1).default("dev-secret-change-in-production"),
  AUTH_TRUST_HOST: z.string().optional(),
  DEV_AUTH_BYPASS: z.string().optional(),

  // --- Microsoft Entra (auth + Graph) ---
  AUTH_MICROSOFT_ENTRA_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_TENANT_ID: z.string().default("common"),

  // --- QuickBooks Online ---
  QBO_CLIENT_ID: z.string().optional(),
  QBO_CLIENT_SECRET: z.string().optional(),
  QBO_REDIRECT_URI: z.string().optional(),
  QBO_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),

  // --- Google Ads ---
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_REDIRECT_URI: z.string().optional(),

  // --- LinkedIn ---
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_REDIRECT_URI: z.string().optional(),

  // --- Meta (Facebook + Instagram) ---
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),
  META_API_VERSION: z.string().default("v19.0"),

  // --- Realtime ---
  SIGNALR_CONNECTION_STRING: z.string().optional(),

  // --- Telemetry ---
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().optional(),
  NEXT_PUBLIC_APPINSIGHTS_CONNECTION_STRING: z.string().optional(),

  // --- Azure Blob ---
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_CONTAINER_DOCS: z.string().default("bcc-docs"),

  // --- Email ---
  ACS_CONNECTION_STRING: z.string().optional(),
  EMAIL_FROM: z.string().default("BCC Internal <no-reply@bluecollarcoach.us>"),
});

// During `next build`, Next.js imports every route module to collect metadata.
// If env vars aren't set in CI we still want the build to finish so we can
// deploy and then set them — the runtime will fail clearly the first time a
// route actually touches the missing var. Only crash hard at runtime.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  if (isBuildPhase) {
    console.warn(
      "⚠️  env: validation failed during build (this is OK if you'll set the vars before the runtime starts):",
      parsed.error.flatten().fieldErrors,
    );
  } else {
    console.error("❌ Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
}

// At runtime (NEXT_PHASE !== build), parsed.success is guaranteed true here.
// During build, we fall back to a lenient object so static analysis can finish.
export const env = parsed.success
  ? parsed.data
  : (process.env as unknown as z.infer<typeof schema>);

export const isDevAuthBypass = env.DEV_AUTH_BYPASS === "true";
export const hasEntraConfigured = !!(
  env.AUTH_MICROSOFT_ENTRA_ID && env.AUTH_MICROSOFT_ENTRA_SECRET
);
export const hasQboConfigured = !!(env.QBO_CLIENT_ID && env.QBO_CLIENT_SECRET);
export const hasGoogleAdsConfigured = !!(
  env.GOOGLE_ADS_CLIENT_ID &&
  env.GOOGLE_ADS_CLIENT_SECRET &&
  env.GOOGLE_ADS_DEVELOPER_TOKEN
);
export const hasLinkedInConfigured = !!(
  env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET
);
export const hasMetaConfigured = !!(env.META_APP_ID && env.META_APP_SECRET);
export const hasAppInsights = !!env.APPLICATIONINSIGHTS_CONNECTION_STRING;
export const hasAzureBlob = !!env.AZURE_STORAGE_CONNECTION_STRING;
export const hasRealtime = !!env.SIGNALR_CONNECTION_STRING;
