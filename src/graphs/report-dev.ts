/**
 * Dev-only report graph for the LangGraph CLI / Studio. Uses a StubXeroTool with
 * a default P&L + seeded invoices and fake auth, so it runs offline and read-only.
 */
import { configUtils, loggerUtils } from "@/commons";
import { buildReportGraph } from "@/graphs/report.graph";
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

export const graph = buildReportGraph({
  llmService: createLlmService(config.llm, logger),
  xeroTool: new StubXeroTool({
    contacts: [{ ContactID: "c-acme", Name: "Acme" }],
    invoices: [
      {
        InvoiceID: "i-200",
        InvoiceNumber: "INV-200",
        Type: "ACCREC",
        Status: "AUTHORISED",
        Contact: { ContactID: "c-acme", Name: "Acme" },
        Date: "2026-06-01",
        DueDate: "2026-06-30",
        Total: 1000,
        AmountDue: 1000,
      },
    ],
  }),
  resolveXeroAuth: async () => fakeAuth,
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, "progress"),
});
