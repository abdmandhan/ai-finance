import { readFileSync } from 'fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

const configSchema = z.object({
  log: z
    .object({
      format: z.enum(['pretty', 'json']).default('pretty'),
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    })
    .default({ format: 'pretty', level: 'info' }),
  llm: z.object({
    provider: z.enum(['anthropic', 'openai']).default('anthropic'),
    api_key: z.string().min(1, 'llm.api_key is required'),
    model: z.string().default('claude-sonnet-4-5-20250929'),
  }),
  database: z
    .object({
      // Empty url → in-memory checkpointer fallback (see memory/checkpointer.ts).
      url: z.string().default(''),
    })
    .default({ url: '' }),
  calendar: z
    .object({
      // Backend endpoint that mints per-tenant Google access tokens
      // (GET {base}/api/v1/internal/calendar/access?tenantId=).
      token_endpoint_base_url: z.string().default('http://localhost:8080'),
      // IANA timezone that anchors relative-time resolution ("tomorrow at 10")
      // when a message states no timezone.
      default_timezone: z.string().default('Asia/Jakarta'),
      // Google Maps API key (Distance Matrix) for travel-time. Empty → travel checks off.
      maps_api_key: z.string().default(''),
      // Minutes of buffer kept before/after each meeting when finding free slots.
      buffer_minutes: z.number().default(15),
      working_hours_start: z.number().default(9),
      working_hours_end: z.number().default(18),
    })
    .default({
      token_endpoint_base_url: 'http://localhost:8080',
      default_timezone: 'Asia/Jakarta',
      maps_api_key: '',
      buffer_minutes: 15,
      working_hours_start: 9,
      working_hours_end: 18,
    }),
  kafka: z.object({
    url: z.string().default('localhost:9092'),
    group_id: z.string().default('tigeri-graph'),
    sasl_enable: z.boolean().default(false),
    sasl_username: z.string().default(''),
    sasl_password: z.string().default(''),
    sasl_mechanism: z.string().default('PLAIN'),
    sasl_protocol: z.string().default('SASL_SSL'),
    // The three real topics — the entire App<->Agent contract. This service takes
    // the Agent's role: consume inbound, reply on outbound, stream progress on events.
    topics: z
      .object({
        inbound: z.string().default('chat.inbound'),
        outbound: z.string().default('chat.outbound'),
        events: z.string().default('chat.events'),
      })
      .default({
        inbound: 'chat.inbound',
        outbound: 'chat.outbound',
        events: 'chat.events',
      }),
  }),
});

export type Config = z.infer<typeof configSchema>;

function initConfig(path = process.env.CONFIG_PATH ?? 'config.toml'): Config {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseToml(raw);
  return configSchema.parse(parsed);
}

export const configUtils = {
  initConfig,
  configSchema,
};
