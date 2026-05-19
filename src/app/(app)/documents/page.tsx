import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FileText, Upload, Folder, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";

export const metadata = { title: "Documents" };

export default async function DocumentsPage() {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");

  const docs = await prisma.document.findMany({
    where: { orgId: session.user.orgId },
    include: { uploader: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const folders = Array.from(new Set(docs.map((d) => d.folder)));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Contracts, SOPs, customer files, and certifications. Stored in Azure Blob."
        actions={
          <Button>
            <Upload className="h-4 w-4" /> Upload
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <Card>
          <CardContent className="py-4 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground px-2 pb-2">
              Folders
            </div>
            {folders.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">No folders yet.</p>
            )}
            {folders.map((f) => (
              <div
                key={f}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
              >
                <Folder className="h-4 w-4 text-gold" />
                <span className="truncate">{f}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4">
            <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                placeholder="Search files…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>

            {docs.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No documents yet"
                description="Upload contracts, SOPs, training materials, or customer files. Drag-and-drop coming soon."
                action={
                  <Button>
                    <Upload className="h-4 w-4" /> Upload your first file
                  </Button>
                }
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="py-2 font-semibold">Name</th>
                    <th className="py-2 font-semibold hidden md:table-cell">Folder</th>
                    <th className="py-2 font-semibold hidden lg:table-cell">Uploaded by</th>
                    <th className="py-2 font-semibold hidden lg:table-cell">Date</th>
                    <th className="py-2 font-semibold text-right">Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {docs.map((d) => (
                    <tr key={d.id} className="hover:bg-muted/30">
                      <td className="py-3 flex items-center gap-2">
                        <FileText className="h-4 w-4 text-gold" />
                        <span>{d.name}</span>
                      </td>
                      <td className="py-3 hidden md:table-cell text-muted-foreground">{d.folder}</td>
                      <td className="py-3 hidden lg:table-cell text-muted-foreground">
                        {d.uploader.name ?? "—"}
                      </td>
                      <td className="py-3 hidden lg:table-cell text-xs text-muted-foreground">
                        {formatDate(d.createdAt)}
                      </td>
                      <td className="py-3 text-right tabular-nums text-muted-foreground">
                        {(d.sizeBytes / 1024).toFixed(0)} KB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
