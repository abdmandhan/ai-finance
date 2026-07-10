/**
 * Download an attachment (presigned URL) into bytes, with a size cap — ported from Agent's
 * `xero-client.ts` fetchBytes. For images it also returns a base64 data URL so the bytes can be
 * passed inline to a vision model (the model provider can't reach internal MinIO URLs).
 */

export interface FetchedAttachment {
  bytes: Uint8Array;
  contentType: string;
  /** Set only for image/* — `data:<mime>;base64,<...>` for a vision message. */
  dataUrl?: string;
}

export type FetchAttachment = (
  url: string,
  mimeType?: string,
) => Promise<FetchedAttachment | null>;

export function createFetchAttachment(maxMb = 10): FetchAttachment {
  return async function fetchAttachment(url, mimeType) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET attachment ${res.status}`);
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxMb * 1024 * 1024) {
        throw new Error(`attachment exceeds ${maxMb}MB`);
      }
      const bytes = new Uint8Array(ab);
      const contentType = mimeType || res.headers.get("content-type") || "application/octet-stream";
      const dataUrl = contentType.startsWith("image/")
        ? `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`
        : undefined;
      return { bytes, contentType, dataUrl };
    } catch {
      return null;
    }
  };
}
