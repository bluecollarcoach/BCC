import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./db";
import { env, hasEntraConfigured, isDevAuthBypass } from "./env";
import { logger } from "./logger";
import { authConfig } from "./auth.config";
import type { Role } from "@/types/enums";

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

const providerList = [
  ...(hasEntraConfigured
    ? [
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
      ]
    : []),
  ...(isDevAuthBypass
    ? [
        Credentials({
          id: "dev-bypass",
          name: "Dev (no password)",
          credentials: { email: { label: "Email", type: "email" } },
          async authorize(creds) {
            if (env.NODE_ENV === "production") return null;
            const email = (creds?.email as string)?.toLowerCase().trim();
            if (!email) return null;
            let user = await prisma.user.findUnique({ where: { email } });
            if (!user) {
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
      ]
    : []),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  secret: env.AUTH_SECRET,
  providers: providerList,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      // First sign-in stamps the user id
      if (user?.id) token.userId = user.id;
      // Always enrich from the DB so role/org changes propagate
      if (token.userId) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.userId as string },
          select: {
            role: true,
            orgId: true,
            email: true,
            name: true,
            image: true,
          },
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
      if (token.userId && session.user) {
        session.user.id = token.userId as string;
        session.user.role = (token.role as Role) ?? "STAFF";
        session.user.orgId = (token.orgId as string | null) ?? null;
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
});
