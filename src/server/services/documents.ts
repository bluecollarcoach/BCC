import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  uploadBlob,
  downloadSasUrl,
  deleteBlob,
} from "@/integrations/blob/client";
import { hasAzureBlob } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface UploadInput {
  file: File;
  folder?: string;
  tags?: string;
  contactId?: string;
  dealId?: string;
}

const MAX_BYTES = 25 * 1024 * 1024; // 25MB
const ALLOWED_PREFIXES = ["/", "/contracts", "/sops", "/customers", "/finance", "/training", "/photos"];

function safeFolder(input?: string): string {
  if (!input) return "/";
  const trimmed = input.startsWith("/") ? input : `/${input}`;
  return trimmed.replace(/\.\./g, "").slice(0, 200) || "/";
}

function safeFilename(name: string): string {
  // Strip path separators, allow common file chars
  return name.replace(/[/\\:*?"<>|]+/g, "_").slice(0, 200) || "file";
}

function buildStorageKey(orgId: string, folder: string, name: string): string {
  const stamp = Date.now().toString(36);
  const safe = safeFilename(name);
  const f = folder === "/" ? "" : folder.replace(/^\//, "").replace(/\/$/, "") + "/";
  return `${orgId}/${f}${stamp}-${safe}`;
}

export async function uploadDocument(
  orgId: string,
  userId: string,
  input: UploadInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!hasAzureBlob) {
    return { ok: false, error: "Azure Blob Storage isn't configured on this deployment." };
  }
  const { file } = input;
  if (!file || !(file instanceof File)) {
    return { ok: false, error: "No file provided." };
  }
  if (file.size === 0) {
    return { ok: false, error: "File is empty." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `File too large (max ${Math.floor(MAX_BYTES / 1024 / 1024)}MB).` };
  }
  const folder = safeFolder(input.folder);
  const filename = safeFilename(file.name);
  const storageKey = buildStorageKey(orgId, folder, filename);

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadBlob(storageKey, buffer, file.type || "application/octet-stream");
  } catch (err) {
    logger.error("documents.uploadBlob.failed", {
      err: err instanceof Error ? err.message : String(err),
      orgId,
      storageKey,
    });
    return { ok: false, error: "Upload to storage failed. Try again." };
  }

  const doc = await prisma.document.create({
    data: {
      orgId,
      uploaderId: userId,
      name: filename,
      folder,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      storageKey,
      tags: input.tags || null,
      contactId: input.contactId || null,
      dealId: input.dealId || null,
    },
  });
  await audit({
    action: "document.upload",
    orgId,
    actorId: userId,
    targetType: "Document",
    targetId: doc.id,
    diff: { name: filename, sizeBytes: file.size, folder },
  });
  return { ok: true, id: doc.id };
}

export async function listDocuments(
  orgId: string,
  opts?: { folder?: string; q?: string; contactId?: string; dealId?: string },
) {
  return prisma.document.findMany({
    where: {
      orgId,
      ...(opts?.folder ? { folder: opts.folder } : {}),
      ...(opts?.contactId ? { contactId: opts.contactId } : {}),
      ...(opts?.dealId ? { dealId: opts.dealId } : {}),
      ...(opts?.q
        ? {
            OR: [
              { name: { contains: opts.q } },
              { tags: { contains: opts.q } },
            ],
          }
        : {}),
    },
    include: { uploader: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
}

export async function listFolders(orgId: string) {
  const rows = await prisma.document.findMany({
    where: { orgId },
    select: { folder: true },
    distinct: ["folder"],
  });
  return rows.map((r) => r.folder).sort();
}

export async function getDocument(orgId: string, id: string) {
  return prisma.document.findFirst({
    where: { id, orgId },
    include: { uploader: { select: { name: true } } },
  });
}

export async function getDownloadUrl(orgId: string, id: string): Promise<string | null> {
  const doc = await getDocument(orgId, id);
  if (!doc) return null;
  try {
    return downloadSasUrl(doc.storageKey, doc.name);
  } catch (err) {
    logger.error("documents.downloadSasUrl.failed", {
      err: err instanceof Error ? err.message : String(err),
      docId: id,
    });
    return null;
  }
}

export async function deleteDocument(orgId: string, userId: string, id: string) {
  const doc = await getDocument(orgId, id);
  if (!doc) return;
  try {
    await deleteBlob(doc.storageKey);
  } catch (err) {
    logger.warn("documents.deleteBlob.failed", {
      err: err instanceof Error ? err.message : String(err),
      docId: id,
    });
    // Continue — we still want to remove the DB row.
  }
  await prisma.document.delete({ where: { id, orgId } });
  await audit({
    action: "document.delete",
    orgId,
    actorId: userId,
    targetType: "Document",
    targetId: id,
  });
}

export { ALLOWED_PREFIXES, MAX_BYTES };
