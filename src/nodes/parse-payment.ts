import type { PaymentStateType } from "@/graphs/payment.state";
import { paymentPrompts } from "@/prompts";
import { paymentIntentSchema } from "@/schemas";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  PAYMENT_NODES,
  type PaymentDeps,
} from "./shared";

/**
 * Extract the payment/credit/void intent. The LLM extracts + flags missing info;
 * this node routes (clarify vs resolve-target vs fail). All validation against
 * actual Xero data happens deterministically in resolve-payment-target.
 */
export function makeParsePaymentNode(deps: PaymentDeps) {
  return {
    name: PAYMENT_NODES.parsePayment,
    node: async (state: PaymentStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "parse_payment",
        "Reading the payment request...",
      );

      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
      const messages = [
        new SystemMessage(paymentPrompts.parsePaymentPrompt(today)),
        new HumanMessage(state.userMessage),
      ];
      const extracted = await deps.llmService.extract(
        paymentIntentSchema,
        messages,
        "payment_intent",
      );
      deps.logger.info({ extracted }, "parse-payment result");

      if (extracted.action === "unsupported") {
        return {
          action: extracted.action,
          result: {
            status: "failed" as const,
            summary:
              "This does not look like a payment, credit note, or void request.",
          },
          _nextNode: PAYMENT_NODES.finalize,
        };
      }

      // Refunding remaining credit needs a credit-note payment API this service
      // does not call yet — explain the closest safe workflow instead of guessing.
      if (extracted.action === "refund_credit") {
        return {
          action: extracted.action,
          result: {
            status: "failed" as const,
            summary:
              "Refunding remaining credit isn't supported here yet. You can apply the credit to an open invoice instead, or record the refund directly in Xero.",
          },
          _nextNode: PAYMENT_NODES.finalize,
        };
      }

      const merged = {
        action: extracted.action,
        targetKind: extracted.targetKind ?? state.targetKind,
        invoiceRef: extracted.invoiceRef ?? state.invoiceRef,
        contactName: extracted.contactName ?? state.contactName,
        amount: extracted.amount ?? state.amount,
        date: extracted.date ?? state.date,
        bankAccountHint: extracted.bankAccountHint ?? state.bankAccountHint,
        reference: extracted.reference ?? state.reference,
        creditNoteLines: extracted.creditNoteLines ?? state.creditNoteLines,
        allocateToInvoiceRef:
          extracted.allocateToInvoiceRef ?? state.allocateToInvoiceRef,
      };

      // Minimum to even look anything up: some way to find the target document.
      const missingTarget =
        extracted.action === "create_credit_note"
          ? !merged.contactName
          : !merged.invoiceRef && !merged.contactName && !merged.date;

      if (
        missingTarget &&
        extracted.clarificationQuestion &&
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
      ) {
        return {
          ...merged,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: PAYMENT_NODES.askClarification,
        };
      }

      if (missingTarget) {
        return {
          ...merged,
          result: {
            status: "failed" as const,
            summary:
              "Not enough information to identify the document — no number, contact, or date was given.",
          },
          _nextNode: PAYMENT_NODES.finalize,
        };
      }

      return {
        ...merged,
        clarificationQuestion: null,
        _nextNode: PAYMENT_NODES.resolveTarget,
      };
    },
  };
}
