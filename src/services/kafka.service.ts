import type { Config, ILogger } from "@/commons";
import type { OutboundMessage, ProgressEvent } from "@/schemas";
import { KafkaJS } from "@confluentinc/kafka-javascript";

export type MessageHandler = (raw: string) => Promise<void>;

/**
 * Kafka seam for the graph service. Takes the Agent's role on the bus: consumes
 * `chat.inbound` and produces `chat.outbound` (AI replies / approvals) and
 * `chat.events` (progress). The message key is always `chatId`.
 */
export interface IKafkaService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Subscribe to a topic and dispatch each raw message value to `handler`. */
  consume(topic: string, handler: MessageHandler): Promise<void>;
  /** Publish an AI reply / clarification / approval request to chat.outbound. */
  publishOutbound(message: OutboundMessage): Promise<void>;
  /** Publish an ephemeral progress event to chat.events, keyed by chatId. */
  publishEvent(chatId: string, event: ProgressEvent): Promise<void>;
  /** Dead-letter an inbound message whose handler failed after retries. */
  publishInboundError(
    chatId: string,
    payload: { error: unknown; data: unknown },
  ): Promise<void>;
}

/** Errors don't JSON.stringify — flatten to a plain shape first. */
export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

export class KafkaService implements IKafkaService {
  private readonly kafka: KafkaJS.Kafka;
  private producer: ReturnType<KafkaJS.Kafka["producer"]> | null = null;
  private consumer: ReturnType<KafkaJS.Kafka["consumer"]> | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: ILogger,
  ) {
    this.kafka = new KafkaJS.Kafka({ "bootstrap.servers": config.kafka.url });
  }

  /** Flat librdkafka connection settings shared by producer and consumer. */
  private baseConfig(): Record<string, string> {
    const cfg: Record<string, string> = {
      "bootstrap.servers": this.config.kafka.url,
    };
    if (this.config.kafka.sasl_enable) {
      cfg["security.protocol"] = this.config.kafka.sasl_protocol;
      cfg["sasl.mechanism"] = this.config.kafka.sasl_mechanism;
      cfg["sasl.username"] = this.config.kafka.sasl_username;
      cfg["sasl.password"] = this.config.kafka.sasl_password;
    }
    return cfg;
  }

  async connect(): Promise<void> {
    this.producer = this.kafka.producer(
      this.baseConfig() as KafkaJS.ProducerConstructorConfig,
    );
    await this.producer.connect();

    this.consumer = this.kafka.consumer({
      ...this.baseConfig(),
      "group.id": this.config.kafka.group_id,
      "auto.offset.reset": "earliest",
    } as KafkaJS.ConsumerConstructorConfig);
    await this.consumer.connect();
    this.logger.info({ broker: this.config.kafka.url }, "Kafka connected");
  }

  async consume(topic: string, handler: MessageHandler): Promise<void> {
    if (!this.consumer)
      throw new Error("Kafka not connected — call connect() first");
    await this.consumer.subscribe({ topic });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const value = message.value?.toString();
        if (!value) return;
        try {
          await handler(value);
        } catch (err) {
          this.logger.error({ err, topic }, "Message handler failed");
        }
      },
    });
  }

  private async send(topic: string, key: string, event: object): Promise<void> {
    if (!this.producer)
      throw new Error("Kafka not connected — call connect() first");
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(event) }],
    });
  }

  publishOutbound(message: OutboundMessage): Promise<void> {
    return this.send(
      this.config.kafka.topics.outbound,
      message.chatId,
      message,
    );
  }

  publishEvent(chatId: string, event: ProgressEvent): Promise<void> {
    return this.send(this.config.kafka.topics.events, chatId, event);
  }

  publishInboundError(
    chatId: string,
    payload: { error: unknown; data: unknown },
  ): Promise<void> {
    return this.send(this.config.kafka.topics.inbound_error, chatId, {
      error: serializeError(payload.error),
      data: payload.data,
    });
  }

  async disconnect(): Promise<void> {
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
    this.consumer = null;
    this.producer = null;
    this.logger.info("Kafka disconnected");
  }
}

export function createKafkaService(
  config: Config,
  logger: ILogger,
): IKafkaService {
  return new KafkaService(config, logger);
}
