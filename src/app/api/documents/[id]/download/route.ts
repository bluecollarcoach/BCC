import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDownloadUrl } from "@/server/services/documents";

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
  const url = await getDownloadUrl(session.user.orgId, id);
  if (!url) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // 302 to short-lived SAS URL on the Blob endpoint.
  return NextResponse.redirect(url);
}
