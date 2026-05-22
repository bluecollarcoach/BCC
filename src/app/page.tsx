import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/**
 * Internal app — no public marketing page. Bounce straight to the right
 * destination based on session state.
 */
export default async function IndexPage() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }
  redirect("/sign-in");
}
