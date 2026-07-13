import { bankAccountsOf, matchAccountByHint } from "@/commons";
import type { PaymentStateType } from "@/graphs/payment.state";
import type { XeroInvoiceDetail } from "@/tools";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  PAYMENT_NODES,
  type PaymentDeps,
} from "./shared";

/**
 * Deterministic resolution of the payment target against real Xero data — the
 * rules live in code, not the LLM: the document must be AUTHORISED with a balance,
 * payments never over-apply, ambiguity always asks, and nothing is ever written here.
 */
export function makeResolvePaymentTargetNode(deps: PaymentDeps) {
  return {
    name: PAYMENT_NODES.resolveTarget,
    node: async (state: PaymentStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "resolve_payment_target",
        "Looking up the document in Xero...",
      );
      const auth = await deps.resolveXeroAuth(state.tenantId);
      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

      // Ask when we still can; fail with the same message once attempts run out.
      const clarify = (question: string) =>
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
          ? { clarificationQuestion: question, _nextNode: PAYMENT_NODES.askClarification }
          : {
              result: { status: "failed" as const, summary: question },
              _nextNode: PAYMENT_NODES.finalize,
            };
      const fail = (summary: string) => ({
        result: { status: "failed" as const, summary },
        _nextNode: PAYMENT_NODES.finalize,
      });

      const describe = (inv: XeroInvoiceDetail) =>
        `${inv.InvoiceNumber ?? inv.InvoiceID} (${inv.Contact?.Name ?? "unknown"}, due ${inv.AmountDue ?? 0})`;

      const findTargetInvoice = async (opts: { openOnly: boolean }) => {
        if (state.invoiceRef) {
          return deps.xeroTool.getInvoices(auth, {
            invoiceNumber: state.invoiceRef,
          });
        }
        if (state.contactName) {
          const contacts = await deps.xeroTool.findContact(
            auth,
            state.contactName,
          );
          if (!contacts.length) return [];
          return deps.xeroTool.getInvoices(auth, {
            contactId: contacts[0].ContactID,
            ...(opts.openOnly
              ? { statuses: ["AUTHORISED"], unpaidOnly: true }
              : {}),
            ...(state.targetKind
              ? { type: state.targetKind === "invoice" ? "ACCREC" as const : "ACCPAY" as const }
              : {}),
          });
        }
        return [];
      };

      if (state.action === "apply_payment") {
        const candidates = await findTargetInvoice({ openOnly: false });
        if (!candidates.length)
          return clarify(
            `I couldn't find ${state.invoiceRef ?? `an open document for ${state.contactName}`} in Xero. Which invoice or bill should the payment go to?`,
          );

        const open = candidates.filter(
          (i) => i.Status === "AUTHORISED" && (i.AmountDue ?? 0) > 0,
        );
        if (!open.length) {
          const only = candidates[0];
          if (only.Status === "DRAFT" || only.Status === "SUBMITTED")
            return fail(
              `${describe(only)} is still a ${only.Status?.toLowerCase()} — Xero can only record payments against approved documents. Approve it first.`,
            );
          return fail(
            `${describe(only)} has no outstanding balance — it looks already paid.`,
          );
        }
        if (open.length > 1)
          return clarify(
            `Several open documents match: ${open.slice(0, 5).map(describe).join("; ")}. Which one should be paid?`,
          );

        const target = open[0];
        const due = target.AmountDue ?? 0;
        // Never over-apply (XERO-PAY-002).
        if (state.amount != null && state.amount > due)
          return clarify(
            `That's ${state.amount} against ${describe(target)}, which only has ${due} outstanding. Should I record ${due} instead, or handle the rest as an overpayment in Xero?`,
          );

        // Resolve the bank account — from the hint, or the sole bank account; never guessed.
        const banks = bankAccountsOf(await deps.xeroTool.getAccounts(auth));
        let bank = banks.length === 1 ? banks[0] : undefined;
        if (state.bankAccountHint) {
          const matches = matchAccountByHint(banks, state.bankAccountHint);
          if (!matches.length)
            return clarify(
              `I couldn't find a bank account matching "${state.bankAccountHint}". Available: ${banks.map((b) => b.Name).join(", ")}. Which should I use?`,
            );
          if (matches.length > 1)
            return clarify(
              `Several bank accounts match "${state.bankAccountHint}": ${matches.map((b) => b.Name).join(", ")}. Which one?`,
            );
          bank = matches[0];
        }
        if (!bank?.Code)
          return clarify(
            `Which bank account was this paid from? Available: ${banks.map((b) => b.Name).join(", ")}.`,
          );

        return {
          resolvedInvoice: {
            id: target.InvoiceID,
            number: target.InvoiceNumber,
            type: target.Type,
            status: target.Status,
            amountDue: due,
            contactName: target.Contact?.Name,
          },
          resolvedBankAccount: { code: bank.Code, name: bank.Name },
          resolvedAmount: state.amount ?? due,
          resolvedDate: state.date ?? today,
          _nextNode: PAYMENT_NODES.approval,
        };
      }

      if (state.action === "void_invoice") {
        const candidates = await findTargetInvoice({ openOnly: false });
        if (!candidates.length)
          return clarify(
            `I couldn't find ${state.invoiceRef ?? "that document"} in Xero. Which invoice or bill should be voided?`,
          );
        if (candidates.length > 1)
          return clarify(
            `Several documents match: ${candidates.slice(0, 5).map(describe).join("; ")}. Which one should be voided?`,
          );
        const target = candidates[0];
        if (target.Status === "VOIDED")
          return fail(`${describe(target)} is already voided.`);
        // Xero cannot void paid documents — point at the valid correction path instead.
        if (target.Status === "PAID" || (target.AmountPaid ?? 0) > 0)
          return fail(
            `${describe(target)} has payments recorded, so Xero can't void it. Reverse the payment first, or issue a credit note to correct it.`,
          );
        return {
          resolvedInvoice: {
            id: target.InvoiceID,
            number: target.InvoiceNumber,
            type: target.Type,
            status: target.Status,
            amountDue: target.AmountDue,
            contactName: target.Contact?.Name,
          },
          _nextNode: PAYMENT_NODES.approval,
        };
      }

      if (state.action === "reverse_payment") {
        const window = state.date
          ? { dateFrom: state.date, dateTo: state.date }
          : {};
        const payments = await deps.xeroTool.getPayments(auth, {
          ...window,
          ...(state.reference ? { reference: state.reference } : {}),
        });
        const matches = payments.filter(
          (p) => state.amount == null || p.Amount === state.amount,
        );
        if (!matches.length)
          return clarify(
            `I couldn't find a matching payment${state.date ? ` on ${state.date}` : ""}. What date or amount was it?`,
          );
        if (matches.length > 1)
          return clarify(
            `Several payments match: ${matches
              .slice(0, 5)
              .map(
                (p) =>
                  `${p.Amount} on ${p.Date} against ${p.Invoice?.InvoiceNumber ?? "?"}`,
              )
              .join("; ")}. Which one should be reversed?`,
          );
        const payment = matches[0];
        return {
          resolvedPaymentId: payment.PaymentID,
          resolvedAmount: payment.Amount,
          resolvedDate: payment.Date,
          resolvedInvoice: payment.Invoice?.InvoiceID
            ? {
                id: payment.Invoice.InvoiceID,
                number: payment.Invoice.InvoiceNumber,
              }
            : undefined,
          _nextNode: PAYMENT_NODES.approval,
        };
      }

      // create_credit_note
      const contacts = await deps.xeroTool.findContact(
        auth,
        state.contactName ?? "",
      );
      if (!contacts.length)
        return clarify(
          `I couldn't find a contact matching "${state.contactName}" in Xero. Who is the credit note for?`,
        );
      if (contacts.length > 1)
        return clarify(
          `Several contacts match "${state.contactName}": ${contacts
            .slice(0, 5)
            .map((c) => c.Name)
            .join(", ")}. Which one?`,
        );

      const lines =
        state.creditNoteLines?.length
          ? state.creditNoteLines
          : state.amount != null
            ? [
                {
                  description: state.reference ?? "Credit",
                  quantity: 1,
                  unitAmount: state.amount,
                },
              ]
            : null;
      if (!lines)
        return clarify("What amount (or line items) should the credit note be for?");

      let resolvedAllocationInvoice;
      if (state.allocateToInvoiceRef) {
        const hits = await deps.xeroTool.getInvoices(auth, {
          invoiceNumber: state.allocateToInvoiceRef,
        });
        const open = hits.find(
          (i) => i.Status === "AUTHORISED" && (i.AmountDue ?? 0) > 0,
        );
        if (!open)
          return clarify(
            `I couldn't find an open document ${state.allocateToInvoiceRef} to apply the credit to. Should I create the credit note without allocating it?`,
          );
        resolvedAllocationInvoice = {
          id: open.InvoiceID,
          number: open.InvoiceNumber,
          amountDue: open.AmountDue,
        };
      }

      return {
        resolvedContactId: contacts[0].ContactID,
        contactName: contacts[0].Name,
        creditNoteLines: lines,
        resolvedAmount: lines.reduce((s, l) => s + l.quantity * l.unitAmount, 0),
        resolvedDate: state.date ?? today,
        resolvedAllocationInvoice,
        _nextNode: PAYMENT_NODES.approval,
      };
    },
  };
}
