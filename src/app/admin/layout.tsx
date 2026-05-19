import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { BottomNav } from "@/components/app-shell/bottom-nav";
import { ADMIN_NAV } from "@/config/nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/sign-in");
  if (session.user.role !== "OWNER" && session.user.role !== "ADMIN") {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar sections={ADMIN_NAV} isAdmin />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar user={session.user} />
        <main className="flex-1 overflow-y-auto pb-20 lg:pb-0">
          <div className="container py-6 lg:py-8 animate-fade-in">{children}</div>
        </main>
        <BottomNav />
      </div>
    </div>
  );
}
