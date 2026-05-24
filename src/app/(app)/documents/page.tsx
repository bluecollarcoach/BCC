import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import {
  listDocuments,
  listFolders,
  uploadDocument,
  deleteDocument,
} from "@/server/services/documents";
import { hasAzureBlob } from "@/lib/env";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FileText, Folder, Search, Upload, Trash2, Download } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { revalidatePath } from "next/cache";

export const metadata = { title: "Documents" };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; folder?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) redirect("/sign-in");
  const sp = await searchParams;

  const [docs, folders] = await Promise.all([
    listDocuments(session.user.orgId, { q: sp.q, folder: sp.folder }),
    listFolders(session.user.orgId),
  ]);

  async function upload(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return;
    await uploadDocument(s.user.orgId, s.user.id, {
      file,
      folder: String(fd.get("folder") ?? "/") || "/",
      tags: String(fd.get("tags") ?? "") || undefined,
    });
    revalidatePath("/documents");
  }

  async function remove(fd: FormData) {
    "use server";
    const s = await auth();
    if (!s?.user?.orgId) return;
    const id = String(fd.get("id") ?? "");
    if (!id) return;
    await deleteDocument(s.user.orgId, s.user.id, id);
    revalidatePath("/documents");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description={`${docs.length} file${docs.length === 1 ? "" : "s"} · contracts, SOPs, customer files`}
        actions={
          <Badge variant={hasAzureBlob ? "success" : "muted"}>
            {hasAzureBlob ? "Storage connected" : "Storage not configured"}
          </Badge>
        }
      />

      {!hasAzureBlob && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            Azure Blob Storage isn't connected. Set
            <code className="mx-1 bg-muted px-1 rounded">AZURE_STORAGE_CONNECTION_STRING</code>
            in App Service config to enable uploads.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <Card>
          <CardContent className="py-4 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground px-2 pb-2">
              Folders
            </div>
            <Link
              href="/documents"
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                !sp.folder ? "bg-muted text-foreground" : "hover:bg-muted"
              }`}
            >
              <Folder className="h-4 w-4 text-amber-700" />
              All folders
            </Link>
            {folders.length === 0 && (
              <p className="text-xs text-muted-foreground italic px-2 pt-1">
                Uploads default to <code>/</code>. Set the folder field when uploading to organize.
              </p>
            )}
            {folders.map((f) => (
              <Link
                key={f}
                href={`/documents?folder=${encodeURIComponent(f)}`}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                  sp.folder === f ? "bg-muted text-foreground" : "hover:bg-muted"
                }`}
              >
                <Folder className="h-4 w-4 text-amber-700" />
                <span className="truncate">{f}</span>
              </Link>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Upload a file</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                action={upload}
                encType="multipart/form-data"
                className="grid gap-3 sm:grid-cols-[1fr_220px_220px_auto]"
              >
                <div>
                  <Label htmlFor="file">File (max 25MB)</Label>
                  <Input
                    id="file"
                    name="file"
                    type="file"
                    required
                    disabled={!hasAzureBlob}
                    className="mt-1.5 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-semibold"
                  />
                </div>
                <div>
                  <Label htmlFor="folder">Folder</Label>
                  <Input
                    id="folder"
                    name="folder"
                    defaultValue={sp.folder ?? "/"}
                    placeholder="/contracts"
                    disabled={!hasAzureBlob}
                    className="mt-1.5"
                  />
                </div>
                <div>
                  <Label htmlFor="tags">Tags</Label>
                  <Input
                    id="tags"
                    name="tags"
                    placeholder="hvac, signed"
                    disabled={!hasAzureBlob}
                    className="mt-1.5"
                  />
                </div>
                <div className="flex items-end">
                  <Button type="submit" disabled={!hasAzureBlob}>
                    <Upload className="h-4 w-4" /> Upload
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <form
                action="/documents"
                className="mb-4 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2"
              >
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  name="q"
                  defaultValue={sp.q ?? ""}
                  placeholder="Search by filename or tag…"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                {sp.folder && <input type="hidden" name="folder" value={sp.folder} />}
                <Button type="submit" size="sm" variant="ghost">Search</Button>
              </form>

              {docs.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title={sp.q || sp.folder ? "No matches" : "No documents yet"}
                  description={
                    hasAzureBlob
                      ? "Upload your first file above. Contracts, SOPs, photos, anything ≤ 25MB."
                      : "Once Azure Blob is configured, uploads will appear here."
                  }
                />
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 font-semibold">Name</th>
                      <th className="py-2 font-semibold hidden md:table-cell">Folder</th>
                      <th className="py-2 font-semibold hidden lg:table-cell">Tags</th>
                      <th className="py-2 font-semibold hidden lg:table-cell">Uploaded</th>
                      <th className="py-2 font-semibold text-right">Size</th>
                      <th className="py-2 font-semibold"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {docs.map((d) => (
                      <tr key={d.id} className="hover:bg-muted/30">
                        <td className="py-3 flex items-center gap-2">
                          <FileText className="h-4 w-4 text-amber-700" />
                          <a
                            href={`/api/documents/${d.id}/download`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-amber-700"
                          >
                            {d.name}
                          </a>
                        </td>
                        <td className="py-3 hidden md:table-cell text-muted-foreground">
                          {d.folder}
                        </td>
                        <td className="py-3 hidden lg:table-cell text-muted-foreground text-xs">
                          {d.tags ?? "—"}
                        </td>
                        <td className="py-3 hidden lg:table-cell text-xs text-muted-foreground">
                          {formatDate(d.createdAt)}
                          {d.uploader?.name && (
                            <div className="text-[10px]">{d.uploader.name}</div>
                          )}
                        </td>
                        <td className="py-3 text-right tabular-nums text-muted-foreground">
                          {formatSize(d.sizeBytes)}
                        </td>
                        <td className="py-3 text-right">
                          <div className="inline-flex gap-1">
                            <Button asChild size="sm" variant="ghost">
                              <a
                                href={`/api/documents/${d.id}/download`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <Download className="h-3.5 w-3.5" />
                              </a>
                            </Button>
                            <form action={remove}>
                              <input type="hidden" name="id" value={d.id} />
                              <Button
                                type="submit"
                                size="sm"
                                variant="ghost"
                                className="text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </form>
                          </div>
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
    </div>
  );
}
