import { readFileSync } from "fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const llmTierSchema = (defaultModel: string) =>
  z
    .object({
      url: z.string().default(""),
      api_key: z.string().default(""),
      model: z.string().default(defaultModel),
    })
    .default({ url: "", api_key: "", model: defaultModel });

const configSchema = z.object({
  log: z
    .object({
      format: z.enum(["pretty", "json"]).default("pretty"),
      level: z
        .enum(["trace", "debug", "info", "warn", "error", "fatal"])
        .default("info"),
    })
    .default({ format: "pretty", level: "info" }),
  llm: z
    .object({
      // Shared defaults; each size tier may override. `model` is "provider:model"
      // (initChatModel format). `url` is an OpenAI-compatible base URL — leave
      // empty for hosted providers (Anthropic rejects a custom baseURL).
      url: z.string().default(""),
      api_key: z.string().default(""),
      small: llmTierSchema("anthropic:claude-haiku-4-5"),
      medium: llmTierSchema("anthropic:claude-sonnet-4-5-20250929"),
      large: llmTierSchema("anthropic:claude-sonnet-4-5-20250929"),
    })
    .prefault({}),
  redis: z
    .object({
      // Empty url → all Redis features off: checkpointer falls back to
      // Postgres/MemorySaver and the queue pipeline is unavailable.
      url: z.string().default(""),
      password: z.string().default(""),
    })
    .default({ url: "", password: "" }),
  worker: z
    .object({
      // Queue-backed consumption (requires redis.url). false → direct
      // Kafka → handler (no dedup/retry/concurrency control).
      enabled: z.boolean().default(false),
      keep_completed: z.number().default(100),
      keep_failed: z.number().default(300),
      concurrency: z.number().default(10),
      // Pause Kafka intake while waiting+active+delayed >= this. Keep small:
      // the wait blocks the consumer poll loop, which must stay under
      // librdkafka max.poll.interval.ms (5 min) or the consumer is kicked.
      max_backlog: z.number().default(10),
      max_attempts: z.number().default(3),
      job_timeout_ms: z.number().default(300000),
    })
    .prefault({}),
  database: z
    .object({
      // Empty url → in-memory checkpointer fallback (see memory/checkpointer.ts).
      url: z.string().default(""),
    })
    .default({ url: "" }),
  calendar: z
    .object({
      // Backend endpoint that mints per-tenant Google access tokens
      // (GET {base}/api/v1/internal/calendar/access?tenantId=).
      token_endpoint_base_url: z.string().default("http://localhost:8080"),
      // IANA timezone that anchors relative-time resolution ("tomorrow at 10")
      // when a message states no timezone.
      default_timezone: z.string().default("Asia/Jakarta"),
      // Google Maps API key (Distance Matrix) for travel-time. Empty → travel checks off.
      maps_api_key: z.string().default(""),
      // Minutes of buffer kept before/after each meeting when finding free slots.
      buffer_minutes: z.number().default(15),
      working_hours_start: z.number().default(9),
      working_hours_end: z.number().default(18),
    })
    .default({
      token_endpoint_base_url: "http://localhost:8080",
      default_timezone: "Asia/Jakarta",
      maps_api_key: "",
      buffer_minutes: 15,
      working_hours_start: 9,
      working_hours_end: 18,
    }),
  xero: z
    .object({
      // Backend endpoint that mints per-tenant Xero access tokens
      // (GET {base}/api/v1/internal/xero/access?tenantId=).
      token_endpoint_base_url: z.string().default("http://localhost:8080"),
      // Optional org-default overrides for authorise-ready drafts (else auto-picked from Xero).
      default_tax_type: z.string().default(""),
      default_expense_account_code: z.string().default(""),
      default_revenue_account_code: z.string().default(""),
    })
    .default({
      token_endpoint_base_url: "http://localhost:8080",
      default_tax_type: "",
      default_expense_account_code: "",
      default_revenue_account_code: "",
    }),
  assistant: z
    .object({
      // Hybrid-assistant handler (conversational agent + workflows-as-tools).
      // false → rollback to the legacy classify() router (see handlers/legacy.handler.ts).
      enabled: z.boolean().default(true),
      // Cap on prior conversation messages replayed to the model each turn.
      max_history_messages: z.number().default(30),
    })
    .default({ enabled: true, max_history_messages: 30 }),
  agents: z
    .object({
      // Backend endpoint that resolves per-tenant/per-member agent enablement, used to gate a
      // disabled/paused agent before running its workflow.
      // GET {base}/api/v1/internal/agents/enablement?chatId= | ?tenantId=
      //   -> { agents: { expense, invoicing, scheduling: boolean } }
      enablement_endpoint_base_url: z.string().default("http://localhost:8080"),
    })
    .default({ enablement_endpoint_base_url: "http://localhost:8080" }),
  kafka: z.object({
    url: z.string().default("localhost:9092"),
    group_id: z.string().default("tigeri-graph"),
    sasl_enable: z.boolean().default(false),
    sasl_username: z.string().default(""),
    sasl_password: z.string().default(""),
    sasl_mechanism: z.string().default("PLAIN"),
    sasl_protocol: z.string().default("SASL_SSL"),
    // The three real topics — the entire App<->Agent contract. This service takes
    // the Agent's role: consume inbound, reply on outbound, stream progress on events.
    topics: z
      .object({
        inbound: z.string().default("chat.inbound"),
        outbound: z.string().default("chat.outbound"),
        events: z.string().default("chat.events"),
        // Dead-letter topic: { error, data } for inbound messages whose
        // handler failed after retries.
        inbound_error: z.string().default("chat.inbound.error"),
      })
      .default({
        inbound: "chat.inbound",
        outbound: "chat.outbound",
        events: "chat.events",
        inbound_error: "chat.inbound.error",
      }),
  }),
});

export type Config = z.infer<typeof configSchema>;

function initConfig(path = process.env.CONFIG_PATH ?? "config.toml"): Config {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseToml(raw);
  return configSchema.parse(parsed);
}

export const configUtils = {
  initConfig,
  configSchema,
};
