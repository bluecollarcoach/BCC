import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe Auth.js config. NO Prisma, NO Node-only imports here.
 * Used by middleware.ts (Edge runtime) and extended by lib/auth.ts (Node).
 */
export const authConfig: NextAuthConfig = {
  pages: { signIn: "/sign-in" },
  trustHost: true,
  // Providers filled in lib/auth.ts (they touch Prisma).
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isAuthed = !!auth?.user;
      const path = nextUrl.pathname;

      const PROTECTED = [
        "/dashboard", "/crm", "/time", "/chat", "/calendar",
        "/marketing", "/bookkeeping", "/documents", "/training",
        "/events", "/settings", "/admin",
      ];
      const isProtected = PROTECTED.some((p) => path.startsWith(p));

      if (!isProtected) return true;
      if (!isAuthed) return false;

      // /admin requires OWNER or ADMIN
      if (path.startsWith("/admin")) {
        const role = auth!.user!.role;
        return role === "OWNER" || role === "ADMIN";
      }
      return true;
    },
    async jwt({ token, user }) {
      // Stash the user id on first sign-in; full enrichment happens in lib/auth.ts.
      if (user?.id) token.userId = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token.userId && session.user) {
        session.user.id = token.userId as string;
        session.user.role = (token.role as string) ?? "STAFF";
        session.user.orgId = (token.orgId as string | null) ?? null;
      }
      return session;
    },
  },
};
