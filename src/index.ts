import { configUtils, loggerUtils } from "@/commons";
import {
  buildAssistantGraph,
  buildInvoiceGraph,
  buildScheduleGraph,
} from "@/graphs";
import {
  createAssistantHandler,
  createCorrelationStore,
  createLegacyHandler,
} from "@/handlers";
import { checkpointerUtils } from "@/memory";
import {
  createAuditService,
  createFetchAttachment,
  createKafkaService,
  createLlmService,
  createPausedWorkflowCheck,
  createResolveAuth,
  createResolveEnablement,
  createResolveXeroAuth,
  createWorkflowRunner,
  type RunnableGraph,
  type Workflow,
} from "@/services";
import {
  createCalendarTool,
  createContactsTool,
  createMapsTool,
  createXeroTool,
} from "@/tools";

async function main(): Promise<void> {
  const config = configUtils.initConfig();
  const logger = loggerUtils.createLogger(config.log);

  const kafka = createKafkaService(config, logger);
  const audit = createAuditService(logger);
  const llmService = createLlmService(config.llm);
  const resolveEnablement = createResolveEnablement(
    config.agents.enablement_endpoint_base_url,
    logger,
  );
  const checkpointer = checkpointerUtils.createCheckpointer(
    config.database.url,
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
      calendarTool: createCalendarTool(logger),
      contactsTool: createContactsTool(logger),
      mapsTool: createMapsTool(config.calendar.maps_api_key, logger),
      resolveAuth: createResolveAuth(config.calendar.token_endpoint_base_url),
      defaultTimezone: config.calendar.default_timezone,
      schedulingPrefs: {
        bufferMinutes: config.calendar.buffer_minutes,
        workingHoursStart: config.calendar.working_hours_start,
        workingHoursEnd: config.calendar.working_hours_end,
      },
      logger,
      onProgress,
    },
    checkpointer,
  );

  const invoiceGraph = buildInvoiceGraph(
    {
      llmService,
      xeroTool: createXeroTool(logger),
      resolveXeroAuth: createResolveXeroAuth(
        config.xero.token_endpoint_base_url,
      ),
      orgDefaults: {
        taxType: config.xero.default_tax_type,
        expenseAccountCode: config.xero.default_expense_account_code,
        revenueAccountCode: config.xero.default_revenue_account_code,
      },
      fetchAttachment: createFetchAttachment(),
      logger,
      onProgress,
    },
    checkpointer,
  );

  const graphs: Record<Workflow, RunnableGraph> = {
    schedule: scheduleGraph as unknown as RunnableGraph,
    invoice: invoiceGraph as unknown as RunnableGraph,
  };
  const runWorkflow = createWorkflowRunner({ graphs, logger });
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

  await kafka.consume(config.kafka.topics.inbound, handler);

  logger.info(
    { assistant: config.assistant.enabled },
    "Tigeri graph service running",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await kafka.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
