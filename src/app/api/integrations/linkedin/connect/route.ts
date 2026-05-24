import { NextResponse } from "next/server";
import { env, hasLinkedInConfigured } from "@/lib/env";
import { auth } from "@/lib/auth";

/**
 * LinkedIn OAuth connect — STUB.
 *
 * Real flow:
 *   Redirect to https://www.linkedin.com/oauth/v2/authorization with:
 *     response_type=code, client_id, redirect_uri, state, scope
 *   Then implement /callback to POST to https://www.linkedin.com/oauth/v2/accessToken
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.redirect(new URL("/sign-in", env.NEXT_PUBLIC_APP_URL));
  }
  if (!hasLinkedInConfigured) {
    return NextResponse.redirect(
      new URL("/admin/integrations?notice=linkedin-not-configured", env.NEXT_PUBLIC_APP_URL),
    );
  }
  return NextResponse.redirect(
    new URL("/admin/integrations?notice=linkedin-coming-soon", env.NEXT_PUBLIC_APP_URL),
  );
}
