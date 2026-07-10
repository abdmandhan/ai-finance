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
