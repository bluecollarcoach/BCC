import { NextResponse } from "next/server";
import { env, hasGoogleAdsConfigured } from "@/lib/env";
import { auth } from "@/lib/auth";

/**
 * Google Ads OAuth connect — STUB.
 *
 * Real flow:
 *   Redirect to https://accounts.google.com/o/oauth2/v2/auth with:
 *     client_id, redirect_uri, response_type=code, scope=https://www.googleapis.com/auth/adwords,
 *     access_type=offline, prompt=consent, state={signed_state}
 *   Then implement /callback to exchange code → tokens via
 *     POST https://oauth2.googleapis.com/token
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.redirect(new URL("/sign-in", env.NEXT_PUBLIC_APP_URL));
  }
  if (!hasGoogleAdsConfigured) {
    return NextResponse.redirect(
      new URL("/admin/integrations?notice=google-ads-not-configured", env.NEXT_PUBLIC_APP_URL),
    );
  }
  // Not yet implemented — return user to integrations with a friendly notice.
  return NextResponse.redirect(
    new URL("/admin/integrations?notice=google-ads-coming-soon", env.NEXT_PUBLIC_APP_URL),
  );
}
