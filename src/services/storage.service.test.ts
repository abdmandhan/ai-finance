import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  DisabledStorageService,
  S3StorageService,
  StorageConfigurationError,
  safeFileName,
} from "./storage.service";

const storageConfig = {
  enabled: true,
  bucket: "graph-documents",
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  force_path_style: true,
  access_key_id: "minio",
  secret_access_key: "secret",
  key_template: "graph/outbound/{tenantId}/{chatId}/{timestamp}-{fileName}",
  presign_expiry_seconds: 3600,
};

describe("safeFileName", () => {
  it("removes path separators and guarantees a pdf suffix", () => {
    expect(safeFileName("../INV 100")).toBe("INV 100.pdf");
    expect(safeFileName("folder/INV:100.pdf")).toBe("folder-INV_100.pdf");
  });
});

describe("DisabledStorageService", () => {
  it("fails with the user-facing storage configuration error", async () => {
    await expect(
      new DisabledStorageService().uploadDocument({
        tenantId: "tenant-1",
        chatId: "chat-1",
        fileName: "invoice.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(StorageConfigurationError);
  });
});

describe("S3StorageService", () => {
  it("uploads bytes and returns a presigned document content block", async () => {
    const send = vi.fn(async () => ({}));
    const presign = vi.fn(async () => "https://files.example/invoice.pdf");
    const service = new S3StorageService(
      storageConfig,
      pino({ level: "silent" }),
      { send } as any,
      presign,
    );

    const doc = await service.uploadDocument({
      tenantId: "tenant 1",
      chatId: "chat/1",
      fileName: "../INV-1.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
    });

    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0][0] as { input: unknown }).input).toMatchObject({
      Bucket: "graph-documents",
      ContentType: "application/pdf",
    });
    expect(presign).toHaveBeenCalledWith(
      { send },
      expect.objectContaining({
        input: expect.objectContaining({ Bucket: "graph-documents" }),
      }),
      { expiresIn: 3600 },
    );
    expect(doc).toEqual({
      type: "document",
      mimeType: "application/pdf",
      fileName: "INV-1.pdf",
      url: "https://files.example/invoice.pdf",
      size: 4,
    });
  });
});
