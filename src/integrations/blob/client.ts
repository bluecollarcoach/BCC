import {
  BlobServiceClient,
  ContainerClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { env, hasAzureBlob } from "@/lib/env";

/**
 * Azure Blob Storage client. Lazy-initialised from the connection string.
 * If env isn't configured, all methods throw a clean error so the document
 * routes can return 503 rather than crashing.
 */

let _client: BlobServiceClient | null = null;
let _credential: StorageSharedKeyCredential | null = null;
let _accountName: string | null = null;

function parseConnString(cs: string) {
  // DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
  const map = Object.fromEntries(
    cs
      .split(";")
      .filter(Boolean)
      .map((kv) => {
        const eq = kv.indexOf("=");
        return [kv.slice(0, eq), kv.slice(eq + 1)] as [string, string];
      }),
  );
  return {
    accountName: map["AccountName"] ?? "",
    accountKey: map["AccountKey"] ?? "",
  };
}

function getServiceClient(): BlobServiceClient {
  if (!hasAzureBlob || !env.AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error("Azure Blob not configured (AZURE_STORAGE_CONNECTION_STRING missing)");
  }
  if (_client) return _client;
  const { accountName, accountKey } = parseConnString(env.AZURE_STORAGE_CONNECTION_STRING);
  _accountName = accountName;
  _credential = new StorageSharedKeyCredential(accountName, accountKey);
  _client = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING);
  return _client;
}

export function getDocsContainer(): ContainerClient {
  return getServiceClient().getContainerClient(env.AZURE_STORAGE_CONTAINER_DOCS);
}

/** Upload a file from a Buffer to Blob storage. Returns the blob path. */
export async function uploadBlob(
  storageKey: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  const container = getDocsContainer();
  const blob = container.getBlockBlobClient(storageKey);
  await blob.uploadData(data, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

/** Return a short-lived (15min) read SAS URL for a blob. */
export function downloadSasUrl(storageKey: string, filename?: string): string {
  getServiceClient(); // ensures _credential + _accountName are populated
  if (!_credential || !_accountName) {
    throw new Error("Blob credential not initialised");
  }
  const expiresOn = new Date(Date.now() + 15 * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: env.AZURE_STORAGE_CONTAINER_DOCS,
      blobName: storageKey,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: new Date(Date.now() - 60_000),
      expiresOn,
      contentDisposition: filename
        ? `attachment; filename="${filename.replace(/"/g, "")}"`
        : undefined,
    },
    _credential,
  );
  return `https://${_accountName}.blob.core.windows.net/${env.AZURE_STORAGE_CONTAINER_DOCS}/${encodeURIComponent(storageKey)}?${sas.toString()}`;
}

export async function deleteBlob(storageKey: string): Promise<void> {
  const container = getDocsContainer();
  await container.deleteBlob(storageKey, { deleteSnapshots: "include" });
}
