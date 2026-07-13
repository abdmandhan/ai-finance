import type { ExpenseStateType } from "@/graphs/expense.state";
import { emitProgress, EXPENSE_NODES, type ExpenseDeps } from "./shared";

/**
 * Attach the source receipt(s) to the created bank transaction (XERO-BANK-009).
 * Best-effort like the invoice equivalent: a failed attachment never voids the
 * transaction — it is reported in the summary instead.
 */
export function makeAttachExpenseFileNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.attach,
    node: async (state: ExpenseStateType) => {
      const attachments = state.attachments ?? [];
      if (
        !deps.fetchAttachment ||
        !state.bankTransactionId ||
        attachments.length === 0
      ) {
        return { _nextNode: EXPENSE_NODES.finalize };
      }

      emitProgress(
        deps,
        state.threadId,
        "attach_expense",
        "Attaching the receipt(s)...",
      );
      let failed = 0;
      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        for (const a of attachments) {
          try {
            const fetched = await deps.fetchAttachment(a.url, a.mimeType);
            if (!fetched) {
              failed++;
              continue;
            }
            await deps.xeroTool.attachToBankTransaction(
              auth,
              state.bankTransactionId,
              a.fileName,
              fetched.bytes,
              fetched.contentType,
            );
          } catch (err) {
            failed++;
            deps.logger.error(
              { err, fileName: a.fileName },
              "attach one receipt failed",
            );
          }
        }
      } catch (err) {
        failed = attachments.length;
        deps.logger.error({ err }, "attach-expense-file failed");
      }

      // The transaction exists either way; be precise about what didn't attach (XERO-ERR-011).
      if (failed > 0 && state.result) {
        return {
          result: {
            ...state.result,
            summary: `${state.result.summary} Note: ${failed} attachment(s) could not be uploaded — the transaction itself was recorded.`,
          },
          _nextNode: EXPENSE_NODES.finalize,
        };
      }
      return { _nextNode: EXPENSE_NODES.finalize };
    },
  };
}
