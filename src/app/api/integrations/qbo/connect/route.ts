import { NextResponse } from "next/server";
import { env, hasQboConfigured } from "@/lib/env";
import { auth } from "@/lib/auth";

/**
 * QBO OAuth2 connect — STUB.
 *
 * Real flow:
 *   1. Redirect user to:
 *      https://appcenter.intuit.com/connect/oauth2?
 *        client_id={QBO_CLIENT_ID}
 *        &scope=com.intuit.quickbooks.accounting
 *        &redirect_uri={QBO_REDIRECT_URI}
 *        &response_type=code
 *        &state={signed_state}
 *   2. Intuit redirects back to /api/integrations/qbo/callback with code + realmId.
 *   3. POST to https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer to exchange.
 *   4. Persist tokens to the Integration row.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.redirect(new URL("/sign-in", env.NEXT_PUBLIC_APP_URL));
  }
  if (!hasQboConfigured) {
    return NextResponse.json(
      { error: "QBO not configured. Set QBO_CLIENT_ID / QBO_CLIENT_SECRET in env." },
      { status: 400 },
    );
  }
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id", env.QBO_CLIENT_ID!);
  url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  url.searchParams.set("redirect_uri", env.QBO_REDIRECT_URI ?? `${env.NEXT_PUBLIC_APP_URL}/api/integrations/qbo/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", session.user.orgId);
  return NextResponse.redirect(url);
}
