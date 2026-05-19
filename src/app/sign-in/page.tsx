import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { signIn } from "@/lib/auth";
import { hasEntraConfigured, isDevAuthBypass } from "@/lib/env";

export const metadata = { title: "Sign in" };

export default function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  return (
    <div className="min-h-screen brand-gradient flex flex-col">
      <header className="container pt-8">
        <Link href="/">
          <Logo size={36} />
        </Link>
      </header>

      <main className="flex-1 grid place-items-center px-4">
        <div className="w-full max-w-md rounded-lg border border-gold/30 bg-card/80 backdrop-blur-md p-8 shadow-glow">
          <h1 className="font-display text-3xl">
            Welcome <span className="text-gold italic">back</span>
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to your Blue Collar Coach Connect workspace.
          </p>

          <SignInBody searchParamsPromise={searchParams} />
        </div>
      </main>

      <footer className="container py-6 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} Blue Collar Coach · bluecollarcoach.us
      </footer>
    </div>
  );
}

async function SignInBody({
  searchParamsPromise,
}: {
  searchParamsPromise: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const sp = await searchParamsPromise;
  const callbackUrl = sp.callbackUrl ?? "/dashboard";

  return (
    <div className="mt-6 space-y-4">
      {sp.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Sign in failed: {sp.error}
        </div>
      )}

      {hasEntraConfigured && (
        <form
          action={async () => {
            "use server";
            await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
          }}
        >
          <Button type="submit" className="w-full" size="lg">
            Continue with Microsoft
          </Button>
        </form>
      )}

      {isDevAuthBypass && (
        <>
          {hasEntraConfigured && (
            <div className="relative my-2 text-center">
              <span className="bg-card px-2 text-xs uppercase tracking-wider text-muted-foreground">
                or for development
              </span>
            </div>
          )}
          <form
            action={async (fd: FormData) => {
              "use server";
              await signIn("dev-bypass", {
                email: String(fd.get("email") ?? ""),
                redirectTo: callbackUrl,
              });
            }}
            className="space-y-3"
          >
            <div>
              <Label htmlFor="email">Email (dev bypass)</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                placeholder="owner@bluecollarcoach.us"
                className="mt-1.5"
              />
            </div>
            <Button type="submit" variant="outline" className="w-full">
              Sign in (dev)
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Dev bypass is enabled. Disable by setting <code>DEV_AUTH_BYPASS=false</code> in production.
            </p>
          </form>
        </>
      )}

      {!hasEntraConfigured && !isDevAuthBypass && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-sm">
          <strong>No auth providers configured.</strong> Set Microsoft Entra credentials
          in <code>.env</code> or enable <code>DEV_AUTH_BYPASS=true</code> for local development.
        </div>
      )}
    </div>
  );
}
