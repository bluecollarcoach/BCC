import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { uploadDocument } from "@/server/services/documents";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Next.js App Router defaults to 1MB body limit for route handlers; bump it
// via the experimental.serverActions.bodySizeLimit in next.config (already 10MB).
// For document uploads specifically we cap at 25MB inside the service.
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing 'file' field" },
        { status: 400 },
      );
    }
    const result = await uploadDocument(session.user.orgId, session.user.id, {
      file,
      folder: (form.get("folder") as string) || "/",
      tags: (form.get("tags") as string) || undefined,
      contactId: (form.get("contactId") as string) || undefined,
      dealId: (form.get("dealId") as string) || undefined,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ id: result.id });
  } catch (err) {
    logger.error("api.documents.upload.failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Internal error during upload" },
      { status: 500 },
    );
  }
}
