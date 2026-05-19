import NextAuth, { type NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./db";
import { env, hasEntraConfigured, isDevAuthBypass } from "./env";
import { logger } from "./logger";
import type { Role } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      role: Role;
      orgId?: string | null;
    };
  }
}

const providers: NextAuthConfig["providers"] = [];

if (hasEntraConfigured) {
  providers.push(
    MicrosoftEntraID({
      clientId: env.AUTH_MICROSOFT_ENTRA_ID!,
      clientSecret: env.AUTH_MICROSOFT_ENTRA_SECRET!,
      issuer: `https://login.microsoftonline.com/${env.AUTH_MICROSOFT_ENTRA_TENANT_ID}/v2.0`,
      authorization: {
        params: {
          scope:
            "openid profile email offline_access User.Read Calendars.ReadWrite Mail.Send",
        },
      },
    }),
  );
}

// Dev bypass: type the user's email and you're in. Auto-creates the user.
// NEVER ship this enabled to production.
if (isDevAuthBypass) {
  providers.push(
    Credentials({
      id: "dev-bypass",
      name: "Dev (no password)",
      credentials: {
        email: { label: "Email", type: "email" },
      },
      async authorize(creds) {
        if (env.NODE_ENV === "production") return null;
        const email = (creds?.email as string)?.toLowerCase().trim();
        if (!email) return null;
        let user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          // Bootstrap: first user in dev becomes OWNER.
          const count = await prisma.user.count();
          user = await prisma.user.create({
            data: {
              email,
              name: email.split("@")[0],
              role: count === 0 ? "OWNER" : "STAFF",
            },
          });
          logger.info("auth.devbypass.usercreated", { userId: user.id });
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  );
}

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  secret: env.AUTH_SECRET,
  trustHost: true,
  providers,
  pages: {
    signIn: "/sign-in",
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        token.userId = user.id;
      }
      if (token.userId) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.userId as string },
          select: { role: true, orgId: true, email: true, name: true, image: true },
        });
        if (dbUser) {
          token.role = dbUser.role;
          token.orgId = dbUser.orgId;
          token.email = dbUser.email;
          token.name = dbUser.name;
          token.picture = dbUser.image;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId) {
        session.user = {
          ...session.user,
          id: token.userId as string,
          role: (token.role as Role) ?? "STAFF",
          orgId: (token.orgId as string | null) ?? null,
        };
      }
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      logger.event("auth.signin", { userId: user.id });
    },
    async signOut() {
      logger.event("auth.signout");
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
