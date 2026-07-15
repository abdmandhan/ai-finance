import type { Config, ILogger } from "@/commons";
import type { ChatContent } from "@/schemas";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface UploadDocumentInput {
  tenantId: string;
  chatId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface IStorageService {
  uploadDocument(input: UploadDocumentInput): Promise<ChatContent>;
}

export class StorageConfigurationError extends Error {
  constructor(message = "PDF export storage is not configured.") {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

type S3ClientLike = Pick<S3Client, "send">;
type PresignFn = (
  client: S3ClientLike,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

export class DisabledStorageService implements IStorageService {
  async uploadDocument(): Promise<ChatContent> {
    throw new StorageConfigurationError();
  }
}

export function safeFileName(input: string | null | undefined): string {
  const raw = (input ?? "").trim() || "invoice.pdf";
  const base = raw
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._ -]+/, "");
  const withFallback = base || "invoice.pdf";
  const withPdf = /\.pdf$/i.test(withFallback)
    ? withFallback
    : `${withFallback}.pdf`;
  return withPdf.slice(0, 160);
}

function safePathSegment(input: string | null | undefined, fallback: string) {
  return (
    (input ?? "")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || fallback
  );
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function renderKey(
  template: string,
  input: UploadDocumentInput & { safeFileName: string },
) {
  return template
    .replaceAll("{tenantId}", safePathSegment(input.tenantId, "tenant"))
    .replaceAll("{chatId}", safePathSegment(input.chatId, "chat"))
    .replaceAll("{timestamp}", timestamp())
    .replaceAll("{fileName}", input.safeFileName)
    .replace(/^\/+/, "");
}

function s3ClientConfig(config: Config["storage"]): S3ClientConfig {
  return {
    region: config.region || "auto",
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.force_path_style,
    ...(config.access_key_id && config.secret_access_key
      ? {
          credentials: {
            accessKeyId: config.access_key_id,
            secretAccessKey: config.secret_access_key,
          },
        }
      : {}),
  };
}

export class S3StorageService implements IStorageService {
  constructor(
    private readonly config: Config["storage"],
    private readonly logger: ILogger,
    private readonly client: S3ClientLike = new S3Client(
      s3ClientConfig(config),
    ),
    private readonly presign: PresignFn = getSignedUrl as PresignFn,
  ) {}

  async uploadDocument(input: UploadDocumentInput): Promise<ChatContent> {
    if (!this.config.enabled || !this.config.bucket) {
      throw new StorageConfigurationError();
    }
    const fileName = safeFileName(input.fileName);
    const key = renderKey(this.config.key_template, {
      ...input,
      safeFileName: fileName,
    });
    const contentType = input.mimeType || "application/octet-stream";
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: contentType,
      }),
    );
    const url = await this.presign(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: this.config.presign_expiry_seconds },
    );
    this.logger.info(
      {
        bucket: this.config.bucket,
        key,
        fileName,
        byteLength: input.bytes.length,
      },
      "uploaded graph workflow document",
    );
    return {
      type: "document",
      mimeType: contentType,
      fileName,
      url,
      size: input.bytes.length,
    };
  }
}

export function createStorageService(
  config: Config["storage"],
  logger: ILogger,
): IStorageService {
  if (!config.enabled) return new DisabledStorageService();
  if (!config.bucket) {
    logger.warn(
      "storage.enabled=true but storage.bucket is empty; document uploads disabled",
    );
    return new DisabledStorageService();
  }
  return new S3StorageService(config, logger);
}
