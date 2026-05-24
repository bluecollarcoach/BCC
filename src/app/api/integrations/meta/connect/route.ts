import { NextResponse } from "next/server";
import { env, hasMetaConfigured } from "@/lib/env";
import { auth } from "@/lib/auth";

/**
 * Meta (Facebook + Instagram) OAuth connect — STUB.
 *
 * Real flow:
 *   Redirect to https://www.facebook.com/v19.0/dialog/oauth with:
 *     client_id, redirect_uri, state, scope
 *   Then exchange via GET https://graph.facebook.com/v19.0/oauth/access_token
 *   Exchange short-lived → long-lived token via fb_exchange_token grant.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.redirect(new URL("/sign-in", env.NEXT_PUBLIC_APP_URL));
  }
  if (!hasMetaConfigured) {
    return NextResponse.redirect(
      new URL("/admin/integrations?notice=meta-not-configured", env.NEXT_PUBLIC_APP_URL),
    );
  }
  return NextResponse.redirect(
    new URL("/admin/integrations?notice=meta-coming-soon", env.NEXT_PUBLIC_APP_URL),
  );
}
