/**
 * Dev helper: publish a follow-up user reply to chat.inbound to resume a paused thread
 * (a clarification answer or an approval decision). The service correlates by chatId.
 * Usage:
 *   pnpm tsx src/scripts/seed-response.ts <chatId> --approve
 *   pnpm tsx src/scripts/seed-response.ts <chatId> --decline
 *   pnpm tsx src/scripts/seed-response.ts <chatId> --reply "with Sarah, next Tuesday"
 */
import { configUtils, loggerUtils } from '@/commons';
import { inboundMessageSchema } from '@/schemas';
import { KafkaJS } from '@confluentinc/kafka-javascript';

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const chatId = process.argv[2];
if (!chatId) {
  logger.error('Usage: seed-response.ts <chatId> [--approve | --decline | --reply "text"]');
  process.exit(1);
}

const flag = process.argv[3];
const text =
  flag === '--approve'
    ? 'yes'
    : flag === '--decline'
      ? 'no'
      : flag === '--reply'
        ? (process.argv[4] ?? '')
        : 'yes';

const message = inboundMessageSchema.parse({
  requestId: `req-${Date.now()}`,
  chatId,
  createdBy: 'seed-user',
  role: 'human',
  provider: 'tiger-scale',
  content: [{ type: 'text', text }],
  timestamp: new Date().toISOString(),
});

const kafka = new KafkaJS.Kafka({ 'bootstrap.servers': config.kafka.url });
const producer = kafka.producer();
await producer.connect();
await producer.send({
  topic: config.kafka.topics.inbound,
  messages: [{ key: chatId, value: JSON.stringify(message) }],
});
await producer.disconnect();

logger.info({ chatId, text, topic: config.kafka.topics.inbound }, 'Seeded reply to chat.inbound');
process.exit(0);
