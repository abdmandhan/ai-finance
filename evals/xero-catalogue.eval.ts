/**
 * Live-LLM eval runner for the Xero test catalogue (XERO-TEST-CASE-PLAN.md).
 * Run: `pnpm eval`            — whole suite (needs [llm] configured in config.toml)
 *      `pnpm eval -- -t XERO-PAY`  — one catalogue category
 * The whole suite is skipped when no LLM is configured; multimodal cases are
 * skipped when their image fixture is absent (see evals/fixtures/receipts/).
 */
import { describe, it } from "vitest";
import { aiBehaviourCases } from "./cases/ai-behaviour.cases";
import { contactCases } from "./cases/contacts.cases";
import { docIngestionCases } from "./cases/doc-ingestion.cases";
import { expenseCases } from "./cases/expenses.cases";
import { invoiceCases } from "./cases/invoices.cases";
import { paymentCases } from "./cases/payments.cases";
import { reportCases } from "./cases/reports.cases";
import type { EvalCase } from "./cases/types";
import {
  assertCase,
  buildEvalEnv,
  fixtureExists,
  hasLlmConfigured,
  runCase,
} from "./harness";

const CATEGORIES: Record<string, EvalCase[]> = {
  "Document ingestion (multimodal)": docIngestionCases,
  "Supplier bills & customer invoices": invoiceCases,
  "Payments, credit notes & voids": paymentCases,
  "Expenses & bank transactions": expenseCases,
  "Reports & financial questions": reportCases,
  "Contacts": contactCases,
  "AI conversational behaviour & safety": aiBehaviourCases,
};

const llmReady = hasLlmConfigured();

describe.skipIf(!llmReady)("Xero catalogue evals", () => {
  for (const [category, cases] of Object.entries(CATEGORIES)) {
    describe(category, () => {
      for (const c of cases) {
        const missingFixture = (c.attachments ?? []).some(
          (a) => !fixtureExists(a.fixture),
        );
        it.skipIf(missingFixture)(`${c.id}: ${c.title}`, async () => {
          const env = buildEvalEnv(c.seed);
          const res = await runCase(env, c);
          assertCase(res, c);
        });
      }
    });
  }
});

if (!llmReady) {
  // Surface WHY everything skipped.
  console.warn(
    "[evals] skipped: no LLM configured — set [llm] api_key (or url) in config.toml",
  );
}
