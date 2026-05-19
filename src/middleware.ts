import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Protect /dashboard, /crm, /time, /chat, /calendar, /marketing,
// /bookkeeping, /documents, /training, /events, /settings, /admin.
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/crm",
  "/time",
  "/chat",
  "/calendar",
  "/marketing",
  "/bookkeeping",
  "/documents",
  "/training",
  "/events",
  "/settings",
  "/admin",
];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const protectedRoute = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (protectedRoute && !req.auth) {
    const url = new URL("/sign-in", req.url);
    url.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname.startsWith("/admin") && req.auth) {
    const role = req.auth.user?.role;
    if (role !== "OWNER" && role !== "ADMIN") {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
  }
  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match all paths except static files, _next, and api routes that handle their own auth.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/auth|api/health|.*\\..*).*)",
  ],
};
