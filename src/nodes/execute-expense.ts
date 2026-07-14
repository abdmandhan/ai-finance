import {
  applyLineDefaults,
  matchTaxRate,
  resolveOrgDefaults,
  taxRatePercentOf,
} from "@/commons";
import type { ExpenseStateType } from "@/graphs/expense.state";
import type { XeroLineItem } from "@/tools";
import { emitProgress, EXPENSE_NODES, type ExpenseDeps } from "./shared";

/**
 * The single write step, reached only through the approval gate. Applies the same
 * org account/tax defaults as invoice drafts so the transaction posts cleanly.
 */
export function makeExecuteExpenseNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.execute,
    node: async (state: ExpenseStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "execute_expense",
        "Recording in Xero...",
      );
      const auth = await deps.resolveXeroAuth(state.tenantId);

      try {
        if (state.kind === "transfer") {
          const transfer = await deps.xeroTool.createBankTransfer(auth, {
            FromBankAccount: { Code: state.resolvedFromAccount!.code },
            ToBankAccount: { Code: state.resolvedToAccount!.code },
            Amount: state.amount!,
            ...(state.resolvedDate ? { Date: state.resolvedDate } : {}),
          });
          const resultSummary = `Transferred ${state.amount} from ${state.resolvedFromAccount?.name} to ${state.resolvedToAccount?.name}.`;
          return {
            result: {
              status: "created" as const,
              transferId: transfer.BankTransferID,
              summary: resultSummary,
              completedApproval: {
                name: "xero_bank_transfer",
                provider: "xero",
                ref: transfer.BankTransferID,
                label: resultSummary,
              },
            },
            _nextNode: EXPENSE_NODES.finalize,
          };
        }

        const lines: XeroLineItem[] = (
          state.lineItems?.length
            ? state.lineItems
            : [
                {
                  description: state.reference ?? state.contactName ?? "Expense",
                  quantity: 1,
                  unitAmount: state.amount!,
                },
              ]
        ).map((li) => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: li.unitAmount,
        }));

        const [accounts, taxRates] = await Promise.all([
          deps.xeroTool.getAccounts(auth),
          deps.xeroTool.getTaxRates(auth),
        ]);
        const defaults = resolveOrgDefaults(
          accounts,
          taxRates,
          state.kind === "receive" ? "REVENUE" : "EXPENSE",
          deps.orgDefaults,
        );
        // Same receipt-GST override as invoice drafts: a shown rate beats a 0% default.
        let taxType = defaults.taxType;
        const wantPercent = state.taxRatePercent ?? 0;
        if (wantPercent > 0 && taxRatePercentOf(taxRates, taxType) === 0) {
          taxType = matchTaxRate(taxRates, wantPercent) ?? taxType;
        }
        applyLineDefaults(lines, { accountCode: defaults.accountCode, taxType });

        const [txn] = await deps.xeroTool.createBankTransactions(auth, [
          {
            Type: state.kind === "receive" ? "RECEIVE" : "SPEND",
            BankAccount: { Code: state.resolvedBankAccount!.code },
            ...(state.resolvedContactId
              ? { Contact: { ContactID: state.resolvedContactId } }
              : {}),
            LineItems: lines,
            LineAmountTypes: state.amountsAreTaxInclusive
              ? "Inclusive"
              : "Exclusive",
            ...(state.resolvedDate ? { Date: state.resolvedDate } : {}),
            ...(state.reference ? { Reference: state.reference } : {}),
          },
        ]);
        if (!txn?.BankTransactionID) {
          return {
            result: {
              status: "failed" as const,
              summary: "Xero did not return a bank transaction id.",
            },
            _nextNode: EXPENSE_NODES.finalize,
          };
        }
        const total = lines.reduce((s, l) => s + l.Quantity * l.UnitAmount, 0);
        const resultSummary = `Recorded ${state.kind === "receive" ? "receive" : "spend"}-money of ${total} against ${state.resolvedBankAccount?.name}.`;
        const completedName =
          state.kind === "receive" ? "xero_receive_money" : "xero_spend_money";
        return {
          bankTransactionId: txn.BankTransactionID,
          result: {
            status: "created" as const,
            bankTransactionId: txn.BankTransactionID,
            summary: resultSummary,
            completedApproval: {
              name: completedName,
              provider: "xero",
              ref: txn.BankTransactionID,
              label: resultSummary,
            },
          },
          _nextNode: EXPENSE_NODES.attach,
        };
      } catch (err) {
        deps.logger.error({ err }, "execute-expense failed");
        return {
          result: {
            status: "failed" as const,
            summary: `Xero rejected the operation: ${err instanceof Error ? err.message : String(err)}`,
          },
          _nextNode: EXPENSE_NODES.finalize,
        };
      }
    },
  };
}
