/**
 * Dev helper: publish a scheduling request to chat.inbound so you can exercise the
 * running service without the backend. Usage:
 *   pnpm seed:goal "Schedule a meeting with Sarah next week" [chatId]
 * Prints the chatId — reuse it with seed-response.ts to resume the paused thread.
 */
import { configUtils, loggerUtils } from "@/commons";
import { inboundMessageSchema } from "@/schemas";
import { KafkaJS } from "@confluentinc/kafka-javascript";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const text =
  process.argv[2] ?? "Schedule a 30 minute meeting with Sarah next week";
const chatId = process.argv[3] ?? `chat-${Date.now()}`;
// tenantId drives per-tenant Google auth (token endpoint). Override via arg or TENANT_ID.
const tenantId =
  process.argv[4] ??
  process.env.TENANT_ID ??
  "c3333333-3333-4333-b333-333333333333";

const message = inboundMessageSchema.parse({
  requestId: `req-${Date.now()}`,
  chatId,
  tenantId,
  createdBy: "seed-user",
  role: "human",
  provider: "tiger-scale",
  content: [{ type: "text", text }],
  timestamp: new Date().toISOString(),
});

const kafka = new KafkaJS.Kafka({ "bootstrap.servers": config.kafka.url });
const producer = kafka.producer();
await producer.connect();
await producer.send({
  topic: config.kafka.topics.inbound,
  messages: [{ key: chatId, value: JSON.stringify(message) }],
});
await producer.disconnect();

logger.info(
  { chatId, topic: config.kafka.topics.inbound },
  "Seeded goal to chat.inbound",
);
process.exit(0);
