import { bankAccountsOf, matchAccountByHint } from "@/commons";
import type { ExpenseStateType } from "@/graphs/expense.state";
import type { XeroAccount } from "@/tools";
import {
  emitProgress,
  EXPENSE_NODES,
  MAX_CLARIFY_ATTEMPTS,
  type ExpenseDeps,
} from "./shared";

/**
 * Deterministic bank-account (and contact) resolution. Rules in code: transfers
 * need two DIFFERENT accounts, bank accounts are never guessed when several
 * exist, and money received from a contact with open invoices asks whether it
 * should be an invoice payment instead (XERO-BANK-002). Nothing is written here.
 */
export function makeResolveBankAccountsNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.resolveAccounts,
    node: async (state: ExpenseStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "resolve_bank_accounts",
        "Resolving bank accounts...",
      );
      const auth = await deps.resolveXeroAuth(state.tenantId);
      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
      const banks = bankAccountsOf(await deps.xeroTool.getAccounts(auth));

      const clarify = (question: string) =>
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
          ? {
              clarificationQuestion: question,
              _nextNode: EXPENSE_NODES.askClarification,
            }
          : {
              result: { status: "failed" as const, summary: question },
              _nextNode: EXPENSE_NODES.finalize,
            };
      const fail = (summary: string) => ({
        result: { status: "failed" as const, summary },
        _nextNode: EXPENSE_NODES.finalize,
      });

      const bankList = banks.map((b) => b.Name).join(", ");
      const resolveBank = (
        hint: string | null | undefined,
        role: string,
      ): { account?: XeroAccount; ask?: string } => {
        if (hint) {
          const matches = matchAccountByHint(banks, hint);
          if (!matches.length)
            return {
              ask: `I couldn't find a bank account matching "${hint}". Available: ${bankList}. Which should I use${role ? ` as the ${role}` : ""}?`,
            };
          if (matches.length > 1)
            return {
              ask: `Several bank accounts match "${hint}": ${matches.map((b) => b.Name).join(", ")}. Which one${role ? ` as the ${role}` : ""}?`,
            };
          return { account: matches[0] };
        }
        if (banks.length === 1) return { account: banks[0] };
        return {
          ask: `Which bank account${role ? ` (${role})` : ""}? Available: ${bankList}.`,
        };
      };

      if (state.kind === "transfer") {
        if (state.amount == null)
          return clarify("How much should be transferred?");
        const from = resolveBank(state.fromAccountHint, "source");
        if (!from.account) return clarify(from.ask!);
        const to = resolveBank(state.toAccountHint, "destination");
        if (!to.account) return clarify(to.ask!);
        // A transfer needs two distinct accounts (XERO-BANK-004).
        if (from.account.Code === to.account.Code)
          return fail(
            `The source and destination are the same account (${from.account.Name}) — nothing to transfer.`,
          );
        return {
          resolvedFromAccount: { code: from.account.Code!, name: from.account.Name },
          resolvedToAccount: { code: to.account.Code!, name: to.account.Name },
          resolvedDate: state.date ?? today,
          _nextNode: EXPENSE_NODES.approval,
        };
      }

      // spend / receive
      const bank = resolveBank(state.bankAccountHint, "");
      if (!bank.account) return clarify(bank.ask!);

      let resolvedContactId: string | undefined;
      if (state.contactName) {
        const contacts = await deps.xeroTool.findContact(auth, state.contactName);
        if (contacts.length === 1) resolvedContactId = contacts[0].ContactID;
        // Money in from a contact with open invoices is probably an invoice payment —
        // ask rather than double-count revenue (XERO-BANK-002).
        if (state.kind === "receive" && contacts.length) {
          const open = await deps.xeroTool.getInvoices(auth, {
            contactId: contacts[0].ContactID,
            type: "ACCREC",
            statuses: ["AUTHORISED"],
            unpaidOnly: true,
          });
          if (open.length)
            return clarify(
              `${contacts[0].Name} has open invoice(s): ${open
                .slice(0, 5)
                .map((i) => `${i.InvoiceNumber} (${i.AmountDue} due)`)
                .join(", ")}. Should this be recorded as a payment against one of them, or as separate receive-money?`,
            );
        }
      }

      return {
        resolvedBankAccount: { code: bank.account.Code!, name: bank.account.Name },
        resolvedContactId,
        resolvedDate: state.date ?? today,
        _nextNode: EXPENSE_NODES.approval,
      };
    },
  };
}
