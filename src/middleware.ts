import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth.config";

// Use ONLY the edge-safe config in middleware. Importing @/lib/auth here
// would pull Prisma + Application Insights into the Edge bundle and fail.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const PROTECTED = [
    "/dashboard", "/crm", "/time", "/chat", "/calendar",
    "/marketing", "/bookkeeping", "/documents", "/training",
    "/events", "/settings", "/admin",
  ];
  const isProtected = PROTECTED.some((p) => pathname.startsWith(p));

  if (isProtected && !req.auth) {
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
    "/((?!_next/static|_next/image|favicon.ico|api/auth|api/health|.*\\..*).*)",
  ],
};
