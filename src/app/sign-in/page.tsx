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
    <div className="min-h-screen chrome-backdrop flex flex-col">
      <header className="container pt-8 flex items-center justify-between">
        <Logo onDark size={36} />
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/50">
          Internal · v0.1
        </span>
      </header>

      <main className="flex-1 grid place-items-center px-4">
        <div className="w-full max-w-md card-accent rounded-lg bg-card text-card-foreground p-8 shadow-card-lifted">
          <h1 className="text-3xl font-extrabold tracking-tightest">
            Sign in to BCC Internal.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Team workspace for coaches, staff, and customer-facing operations.
          </p>

          <SignInBody searchParamsPromise={searchParams} />
        </div>
      </main>

      <footer className="container py-6 text-center text-[11px] text-white/40">
        © {new Date().getFullYear()} Blue Collar Coach · Internal use only
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
            Continue with Microsoft 365
          </Button>
        </form>
      )}

      {isDevAuthBypass && (
        <>
          {hasEntraConfigured && (
            <div className="flex items-center gap-3 my-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or for development
              <span className="h-px flex-1 bg-border" />
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
                placeholder="you@bluecollarcoach.us"
                className="mt-1.5"
              />
            </div>
            <Button type="submit" variant="outline" className="w-full">
              Sign in (dev)
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Dev bypass is enabled. Disable by setting{" "}
              <code className="font-mono text-foreground">DEV_AUTH_BYPASS=false</code>{" "}
              before deploying to production.
            </p>
          </form>
        </>
      )}

      {!hasEntraConfigured && !isDevAuthBypass && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-sm">
          <strong>No auth providers configured.</strong> Set Microsoft Entra
          credentials in <code>.env</code> or enable{" "}
          <code>DEV_AUTH_BYPASS=true</code> for local development.
        </div>
      )}
    </div>
  );
}
