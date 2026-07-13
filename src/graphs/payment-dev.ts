/**
 * Dev-only payment graph for the LangGraph CLI / Studio. Uses a StubXeroTool with
 * seeded open invoices + fake auth so it runs offline (resolve → approve → execute
 * all in-memory). No custom checkpointer (dev server manages persistence + resume).
 */
import { configUtils, loggerUtils } from "@/commons";
import { buildPaymentGraph } from "@/graphs/payment.graph";
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

export const graph = buildPaymentGraph({
  llmService: createLlmService(config.llm, logger),
  xeroTool: new StubXeroTool({
    contacts: [{ ContactID: "c-acme", Name: "Acme" }],
    invoices: [
      {
        InvoiceID: "i-100",
        InvoiceNumber: "INV-100",
        Type: "ACCPAY",
        Status: "AUTHORISED",
        Contact: { ContactID: "c-acme", Name: "Acme" },
        Date: "2026-06-15",
        DueDate: "2026-07-01",
        Total: 500,
        AmountDue: 500,
      },
    ],
  }),
  resolveXeroAuth: async () => fakeAuth,
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, "progress"),
});
