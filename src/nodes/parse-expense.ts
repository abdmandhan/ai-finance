import type { ExpenseStateType } from "@/graphs/expense.state";
import { expensePrompts } from "@/prompts";
import { expenseIntentSchema } from "@/schemas";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  emitProgress,
  EXPENSE_NODES,
  MAX_CLARIFY_ATTEMPTS,
  type ExpenseDeps,
} from "./shared";

/**
 * Extract the spend/receive/transfer intent — multimodal like parse-invoice so a
 * vision model can read attached receipts. Routing only; validation lives in
 * resolve-bank-accounts.
 */
export function makeParseExpenseNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.parseExpense,
    node: async (state: ExpenseStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "parse_expense",
        "Reading the expense details...",
      );

      const imageParts: Array<{
        type: "image_url";
        image_url: { url: string };
      }> = [];
      const attachments = state.attachments ?? [];
      if (deps.fetchAttachment && attachments.length) {
        const images = attachments
          .filter((a) => a.mimeType?.startsWith("image/"))
          .slice(0, 5);
        for (const a of images) {
          const fetched = await deps.fetchAttachment(a.url, a.mimeType);
          if (fetched?.dataUrl) {
            imageParts.push({
              type: "image_url",
              image_url: { url: fetched.dataUrl },
            });
          }
        }
      }

      const humanContent = imageParts.length
        ? [{ type: "text" as const, text: state.userMessage }, ...imageParts]
        : state.userMessage;
      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
      const messages = [
        new SystemMessage(expensePrompts.parseExpensePrompt(today)),
        new HumanMessage({ content: humanContent }),
      ];
      const extracted = await deps.llmService.extract(
        expenseIntentSchema,
        messages,
        "expense_intent",
      );
      deps.logger.info({ extracted }, "parse-expense result");

      if (extracted.kind === "unsupported") {
        return {
          kind: extracted.kind,
          result: {
            status: "failed" as const,
            summary:
              "This doesn't look like a spend/receive-money or transfer request. Bills payable later go through the bill workflow instead.",
          },
          _nextNode: EXPENSE_NODES.finalize,
        };
      }

      const merged = {
        kind: extracted.kind,
        contactName: extracted.contactName ?? state.contactName,
        lineItems: extracted.lineItems.length
          ? extracted.lineItems
          : state.lineItems,
        amount: extracted.amount ?? state.amount,
        currencyCode: extracted.currencyCode ?? state.currencyCode,
        date: extracted.date ?? state.date,
        reference: extracted.reference ?? state.reference,
        bankAccountHint: extracted.bankAccountHint ?? state.bankAccountHint,
        fromAccountHint: extracted.fromAccountHint ?? state.fromAccountHint,
        toAccountHint: extracted.toAccountHint ?? state.toAccountHint,
        taxRatePercent: extracted.taxRatePercent ?? state.taxRatePercent,
        taxAmount: extracted.taxAmount ?? state.taxAmount,
        amountsAreTaxInclusive:
          extracted.amountsAreTaxInclusive ?? state.amountsAreTaxInclusive,
      };

      // The one thing we can't proceed without: some amount (lines or total).
      const missingAmount =
        (!merged.lineItems || merged.lineItems.length === 0) &&
        merged.amount == null;

      if (
        missingAmount &&
        extracted.clarificationQuestion &&
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
      ) {
        return {
          ...merged,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: EXPENSE_NODES.askClarification,
        };
      }

      if (missingAmount) {
        return {
          ...merged,
          result: {
            status: "failed" as const,
            summary: "No amount was given, so nothing was recorded.",
          },
          _nextNode: EXPENSE_NODES.finalize,
        };
      }

      return {
        ...merged,
        clarificationQuestion: null,
        _nextNode: EXPENSE_NODES.resolveAccounts,
      };
    },
  };
}
