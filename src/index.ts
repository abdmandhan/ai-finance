import { configUtils, loggerUtils } from "@/commons";
import {
  buildAssistantGraph,
  buildExpenseGraph,
  buildInvoiceGraph,
  buildPaymentGraph,
  buildReportGraph,
  buildScheduleGraph,
} from "@/graphs";
import {
  createAssistantHandler,
  createCorrelationStore,
  createErrorPublishingHandler,
  createLegacyHandler,
} from "@/handlers";
import { checkpointerUtils, FallbackCheckpointer } from "@/memory";
import {
  createAuditService,
  createCacheService,
  createFetchAttachment,
  createKafkaService,
  createLlmService,
  createLlmPricingService,
  createPausedWorkflowCheck,
  createProcessLogService,
  createQueueService,
  createResolveAuth,
  createResolveEnablement,
  createResolveXeroAuth,
  createWorkflowRunner,
  type ICacheService,
  type RunnableGraph,
  type Workflow,
} from "@/services";
import { createInboundFanout, createInboundWorker } from "@/workers";
import {
  createCalendarTool,
  createContactsTool,
  createMapsTool,
  createPreferencesTool,
  createXeroTool,
} from "@/tools";

async function main(): Promise<void> {
  const config = configUtils.initConfig();
  const logger = loggerUtils.createLogger(config.log);
  const processLog = createProcessLogService(config, logger);
  const stopProcessLogRetention = processLog.startRetention();
  const llmPricing = createLlmPricingService(config.database.url, logger);

  const kafka = createKafkaService(config, logger);
  const audit = createAuditService(logger);
  const llmService = createLlmService(
    config.llm,
    logger,
    processLog,
    llmPricing,
  );
  const resolveEnablement = createResolveEnablement(
    config.agents.enablement_endpoint_base_url,
    logger,
  );
  const checkpointer = await checkpointerUtils.createCheckpointer(
    config,
    logger,
  );

  const onProgress = (
    chatId: string,
    event: Parameters<typeof kafka.publishEvent>[1],
  ) => {
    kafka
      .publishEvent(chatId, event)
      .catch((err) => logger.error({ err }, "publishEvent failed"));
  };

  const scheduleGraph = buildScheduleGraph(
    {
      llmService,
      calendarTool: createCalendarTool(logger, processLog),
      contactsTool: createContactsTool(logger),
      mapsTool: createMapsTool(config.calendar.maps_api_key, logger),
      resolveAuth: createResolveAuth(config.calendar.token_endpoint_base_url),
      defaultTimezone: config.calendar.default_timezone,
      schedulingPrefs: {
        bufferMinutes: config.calendar.buffer_minutes,
        workingHoursStart: config.calendar.working_hours_start,
        workingHoursEnd: config.calendar.working_hours_end,
      },
      preferencesTool: createPreferencesTool(config.database.url, logger),
      logger,
      onProgress,
      processLog,
    },
    checkpointer,
  );

  // The Xero write/read workflows share one XeroTool (per-tenant reference cache)
  // and one auth resolver.
  const xeroTool = createXeroTool(logger, processLog);
  const resolveXeroAuth = createResolveXeroAuth(
    config.xero.token_endpoint_base_url,
  );

  const invoiceGraph = buildInvoiceGraph(
    {
      llmService,
      xeroTool,
      resolveXeroAuth,
      orgDefaults: {
        taxType: config.xero.default_tax_type,
        expenseAccountCode: config.xero.default_expense_account_code,
        revenueAccountCode: config.xero.default_revenue_account_code,
      },
      fetchAttachment: createFetchAttachment(),
      logger,
      onProgress,
      processLog,
    },
    checkpointer,
  );

  const paymentGraph = buildPaymentGraph(
    {
      llmService,
      xeroTool,
      resolveXeroAuth,
      logger,
      onProgress,
      processLog,
    },
    checkpointer,
  );

  const expenseGraph = buildExpenseGraph(
    {
      llmService,
      xeroTool,
      resolveXeroAuth,
      orgDefaults: {
        taxType: config.xero.default_tax_type,
        expenseAccountCode: config.xero.default_expense_account_code,
        revenueAccountCode: config.xero.default_revenue_account_code,
      },
      fetchAttachment: createFetchAttachment(),
      logger,
      onProgress,
      processLog,
    },
    checkpointer,
  );

  const reportGraph = buildReportGraph(
    { llmService, xeroTool, resolveXeroAuth, logger, onProgress, processLog },
    checkpointer,
  );

  const graphs: Record<Workflow, RunnableGraph> = {
    schedule: scheduleGraph as unknown as RunnableGraph,
    invoice: invoiceGraph as unknown as RunnableGraph,
    payment: paymentGraph as unknown as RunnableGraph,
    expense: expenseGraph as unknown as RunnableGraph,
    report: reportGraph as unknown as RunnableGraph,
  };
  const runWorkflow = createWorkflowRunner({ graphs, logger, processLog });
  const pausedWorkflow = createPausedWorkflowCheck(graphs);

  // The main assistant: owns the conversation (thread `assistant:<chatId>`) and
  // calls the strict workflow graphs above as tools via `runWorkflow`.
  const assistantGraph = buildAssistantGraph(
    {
      llmService,
      runWorkflow,
      audit,
      defaultTimezone: config.calendar.default_timezone,
      maxHistoryMessages: config.assistant.max_history_messages,
      logger,
      onProgress,
      processLog,
    },
    checkpointer,
  ) as unknown as RunnableGraph;

  await kafka.connect();

  const correlations = createCorrelationStore();
  const handler = config.assistant.enabled
    ? createAssistantHandler({
        kafka,
        logger,
        audit,
        resolveEnablement,
        runWorkflow,
        pausedWorkflow,
        assistantGraph,
        correlations,
        publishPolicy: config.assistant.publish_policy,
        processLog,
      })
    : createLegacyHandler({
        kafka,
        logger,
        audit,
        llmService,
        resolveEnablement,
        graphs,
        pausedWorkflow,
        correlations,
      });

  // Queue-backed path: Kafka -> dedup -> Redis groupmq -> N workers -> handler.
  // Direct path (worker.enabled=false): Kafka -> retry+dead-letter wrapper -> handler.
  let cache: ICacheService | null = null;
  let fanout: ReturnType<typeof createInboundFanout> | null = null;
  let worker: ReturnType<typeof createInboundWorker> | null = null;

  if (config.worker.enabled) {
    if (!config.redis.url) {
      throw new Error(
        "worker.enabled requires redis.url (groupmq queue lives in Redis)",
      );
    }
    cache = createCacheService(config, logger);
    const queueService = createQueueService(config, cache, logger);
    worker = createInboundWorker({
      queueService,
      kafka,
      logger,
      config,
      handle: handler,
    });
    fanout = createInboundFanout({ queueService, cache, logger, config });
    await worker.start();
    await kafka.consume(
      config.kafka.topics.inbound,
      createErrorPublishingHandler({
        inner: fanout.handler,
        kafka,
        logger,
        // Enqueue is cheap and idempotent (dedup key) — one retry is enough.
        attempts: 2,
      }),
    );
  } else {
    await kafka.consume(
      config.kafka.topics.inbound,
      createErrorPublishingHandler({ inner: handler, kafka, logger }),
    );
  }

  logger.info(
    { assistant: config.assistant.enabled, worker: config.worker.enabled },
    "Tigeri graph service running",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    // Order matters: stop intake, drain in-flight jobs, then flush checkpoints
    // written by those jobs, then drop the Redis connection.
    fanout?.stop();
    await kafka.disconnect();
    await worker?.stop();
    if (checkpointer instanceof FallbackCheckpointer) {
      await checkpointer.flushToPostgres();
    }
    stopProcessLogRetention();
    await processLog.close();
    await llmPricing.close();
    await cache?.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
