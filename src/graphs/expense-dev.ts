/**
 * Dev-only expense graph for the LangGraph CLI / Studio. Uses a StubXeroTool +
 * fake auth so it runs offline (resolve → approve → execute all in-memory).
 * No custom checkpointer (dev server manages persistence + interrupt resume).
 */
import { configUtils, loggerUtils } from "@/commons";
import { buildExpenseGraph } from "@/graphs/expense.graph";
import { createLlmService } from "@/services/llm.service";
import type { XeroAuth } from "@/services/xero-auth";
import { StubXeroTool } from "@/tools/xero.tool";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const fakeAuth: XeroAuth = {
  accessToken: "stub",
  xeroTenantId: "stub-tenant",
  apiBaseUrl: "https://api.xero.com/api.xro/2.0",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

export const graph = buildExpenseGraph({
  llmService: createLlmService(config.llm, logger),
  xeroTool: new StubXeroTool({
    contacts: [{ ContactID: "c-acme", Name: "Acme" }],
  }),
  resolveXeroAuth: async () => fakeAuth,
  orgDefaults: {
    taxType: config.xero.default_tax_type,
    expenseAccountCode: config.xero.default_expense_account_code,
    revenueAccountCode: config.xero.default_revenue_account_code,
  },
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, "progress"),
});
