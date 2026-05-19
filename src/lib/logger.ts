/**
 * Logger that writes to:
 *   - Azure Application Insights (when APPLICATIONINSIGHTS_CONNECTION_STRING is set)
 *   - console (always)
 *
 * Use anywhere in server code:
 *   import { logger } from "@/lib/logger";
 *   logger.info("contact.created", { contactId });
 *   logger.error("qbo.sync.failed", { orgId, err });
 */
import { env, hasAppInsights } from "./env";

type LogLevel = "debug" | "info" | "warn" | "error";

interface AppInsightsClient {
  trackTrace: (telemetry: { message: string; severity?: number; properties?: Record<string, unknown> }) => void;
  trackException: (telemetry: { exception: Error; properties?: Record<string, unknown> }) => void;
  trackEvent: (telemetry: { name: string; properties?: Record<string, unknown> }) => void;
  flush: () => void;
}

let aiClient: AppInsightsClient | null = null;
let aiInitPromise: Promise<void> | null = null;

async function initAppInsights() {
  if (!hasAppInsights || typeof window !== "undefined") return;
  if (aiInitPromise) return aiInitPromise;

  aiInitPromise = (async () => {
    try {
      const appInsights = await import("applicationinsights");
      appInsights
        .setup(env.APPLICATIONINSIGHTS_CONNECTION_STRING)
        .setAutoCollectConsole(false, false)
        .setAutoCollectExceptions(true)
        .setAutoCollectRequests(true)
        .setAutoCollectDependencies(true)
        .setSendLiveMetrics(false)
        .start();
      aiClient = appInsights.defaultClient as unknown as AppInsightsClient;
    } catch (e) {
      // App Insights is optional — log to console only.
      // eslint-disable-next-line no-console
      console.warn("[logger] App Insights init failed, falling back to console:", e);
    }
  })();
  return aiInitPromise;
}

void initAppInsights();

const SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function emit(level: LogLevel, message: string, props?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](
    `[${ts}] [${level.toUpperCase()}] ${message}`,
    props ?? "",
  );

  if (aiClient) {
    if (level === "error" && props?.err instanceof Error) {
      aiClient.trackException({ exception: props.err, properties: { message, ...props } });
    } else {
      aiClient.trackTrace({
        message,
        severity: SEVERITY[level],
        properties: props,
      });
    }
  }
}

export const logger = {
  debug: (msg: string, props?: Record<string, unknown>) => emit("debug", msg, props),
  info: (msg: string, props?: Record<string, unknown>) => emit("info", msg, props),
  warn: (msg: string, props?: Record<string, unknown>) => emit("warn", msg, props),
  error: (msg: string, props?: Record<string, unknown>) => emit("error", msg, props),
  event: (name: string, props?: Record<string, unknown>) => {
    emit("info", `event:${name}`, props);
    aiClient?.trackEvent({ name, properties: props });
  },
};
