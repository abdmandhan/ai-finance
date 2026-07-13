import type { ExpenseStateType } from "@/graphs/expense.state";
import { interrupt } from "@langchain/langgraph";
import {
  EXPENSE_NODES,
  type ExpenseDeps,
  type InterruptPayload,
  type ResumeInput,
} from "./shared";

/**
 * Human-approval gate BEFORE the write — bank transactions and transfers take
 * effect immediately in Xero, so nothing is created until the user approves.
 */
export function makeExpenseApprovalNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.approval,
    node: async (state: ExpenseStateType) => {
      const total =
        state.lineItems?.length
          ? state.lineItems.reduce((s, l) => s + l.quantity * l.unitAmount, 0)
          : (state.amount ?? 0);

      let message: string;
      let name: string;
      let label: string;
      if (state.kind === "transfer") {
        name = "xero_bank_transfer";
        label = `transfer ${state.amount} ${state.resolvedFromAccount?.name} → ${state.resolvedToAccount?.name}`;
        message =
          `Transfer ${state.amount} from ${state.resolvedFromAccount?.name} to ` +
          `${state.resolvedToAccount?.name} on ${state.resolvedDate}. ` +
          "Reply 'approve' to record it.";
      } else if (state.kind === "receive") {
        name = "xero_receive_money";
        label = `receive ${total}${state.contactName ? ` from ${state.contactName}` : ""}`;
        message =
          `Record ${total} received${state.contactName ? ` from ${state.contactName}` : ""} ` +
          `into ${state.resolvedBankAccount?.name} on ${state.resolvedDate}. ` +
          "Reply 'approve' to record it.";
      } else {
        name = "xero_spend_money";
        label = `spend ${total}${state.contactName ? ` at ${state.contactName}` : ""}`;
        message =
          `Record a spend-money transaction of ${total}` +
          `${state.contactName ? ` to ${state.contactName}` : ""} from ` +
          `${state.resolvedBankAccount?.name} on ${state.resolvedDate}. ` +
          "Reply 'approve' to record it.";
      }

      const payload: InterruptPayload = {
        kind: "approval",
        message,
        approval: {
          name,
          provider: "xero",
          items: [{ ref: state.resolvedBankAccount?.code ?? state.resolvedFromAccount?.code ?? "", label }],
        },
      };
      const decision = interrupt<InterruptPayload, ResumeInput>(payload);
      const approved = decision.approved === true;
      deps.logger.info({ approved, kind: state.kind }, "expense approval decision");

      if (!approved) {
        return {
          approved: false,
          result: {
            status: "rejected" as const,
            summary: "Cancelled — nothing was recorded in Xero.",
          },
          _nextNode: EXPENSE_NODES.finalize,
        };
      }
      return { approved: true, _nextNode: EXPENSE_NODES.execute };
    },
  };
}
