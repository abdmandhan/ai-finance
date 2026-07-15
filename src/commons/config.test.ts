import { describe, expect, it } from "vitest";
import { configUtils } from "./config";

describe("config schema", () => {
  it("parses a minimal TOML-shaped object with full defaults", () => {
    const config = configUtils.configSchema.parse({ kafka: {} });

    expect(config.llm.small.model).toBe("anthropic:claude-haiku-4-5");
    expect(config.llm.medium.model).toBe(
      "anthropic:claude-sonnet-4-5-20250929",
    );
    expect(config.llm.api_key).toBe("");
    expect(config.redis.url).toBe("");
    expect(config.worker.enabled).toBe(false);
    expect(config.worker.concurrency).toBe(10);
    expect(config.worker.max_attempts).toBe(3);
    expect(config.assistant.publish_policy).toBe("always_publish");
    expect(config.storage).toEqual({
      enabled: false,
      bucket: "",
      region: "auto",
      endpoint: "",
      force_path_style: false,
      access_key_id: "",
      secret_access_key: "",
      key_template: "graph/outbound/{tenantId}/{chatId}/{timestamp}-{fileName}",
      presign_expiry_seconds: 86400,
    });
    expect(config.process_log).toEqual({
      enabled: false,
      store_db: true,
      include_payloads: true,
      retention_days: 14,
      max_payload_chars: 4000,
    });
    expect(config.kafka.topics.inbound_error).toBe("chat.inbound.error");
  });

  it("lets a tier override the shared llm url/api_key", () => {
    const config = configUtils.configSchema.parse({
      kafka: {},
      llm: {
        api_key: "shared-key",
        small: { model: "openai:gpt-4o-mini", api_key: "tier-key" },
      },
    });

    expect(config.llm.small.api_key).toBe("tier-key");
    expect(config.llm.small.model).toBe("openai:gpt-4o-mini");
    expect(config.llm.medium.api_key).toBe(""); // falls back to shared at resolve time
  });

  it("accepts workflow_only assistant publish policy", () => {
    const config = configUtils.configSchema.parse({
      kafka: {},
      assistant: { publish_policy: "workflow_only" },
    });

    expect(config.assistant.publish_policy).toBe("workflow_only");
  });

  it("rejects invalid assistant publish policy values", () => {
    expect(() =>
      configUtils.configSchema.parse({
        kafka: {},
        assistant: { publish_policy: "sometimes" },
      }),
    ).toThrow();
  });

  it("accepts full process log config", () => {
    const config = configUtils.configSchema.parse({
      kafka: {},
      process_log: {
        enabled: true,
        store_db: true,
        include_payloads: true,
        retention_days: 30,
        max_payload_chars: 1000,
      },
    });

    expect(config.process_log.enabled).toBe(true);
    expect(config.process_log.retention_days).toBe(30);
    expect(config.process_log.max_payload_chars).toBe(1000);
  });

  it("accepts full S3 storage config", () => {
    const config = configUtils.configSchema.parse({
      kafka: {},
      storage: {
        enabled: true,
        bucket: "graph-documents",
        region: "us-east-1",
        endpoint: "http://localhost:9000",
        force_path_style: true,
        access_key_id: "minio",
        secret_access_key: "secret",
        key_template: "pdfs/{tenantId}/{chatId}/{fileName}",
        presign_expiry_seconds: 3600,
      },
    });

    expect(config.storage.enabled).toBe(true);
    expect(config.storage.bucket).toBe("graph-documents");
    expect(config.storage.force_path_style).toBe(true);
    expect(config.storage.presign_expiry_seconds).toBe(3600);
  });

  it("rejects invalid storage presign expiry", () => {
    expect(() =>
      configUtils.configSchema.parse({
        kafka: {},
        storage: { presign_expiry_seconds: 0 },
      }),
    ).toThrow();
  });

  it("rejects invalid process log retention and payload limits", () => {
    expect(() =>
      configUtils.configSchema.parse({
        kafka: {},
        process_log: { retention_days: 0 },
      }),
    ).toThrow();
    expect(() =>
      configUtils.configSchema.parse({
        kafka: {},
        process_log: { max_payload_chars: 10 },
      }),
    ).toThrow();
  });
});
