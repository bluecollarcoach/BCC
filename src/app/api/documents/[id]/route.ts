import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deleteDocument, getDocument } from "@/server/services/documents";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const doc = await getDocument(session.user.orgId, id);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    id: doc.id,
    name: doc.name,
    folder: doc.folder,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    createdAt: doc.createdAt,
    uploader: doc.uploader?.name ?? null,
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  await deleteDocument(session.user.orgId, session.user.id, id);
  return NextResponse.json({ ok: true });
}
